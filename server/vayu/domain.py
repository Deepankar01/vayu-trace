"""Grid, regions, fire states and the emission-tag catalogue."""
import json
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
from shapely import contains_xy, prepare
from shapely.geometry import shape

from vayu.constants import EARTH_RADIUS_M

LON_MIN, LON_MAX = 66.0, 98.0
LAT_MIN, LAT_MAX = 6.0, 38.0
CELL = 0.1
NX = NY = 320

REGIONS = ("delhi_ncr", "punjab", "haryana", "uttar_pradesh", "bihar", "rest_of_india")
SECTORS = ("vehicles", "industry", "dust", "residential")
FIRE_STATES = ("punjab", "haryana", "uttar_pradesh", "madhya_pradesh", "other")

NCR_CENTRE = (77.21, 28.61)  # lon, lat of Delhi
NCR_RADIUS_KM = 50.0

_GEOJSON = Path(__file__).parent / "assets" / "india-states.geojson"
_STATE_NAMES = {  # GeoJSON state name -> key
    "Punjab": "punjab",
    "Haryana": "haryana",
    "Uttar Pradesh": "uttar_pradesh",
    "Bihar": "bihar",
    "Madhya Pradesh": "madhya_pradesh",
}

_SECTOR_LABELS = {
    "vehicles": "Vehicles",
    "industry": "Industry and power",
    "dust": "Road and construction dust",
    "residential": "Residential",
}
_COLORS = {
    "fire": "#ff5a2b",
    "vehicles": "#6aa8ff",
    "industry": "#b98cff",
    "dust": "#e0b45a",
    "residential": "#5fd3c4",
}


@dataclass(frozen=True)
class Tag:
    id: str
    kind: Literal["fire", "firefc", "sector", "user"]
    sector: str | None
    region: str
    label: str
    color: str


def _build_tags() -> tuple[Tag, ...]:
    fire_label = "Fires (satellite)"
    tags = [Tag(f"fire_{s}", "fire", None, s, fire_label, _COLORS["fire"]) for s in FIRE_STATES]
    tags += [Tag(f"firefc_{s}", "firefc", None, s, fire_label, _COLORS["fire"]) for s in FIRE_STATES]
    tags += [
        Tag(f"{sec}_{reg}", "sector", sec, reg, _SECTOR_LABELS[sec], _COLORS[sec])
        for sec in SECTORS
        for reg in REGIONS
    ]
    return tuple(tags)


TAGS: tuple[Tag, ...] = _build_tags()


def cell_index(lon, lat) -> tuple[np.ndarray, np.ndarray]:
    """(ix, iy) of the cell containing each point.

    -1 marks a point outside the grid (or NaN) and is set per axis, so one index can be valid
    while the other is -1. Mask with `inside(ix, iy)` before indexing `[iy, ix]`; a raw -1
    would silently wrap to the last row/column.
    """
    lon = np.asarray(lon, dtype=float)
    lat = np.asarray(lat, dtype=float)
    out = []
    for v, v0, n in ((lon, LON_MIN, NX), (lat, LAT_MIN, NY)):
        finite = np.isfinite(v)
        i = np.floor((np.where(finite, v, 0.0) - v0) / CELL + 1e-9).astype(int)
        out.append(np.where(finite & (i >= 0) & (i < n), i, -1))
    return out[0], out[1]


def inside(ix, iy) -> np.ndarray:
    """True where both indices from `cell_index` are valid (>= 0)."""
    return (np.asarray(ix) >= 0) & (np.asarray(iy) >= 0)


def cell_center(ix, iy) -> tuple[np.ndarray, np.ndarray]:
    """(lon, lat) of cell centres."""
    return (LON_MIN + (np.asarray(ix) + 0.5) * CELL, LAT_MIN + (np.asarray(iy) + 0.5) * CELL)


@lru_cache(maxsize=1)
def cell_area_m2() -> np.ndarray:
    """Area of a cell in each latitude row, shape (NY,), on a spherical Earth."""
    edges = np.radians(LAT_MIN + np.arange(NY + 1) * CELL)
    return EARTH_RADIUS_M**2 * np.radians(CELL) * np.diff(np.sin(edges))


def _grid_centres() -> tuple[np.ndarray, np.ndarray]:
    return np.meshgrid(*cell_center(np.arange(NX), np.arange(NY)))


@lru_cache(maxsize=1)
def _state_masks() -> dict[str, np.ndarray]:
    """Boolean (NY, NX) mask of cell centres inside each named state polygon."""
    lon, lat = _grid_centres()
    masks = {}
    for feat in json.loads(_GEOJSON.read_text())["features"]:
        key = _STATE_NAMES.get(feat["properties"]["name"])
        if key is None:
            continue
        geom = shape(feat["geometry"])
        prepare(geom)
        masks[key] = contains_xy(geom, lon, lat)
    missing = sorted(name for name, key in _STATE_NAMES.items() if key not in masks)
    if missing:
        raise ValueError(f"{_GEOJSON.name} has no feature for state(s): {', '.join(missing)}")
    return masks


@lru_cache(maxsize=1)
def india_mask() -> np.ndarray:
    """(NY, NX) bool: cell centre inside any state or union-territory polygon of the official
    outline (so ocean and neighbouring countries are False)."""
    lon, lat = _grid_centres()
    out = np.zeros((NY, NX), dtype=bool)
    for feat in json.loads(_GEOJSON.read_text())["features"]:
        geom = shape(feat["geometry"])
        prepare(geom)
        out |= contains_xy(geom, lon, lat)
    out.setflags(write=False)
    return out


@lru_cache(maxsize=1)
def region_mask() -> np.ndarray:
    """(NY, NX) int8 indexing REGIONS. Delhi NCR (50 km of Delhi) overrides the state."""
    masks = _state_masks()
    out = np.full((NY, NX), REGIONS.index("rest_of_india"), dtype=np.int8)
    for key in ("punjab", "haryana", "uttar_pradesh", "bihar"):
        out[masks[key]] = REGIONS.index(key)
    lon, lat = _grid_centres()
    lat0 = np.radians(NCR_CENTRE[1])
    dx = np.radians(lon - NCR_CENTRE[0]) * np.cos((np.radians(lat) + lat0) / 2)
    dy = np.radians(lat) - lat0
    dist_km = EARTH_RADIUS_M / 1000 * np.hypot(dx, dy)
    out[dist_km <= NCR_RADIUS_KM] = REGIONS.index("delhi_ncr")
    out.setflags(write=False)
    return out


@lru_cache(maxsize=1)
def fire_state_mask() -> np.ndarray:
    """(NY, NX) int8 indexing FIRE_STATES; cells outside the four named states are 'other'."""
    masks = _state_masks()
    out = np.full((NY, NX), FIRE_STATES.index("other"), dtype=np.int8)
    for key in FIRE_STATES[:-1]:
        out[masks[key]] = FIRE_STATES.index(key)
    out.setflags(write=False)
    return out
