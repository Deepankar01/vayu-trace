"""Download the EDGAR v8.1 PM2.5 and PM10 sector grids and build the domain cache.

Usage (from server/): uv run python scripts/fetch_inventory.py [--if-missing]

With --if-missing it does nothing when every NetCDF file the loader needs is already present
and matches its SHA-256 digest.

Fetches the per-sector 2022 annual NetCDF zips named in vayu.emissions.inventory into
`server/data/inventory/`, extracts only the expected .nc member (nothing is executed), checks it
against the digest in SHA256 (the same table as docs/data-notes.md), writes it under a temporary
name and renames it into place, then builds the cached domain grids and prints India totals.
"""
import hashlib
import io
import sys
import uuid
import zipfile
from pathlib import Path

import httpx

from vayu import config
from vayu.emissions import inventory

# SHA-256 of each extracted NetCDF file; keep in step with the table in docs/data-notes.md.
SHA256 = {
    "TRO": "17c8b96437d388f27d7cb9cf5838488bb0f09d0277711725904780dd06c37e70",
    "ENE": "500c4b861fe8e7e68520e5aabd297b8d2f34af55444e8b35ae35e5e004bbc239",
    "IND": "99e58266bbe6bef8870c028d47b6a493c9f852b05cc1abca7bce299cd5f3f58c",
    "REF_TRF": "488ace7936a6c7c70fea4452454dd55103dab663b0aa25045382b3d13c7a1837",
    "RCO": "a14d209f08c9c8563dbf8364f3a3a8202e95d7f8944f0050d31b11280ea60d64",
    "NMM": "3e0a263669ff68c7b890dc33adedfd6ee9e63fb1fd8ad76b30a18a6b243f1505",
    "IRO": "8dc2028998d8b25682ebaa46283abfa4397f89f9759a9271a6c4d73e8302baab",
    "NFE": "4c0ea258e5b88b74cb065b164976552d9e9753d5c432102f7f9630f51ee2a1cc",
    "CHE": "c33a6cfb8945f043590c93c2e46187d105abc8a393127f5edbd1adae4252c77b",
}
SHA256_PM10 = {  # PM10 files, same sector codes
    "TRO": "c8565093cf9c5fd79e56a405d5f69345296cd85bd92ccba13d2ecf1aca39b485",
    "ENE": "ebe098cc3276f0c14370a6c7e185680c89fc0831cf3d726d0ff93e1d072e86db",
    "IND": "bc655220654df7377267a13acbf03128e40cf041b2acdb4374b0b8e9faa10aed",
    "REF_TRF": "6e3c59a7a8dc8b7d3daaa63bc60268113d219ff97ea943f72f837d2d4977d992",
    "RCO": "68de9a4602afc5a4ed680c2fbdeb5c2025dbc12879b139471d86a92ab3f96980",
    "NMM": "f2566302a36695dfac7976f70df1b281a2b11d8fc6b69334a72e52db2f2dad8c",
    "IRO": "e3df37c56e95be2cede3d5bac21836f84662aade466285e5b693483e353fcf17",
    "NFE": "383f953ce698d9ff452d1cfd60d4011e05cf027f590cb402188a9cd56f159fd9",
    "CHE": "b24827e8b7b0cc393692ebde8d3e045f70b2d92e4aea611fe66d685684dbd1df",
}


def _codes() -> list[tuple[str, str]]:
    """(EDGAR sector code, pollutant) of every file the loader needs."""
    return [(code, p) for p in inventory.POLLUTANTS
            for codes in inventory.EDGAR_SECTORS.values() for code in codes]


def _sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def _digest(code: str, pollutant: str) -> str:
    return (SHA256 if pollutant == "PM2.5" else SHA256_PM10)[code]


def is_valid(code: str, folder: Path, pollutant: str = "PM2.5") -> bool:
    """The file for `code` is present and matches its digest."""
    path = folder / inventory._file_name(code, pollutant)
    return path.is_file() and _sha256_file(path) == _digest(code, pollutant)


def fetch(code: str, folder: Path, pollutant: str = "PM2.5") -> None:
    target = folder / inventory._file_name(code, pollutant)
    if is_valid(code, folder, pollutant):
        print(f"{target.name}: already present, digest OK")
        return
    resp = httpx.get(inventory.zip_url(code, pollutant), timeout=300, follow_redirects=True)
    if resp.status_code != 200:
        raise SystemExit(f"{code}: download failed with HTTP {resp.status_code}")
    with zipfile.ZipFile(io.BytesIO(resp.content)) as zf:
        data = zf.read(target.name)  # exact member name; no path from the archive is used
    digest = hashlib.sha256(data).hexdigest()
    if digest != _digest(code, pollutant):
        raise SystemExit(f"{target.name}: SHA-256 {digest} does not match the expected "
                         f"{_digest(code, pollutant)}; not saved")
    tmp = target.with_name(f"{target.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_bytes(data)
    tmp.replace(target)
    print(f"{target.name}: {len(data) / 1e6:.1f} MB, sha256 {digest}")


def missing_files() -> list[str]:
    """NetCDF files the loader needs that are absent from `data_dir()/inventory` or fail their
    digest."""
    folder = config.data_dir() / "inventory"
    return [inventory._file_name(code, p) for code, p in _codes()
            if not is_valid(code, folder, p)]


def main() -> None:
    if "--if-missing" in sys.argv[1:] and not missing_files():
        print("EDGAR inventory present, digests OK")
        return
    folder = config.data_dir() / "inventory"
    folder.mkdir(parents=True, exist_ok=True)
    for code, pollutant in _codes():
        fetch(code, folder, pollutant)
    grids = inventory.all_grids()
    inventory.inventory_emissions()
    for sector, grid in grids.items():
        total_kt = grid.sum() * inventory.HOURS_PER_YEAR / 1e6
        print(f"{sector}: domain total {total_kt:.1f} kt/yr (before dropping non-India cells)")


if __name__ == "__main__":
    main()
