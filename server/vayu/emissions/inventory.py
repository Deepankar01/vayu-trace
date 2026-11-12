"""Baseline anthropogenic PM from EDGAR v8.1: one constant grid per (size, sector, region) tag.

EDGAR annual files hold tonnes of PM2.5 (or PM10) per cell per year on a global 0.1 degree grid.
They are cropped to the model domain, converted to kg per hour at the annual mean rate, summed
over the EDGAR sectors that make up each model sector and split by region. Cells whose centre is
outside India are dropped. Fine tags carry PM2.5; `coarse_*` tags carry the 2.5-10 um part,
PM10 minus PM2.5 cell by cell (never negative).

Dust is an ESTIMATE, not data. EDGAR has no road or construction dust field and the India
inventory that has one is access-restricted, so the `dust` sector takes national totals for road
dust and construction from TERI's 2016 inventory (constants.py) and spreads them over India in
proportion to EDGAR road-transport PM2.5 (see `dust_grids` and docs/data-notes.md).
"""
import hashlib
import json
import uuid
from pathlib import Path

import netCDF4
import numpy as np

from vayu import config
from vayu import constants as C
from vayu.domain import (
    CELL,
    COARSE_PREFIX,
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
from vayu.errors import SetupError

YEAR = 2022
RELEASE = "v8.1_FT2022_AP"
BASE_URL = "https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/v81_FT2022_AP_new"
POLLUTANTS = ("PM2.5", "PM10")
SOURCE = "EDGAR v8.1 air pollutants (JRC), PM2.5 and PM10, 0.1 degree annual sector grids"
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
# No gridded road/construction dust field is available: EDGAR has none, and the India inventory
# with a wind-blown road dust sector (Zenodo 10.5281/zenodo.7885103) is restricted. The dust
# sector is therefore an estimate (see `dust_grids`), flagged as such wherever it is shown.
DUST_AVAILABLE = True
DUST_ESTIMATED = True
DUST_SOURCE = ("Estimate: TERI 2016 national road dust and construction totals, spread by EDGAR "
               "road-transport emissions; not gridded data")

HOURS_PER_YEAR = 365 * 24  # 2022 is not a leap year
_TONNES = {"Tonnes", "tonnes", "t", "Mg"}  # case-sensitive: "mg" is milligram, not megagram
_FLUX = {"kgm-2s-1", "kg/m2/s", "kgm^-2s^-1"}


class InventoryNotFound(SetupError):
    """The EDGAR files have not been downloaded."""


def _file_name(code: str, pollutant: str = "PM2.5") -> str:
    return f"{RELEASE}_{pollutant}_{YEAR}_{code}_emi.nc"


def zip_name(code: str, pollutant: str = "PM2.5") -> str:
    return f"{RELEASE}_{pollutant}_{YEAR}_{code}_emi_nc.zip"


def zip_url(code: str, pollutant: str = "PM2.5") -> str:
    return f"{BASE_URL}/{pollutant}/{code}/emi_nc/{zip_name(code, pollutant)}"


def source_files() -> list[str]:
    """NetCDF file names the loader needs inside `data_dir()/inventory`."""
    return [_file_name(c, p) for p in POLLUTANTS for codes in EDGAR_SECTORS.values() for c in codes]


def _inventory_dir() -> Path:
    return config.data_dir() / "inventory"


def _cache_path() -> Path:
    return _inventory_dir() / f"pm_edgar_{RELEASE}_{YEAR}_domain.npz"


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
    """(NY, NX) kg per hour at the annual mean rate, from one EDGAR NetCDF file.

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
            f"Emission inventory not found (missing: {', '.join(missing)}). Run `make setup` "
            "(or `uv run python scripts/fetch_inventory.py` from the server directory)."
        )


def sector_grids(pollutant: str = "PM2.5") -> dict[str, np.ndarray]:
    """Domain grids (kg/h, all cells) of `pollutant` for vehicles, industry and residential."""
    _require_files()
    folder = _inventory_dir()
    return {
        sector: sum(read_grid(folder / _file_name(code, pollutant)) for code in codes)
        for sector, codes in EDGAR_SECTORS.items()
    }


def coarse_grids(pm25: dict[str, np.ndarray], pm10: dict[str, np.ndarray]) -> dict[str, np.ndarray]:
    """`coarse_{sector}` grids: PM10 minus PM2.5 per cell, floored at 0 (a cell where EDGAR's
    PM10 is below its PM2.5 has no coarse emission)."""
    return {COARSE_PREFIX + s: np.maximum(pm10[s] - pm25[s], 0.0) for s in pm25}


def dust_grids(proxy: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(fine, coarse) kg/h grids of the ESTIMATED road and construction dust.

    The national totals (constants.py, TERI 2016: road dust plus construction) are spread over
    cells inside India in proportion to `proxy` (the EDGAR road-transport PM2.5 grid), at a
    constant rate through the year. Fine = the PM2.5 totals; coarse = PM10 minus PM2.5. The
    proxy is an assumption: construction does not follow traffic exactly, unpaved rural roads
    and bare soil are not represented, and the totals are for 2016. A zero proxy gives zeros.
    """
    weight = np.where(india_mask(), proxy, 0.0)
    total = weight.sum()
    if not total > 0:
        return np.zeros((NY, NX)), np.zeros((NY, NX))
    share = weight / total
    pm25_kt = C.DUST_ROAD_PM25_KT + C.DUST_CONSTRUCTION_PM25_KT
    pm10_kt = C.DUST_ROAD_PM10_KT + C.DUST_CONSTRUCTION_PM10_KT
    kg_h = 1e6 / HOURS_PER_YEAR  # kt per year -> kg per hour
    return share * pm25_kt * kg_h, share * (pm10_kt - pm25_kt) * kg_h


def split_by_region(grids: dict[str, np.ndarray]) -> Emissions:
    """One constant grid per `{sector}_{region}` and `coarse_{sector}_{region}` tag; cells
    outside India are dropped.

    `grids` holds domain grids keyed by sector (fine) and `coarse_{sector}`; a missing key is
    zero.
    """
    land, regions = india_mask(), region_mask()
    em = Emissions()
    for prefix in ("", COARSE_PREFIX):
        for sector in SECTORS:
            grid = grids.get(prefix + sector, np.zeros((NY, NX)))
            for i, region in enumerate(REGIONS):
                em.set_constant(f"{prefix}{sector}_{region}",
                                np.where(land & (regions == i), grid, 0.0))
    return em


def all_grids() -> dict[str, np.ndarray]:
    """Every baseline grid from the source files: fine and `coarse_` grids for the EDGAR
    sectors plus the estimated dust."""
    pm25 = sector_grids("PM2.5")
    grids = {**pm25, **coarse_grids(pm25, sector_grids("PM10"))}
    grids["dust"], grids[COARSE_PREFIX + "dust"] = dust_grids(pm25["vehicles"])
    return grids


_GRID_KEYS = tuple(p + s for p in ("", COARSE_PREFIX) for s in (*EDGAR_SECTORS, "dust"))

# Bump on any change to `read_grid`, the sector mapping, the dust estimate or the conversion:
# cached grids rebuild.
INVENTORY_LOADER_VERSION = 2


def _cache_key() -> str:
    """Hash of everything the cached grids depend on: loader version, sector mapping, conversion,
    domain grid and each source file's size and modification time."""
    folder = _inventory_dir()
    stats = [(n, (folder / n).stat().st_size, (folder / n).stat().st_mtime_ns) for n in source_files()]
    dust = [C.DUST_ROAD_PM10_KT, C.DUST_ROAD_PM25_KT, C.DUST_CONSTRUCTION_PM10_KT,
            C.DUST_CONSTRUCTION_PM25_KT]
    spec = [INVENTORY_LOADER_VERSION, EDGAR_SECTORS, HOURS_PER_YEAR,
            (NY, NX, LAT_MIN, LON_MIN, CELL), stats, dust]
    return hashlib.sha256(json.dumps(spec, sort_keys=True).encode()).hexdigest()


def inventory_emissions() -> Emissions:
    """The 48 baseline tags (fine and coarse) in kg per hour, from the cached .npz.

    The cache is rebuilt whenever its key (see `_cache_key`) no longer matches. The source files
    must be present even when a cache exists, since the key cannot be verified without them.
    """
    _require_files()
    key, cache = _cache_key(), _cache_path()
    grids = None
    if cache.is_file():
        with np.load(cache) as z:
            if "key" in z.files and str(z["key"]) == key and set(_GRID_KEYS) <= set(z.files):
                grids = {s: z[s] for s in _GRID_KEYS}
    if grids is None:
        grids = all_grids()
        tmp = cache.with_name(f"{cache.name}.{uuid.uuid4().hex}.tmp.npz")
        np.savez_compressed(tmp, key=np.array(key), **grids)
        tmp.replace(cache)
    return split_by_region(grids)


def inventory_notes() -> dict:
    return {"source": SOURCE, "year": YEAR, "dust_available": DUST_AVAILABLE,
            "dust_estimated": DUST_ESTIMATED, "dust_source": DUST_SOURCE, "licence": LICENCE}
