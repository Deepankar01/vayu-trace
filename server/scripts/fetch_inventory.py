"""Download the EDGAR v8.1 PM2.5 sector grids and build the domain cache.

Usage (from server/): uv run python scripts/fetch_inventory.py [--if-missing]

With --if-missing it does nothing when every NetCDF file the loader needs is already present.

Fetches the per-sector 2022 annual NetCDF zips named in vayu.emissions.inventory into
`server/data/inventory/`, extracts only the expected .nc member (nothing is executed), prints
sizes and SHA-256 digests, then builds the cached domain grids and prints India totals.
"""
import hashlib
import sys
import io
import zipfile

import httpx

from vayu import config
from vayu.emissions import inventory


def fetch(code: str, folder) -> None:
    target = folder / inventory._file_name(code)
    if target.is_file():
        print(f"{target.name}: already present")
        return
    resp = httpx.get(inventory.zip_url(code), timeout=300, follow_redirects=True)
    resp.raise_for_status()
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        data = zf.read(target.name)  # exact member name; no path from the archive is used
    target.write_bytes(data)
    print(f"{target.name}: {len(data) / 1e6:.1f} MB, sha256 {hashlib.sha256(data).hexdigest()}")


def missing_files() -> list[str]:
    """NetCDF files the loader needs that are not in `data_dir()/inventory`."""
    folder = config.data_dir() / "inventory"
    return [name for name in inventory.source_files() if not (folder / name).is_file()]


def main() -> None:
    if "--if-missing" in sys.argv[1:] and not missing_files():
        print("EDGAR inventory present")
        return
    folder = config.data_dir() / "inventory"
    folder.mkdir(parents=True, exist_ok=True)
    for codes in inventory.EDGAR_SECTORS.values():
        for code in codes:
            fetch(code, folder)
    grids = inventory.sector_grids()
    inventory.inventory_emissions()
    for sector, grid in grids.items():
        total_kt = grid.sum() * inventory.HOURS_PER_YEAR / 1e6
        print(f"{sector}: domain total {total_kt:.1f} kt/yr (before dropping non-India cells)")


if __name__ == "__main__":
    main()
