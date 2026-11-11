"""Baseline anthropogenic PM2.5 from EDGAR v8.1: one constant grid per (sector, region) tag.

EDGAR annual files hold tonnes PM2.5 per cell per year on a global 0.1 degree grid. They are
cropped to the model domain, converted to kg per hour at the annual mean rate, summed over the
EDGAR sectors that make up each model sector and split by region. Cells whose centre is outside
India are dropped. EDGAR has no road or construction dust field and the India-specific inventory
that has one is access-restricted, so the `dust` grids are zero and flagged (see docs/data-notes.md).
"""
import hashlib
import json
from pathlib import Path

import netCDF4
import numpy as np

from vayu import config
from vayu.domain import (
    CELL,
    LAT_MIN,
    LON_MIN,
    NX,
    NY,
    REGIONS,
    SECTORS,
    cell_area_m2,
    india_mask,
    region_mask,
)
from vayu.emissions import Emissions

YEAR = 2022
RELEASE = "v8.1_FT2022_AP"
BASE_URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/v81_FT2022_AP_new/PM2.5"
SOURCE = "EDGAR v8.1 air pollutants (JRC), PM2.5, 0.1 degree annual sector grids"
LICENCE = "CC BY 4.0"

# Model sector -> EDGAR sector codes: TRO road transport; ENE power; IND manufacturing combustion;
# REF_TRF refineries and transformation; NMM non-metallic minerals (cement, lime, glass, bricks);
# IRO iron and steel; NFE non-ferrous metals; CHE chemical processes; RCO energy for buildings.
# Industrial process sectors are included so industry covers directly emitted process PM2.5.
EDGAR_SECTORS = {
    "vehicles": ("TRO",),
    "industry": ("ENE", "IND", "REF_TRF", "NMM", "IRO", "NFE", "CHE"),
    "residential": ("RCO",),
}
# No road/construction dust field is available: EDGAR has none, and the India inventory with a
# wind-blown road dust sector (Zenodo 10.5281/zenodo.7885103) is restricted. Never proxied.
DUST_AVAILABLE = False

HOURS_PER_YEAR = 365 * 24  # 2022 is not a leap year
_TONNES = {"Tonnes", "tonnes", "t", "Mg"}  # case-sensitive: "mg" is milligram, not megagram
_FLUX = {"kgm-2s-1", "kg/m2/s", "kgm^-2s^-1"}


class InventoryNotFound(FileNotFoundError):
    """The EDGAR files have not been downloaded."""


def _file_name(code: str) -> str:
    return f"{RELEASE}_PM2.5_{YEAR}_{code}_emi.nc"


def zip_name(code: str) -> str:
    return f"{RELEASE}_PM2.5_{YEAR}_{code}_emi_nc.zip"


def zip_url(code: str) -> str:
    return f"{BASE_URL}/{code}/emi_nc/{zip_name(code)}"


def source_files() -> list[str]:
    """NetCDF file names the loader needs inside `data_dir()/inventory`."""
    return [_file_name(c) for codes in EDGAR_SECTORS.values() for c in codes]


def _inventory_dir() -> Path:
    return config.data_dir() / "inventory"


def _cache_path() -> Path:
    return _inventory_dir() / f"pm25_edgar_{RELEASE}_{YEAR}_domain.npz"


def _axis_index(coord: np.ndarray, lo: float, n: int, name: str) -> tuple[np.ndarray, np.ndarray]:
    """File positions and domain indices of the coordinates inside the domain, centres checked."""
    pos = np.flatnonzero((coord >= lo) & (coord <= lo + n * CELL))
    idx = np.rint((coord[pos] - lo) / CELL - 0.5).astype(int)
    centres = lo + (idx + 0.5) * CELL
    if idx.size and (np.abs(coord[pos] - centres).max() > 1e-6 or idx.min() < 0 or idx.max() >= n):
        raise ValueError(f"{name} coordinates are not aligned with the model cell centres")
    if np.unique(idx).size != n:
        raise ValueError(f"file does not cover the model domain in {name}")
    return pos, idx


def read_grid(path: Path) -> np.ndarray:
    """(NY, NX) kg PM2.5 per hour at the annual mean rate, from one EDGAR NetCDF file.

    Handles tonnes per cell per year and kg m-2 s-1 files, either latitude order. NaN
    (no emission recorded) becomes 0.
    """
    with netCDF4.Dataset(path) as ds:
        lat, lon = np.asarray(ds["lat"][:], dtype=float), np.asarray(ds["lon"][:], dtype=float)
        names = [n for n, v in ds.variables.items() if v.dimensions == ("lat", "lon")]
        if len(names) != 1:
            raise ValueError(f"{path.name}: expected one (lat, lon) variable, found {names}")
        var = ds[names[0]]
        raw_units = str(getattr(var, "units", ""))
        is_tonnes = raw_units in _TONNES
        if not is_tonnes and raw_units.replace(" ", "").lower() not in _FLUX:
            raise ValueError(f"{path.name}: unsupported units {raw_units!r}")
        jy, iy = _axis_index(lat, LAT_MIN, NY, "lat")
        jx, ix = _axis_index(lon, LON_MIN, NX, "lon")
        block = np.ma.filled(var[jy.min() : jy.max() + 1, jx.min() : jx.max() + 1], np.nan)
    block = np.nan_to_num(block[np.ix_(jy - jy.min(), jx - jx.min())].astype(np.float64))
    out = np.zeros((NY, NX))
    out[np.ix_(iy, ix)] = block
    if is_tonnes:
        return out * 1000.0 / HOURS_PER_YEAR
    return out * cell_area_m2()[:, None] * 3600.0


def _require_files() -> None:
    folder = _inventory_dir()
    missing = [n for n in source_files() if not (folder / n).is_file()]
    if missing:
        raise InventoryNotFound(
            f"EDGAR inventory files missing in {folder}: {', '.join(missing)}. "
            "Run `uv run python scripts/fetch_inventory.py` from the server directory."
        )


def sector_grids() -> dict[str, np.ndarray]:
    """Domain grids (kg/h, all cells) for vehicles, industry and residential from the files."""
    _require_files()
    folder = _inventory_dir()
    return {
        sector: sum(read_grid(folder / _file_name(code)) for code in codes)
        for sector, codes in EDGAR_SECTORS.items()
    }


def split_by_region(grids: dict[str, np.ndarray]) -> Emissions:
    """One constant grid per `{sector}_{region}` tag; cells outside India are dropped.

    `grids` holds a domain grid per sector in EDGAR_SECTORS; `dust` is zero (not available).
    """
    land, regions = india_mask(), region_mask()
    em = Emissions()
    for sector in SECTORS:
        grid = grids.get(sector, np.zeros((NY, NX)))
        for i, region in enumerate(REGIONS):
            em.set_constant(f"{sector}_{region}", np.where(land & (regions == i), grid, 0.0))
    return em


def _cache_key() -> str:
    """Hash of everything the cached grids depend on: sector mapping, conversion, domain grid and
    each source file's size and modification time."""
    folder = _inventory_dir()
    stats = [(n, (folder / n).stat().st_size, (folder / n).stat().st_mtime_ns) for n in source_files()]
    spec = [EDGAR_SECTORS, HOURS_PER_YEAR, (NY, NX, LAT_MIN, LON_MIN, CELL), stats]
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()


def inventory_emissions() -> Emissions:
    """The 24 baseline tags in kg PM2.5 per hour, from the cached .npz.

    The cache is rebuilt whenever its key (see `_cache_key`) no longer matches. The source files
    must be present even when a cache exists, since the key cannot be verified without them.
    """
    _require_files()
    key, cache = _cache_key(), _cache_path()
    grids = None
    if cache.is_file():
        with np.load(cache) as z:
            if "key" in z.files and str(z["key"]) == key and set(EDGAR_SECTORS) <= set(z.files):
                grids = {s: z[s] for s in EDGAR_SECTORS}
    if grids is None:
        grids = sector_grids()
        tmp = cache.with_name(cache.name + ".tmp.npz")
        np.savez_compressed(tmp, key=np.array(key), **grids)
        tmp.replace(cache)
    return split_by_region(grids)


def inventory_notes() -> dict:
    return {"source": SOURCE, "year": YEAR, "dust_available": DUST_AVAILABLE, "licence": LICENCE}
