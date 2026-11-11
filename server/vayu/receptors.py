"""What a researcher sees when they click a city: per-source time series, the "where it came
from" breakdown, smoke arrival and a wind back-trajectory.

`breakdown` is the reference implementation that the TypeScript port must reproduce exactly, so it
is pure (no I/O, no rounding) and deliberately simple.
"""
from dataclasses import dataclass
from typing import Literal, Mapping, TypedDict

import numpy as np

from vayu.cities import CITIES, City
from vayu.constants import DT_S, EARTH_RADIUS_M, FIRE_ARRIVAL_UGM3
from vayu.domain import (
    FIRE_STATES, NX, NY, REGIONS, TAGS, cell_index, inside, region_mask,
)
from vayu.met import MetField

SHARE_MINOR = 0.05  # hourly shares carry about +/-5 percentage points of sampling uncertainty
UNEXPLAINED_COLOR = "#5b6475"
USER_COLOR = "#9aa3b5"  # user-added sources have no catalogue colour
DEFAULT_USER_LABEL = "Added source"

_TAG_BY_ID = {t.id: t for t in TAGS}
_SECTOR_LABEL = {t.sector: t.label for t in TAGS if t.sector}
_REGION_NAMES = {
    "delhi_ncr": "Delhi NCR", "punjab": "Punjab", "haryana": "Haryana",
    "uttar_pradesh": "Uttar Pradesh", "bihar": "Bihar", "rest_of_india": "Rest of India",
}
_FIRE_STATE_NAMES = {
    "punjab": "Punjab", "haryana": "Haryana", "uttar_pradesh": "Uttar Pradesh",
    "madhya_pradesh": "Madhya Pradesh", "other": "other states",
}
assert set(_REGION_NAMES) == set(REGIONS) and set(_FIRE_STATE_NAMES) == set(FIRE_STATES)

_FIRE_KINDS = ("fire", "firefc")
CALM_MS = 0.1  # below this wind speed the direction is undefined (NaN)


def _lookup(tag_id: str):
    """The catalogue Tag for `tag_id`, or None for a user-added tag (id starting `user_`).
    Anything else is an error: the stored run does not match the current catalogue."""
    if tag_id.startswith("user_"):
        return None
    try:
        return _TAG_BY_ID[tag_id]
    except KeyError:
        raise ValueError(
            f"unknown source tag {tag_id!r}; the stored run predates the current tag catalogue"
        ) from None


# --- city series ---

@dataclass
class CitySeries:
    """Hourly series for one city; every array has length `run.hours`.

    by_tag      dry PM2.5 (µg/m³) per emission tag
    fire_age_h  concentration-weighted fire-parcel age (hours); NaN where no fire in the block
    met         wind_ms, wind_dir_deg (direction the wind blows FROM, 0..360), rh (fraction 0..1),
                temp_c, blh_m, at the city's coordinates in the middle of each output hour
    """
    by_tag: dict[str, np.ndarray]
    fire_age_h: np.ndarray
    met: dict[str, np.ndarray]


def city_region(city: City) -> str:
    """The region id (an element of REGIONS) of the cell containing the city."""
    ix, iy = cell_index(city.lon, city.lat)
    return REGIONS[int(region_mask()[int(iy), int(ix)])]


def wind_dir_from_deg(u, v):
    """Meteorological wind direction (degrees the wind blows FROM, 0..360) from u (east) and
    v (north). u > 0, v = 0 (blowing toward the east) is from 270. Calm air (speed below
    CALM_MS) has no direction: NaN."""
    d = np.mod(270.0 - np.degrees(np.arctan2(v, u)), 360.0)
    return np.where(np.hypot(u, v) < CALM_MS, np.nan, d)


def _blocks(cities) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Flat cell index (ncity, 9) of each city's 3x3 block, and a validity mask (ncity, 9).
    Cells outside the domain are invalid (index 0 as a placeholder)."""
    ix, iy = cell_index([c.lon for c in cities], [c.lat for c in cities])
    d = np.array([-1, 0, 1])
    bx = ix[:, None, None] + d[None, None, :]
    by = iy[:, None, None] + d[None, :, None]
    ok = inside(ix, iy)[:, None, None] & (bx >= 0) & (bx < NX) & (by >= 0) & (by < NY)
    flat = np.where(ok, by * NX + bx, 0).reshape(len(cities), 9)
    return flat, ok.reshape(len(cities), 9)


def _nanmean_blocks(grid: np.ndarray, flat, ok) -> np.ndarray:
    vals = grid.ravel()[flat].astype(float)
    good = ok & np.isfinite(vals)
    n = good.sum(axis=1)
    total = np.where(good, vals, 0.0).sum(axis=1)
    return np.where(n > 0, total / np.maximum(n, 1), np.nan)


def city_series(run, met: MetField, met_offset_h: float) -> dict[str, CitySeries]:
    """Per-city series from a run. A city's value is the NaN-aware mean over the 3x3 block of cells
    centred on its cell (cells outside the domain skipped; all NaN gives NaN), so it represents
    roughly a 30 km square, not a point. `fire_age_h` is the mean over the same block weighted by
    the fire concentration (all fire and firefc tags) in each cell; NaN if there is no fire in the
    block. `met_offset_h` is hours from the met field's start to the run's `start`.
    Wind direction is NaN in calm air (speed below 0.1 m/s). A tag that is neither in the
    catalogue nor `user_*` raises ValueError.

    Each frame is read once.
    """
    flat, ok = _blocks(CITIES)
    n, hours = len(CITIES), run.hours
    fire_tags = [t for t in run.tags
                 if (tag := _lookup(t)) is not None and tag.kind in _FIRE_KINDS]
    by_tag = {t: np.full((n, hours), np.nan) for t in run.tags}
    age = np.full((n, hours), np.nan)
    for h in range(hours):
        frame = run.frame(h)
        for t in run.tags:
            by_tag[t][:, h] = _nanmean_blocks(frame[t], flat, ok)
        if fire_tags:
            fire = sum(np.nan_to_num(frame[t], nan=0.0) for t in fire_tags)
            a = run.fire_age_h(h)
            w = np.where(ok, fire.ravel()[flat], 0.0)
            av = a.ravel()[flat].astype(float)
            w = np.where(np.isfinite(av), w, 0.0)
            wsum = w.sum(axis=1)
            num = np.where(w > 0, av * w, 0.0).sum(axis=1)
            age[:, h] = np.where(wsum > 0, num / np.where(wsum > 0, wsum, 1.0), np.nan)

    lon = np.array([c.lon for c in CITIES])[:, None]
    lat = np.array([c.lat for c in CITIES])[:, None]
    t_met = met_offset_h + np.arange(hours)[None, :] + 0.5
    s = met.sample(lon, lat, t_met)
    met_out = {
        "wind_ms": np.hypot(s.u, s.v), "wind_dir_deg": wind_dir_from_deg(s.u, s.v),
        "rh": s.rh, "temp_c": s.temp_c, "blh_m": s.blh,
    }
    return {
        c.id: CitySeries(
            by_tag={t: by_tag[t][i] for t in run.tags}, fire_age_h=age[i],
            met={k: v[i] for k, v in met_out.items()},
        )
        for i, c in enumerate(CITIES)
    }


# --- breakdown ---

@dataclass(frozen=True)
class BreakdownRow:
    key: str  # stable id, e.g. fire:punjab, local:vehicles, transported:vehicles:punjab
    label: str
    kind: Literal["fire", "local", "transported", "user", "unexplained"]
    sector: str | None
    value: float  # µg/m³
    share: float | None  # 0..1 of the denominator; None when the denominator is 0
    minor: bool  # share below SHARE_MINOR: the UI folds these together
    color: str


def breakdown(
    by_tag_now: Mapping[str, float],
    weights: Mapping[str, float],
    city_region: str,
    measured: float | None,
    labels: Mapping[str, str] | None = None,
) -> list[BreakdownRow]:
    """Where a city's PM2.5 came from, at one hour.

    Effective value of a tag = by_tag_now[tag] * weights.get(tag, 1.0); a NaN value is skipped, and
    if every tag is NaN the result is []. Fire (observed) and fire-persistence tags of one state
    form one row. Sector tags in `city_region` are "Local ..."; others "Transported ... - Region".
    Tags whose id starts with `user_` get one row each, labelled from `labels` (default "Added
    source"). Shares are of max(measured, simulated total) when `measured` is finite, else of the
    simulated total; all None if that is 0. A "Not explained by model" row is added only when
    `measured` is finite and exceeds the simulated total. `minor` means share < 5%. Rows of value
    exactly 0 are omitted. Order: fire, local, transported, user (each by value descending, ties
    by `key` in plain code-unit/ASCII comparison, not locale), then unexplained. Nothing is
    rounded. A `weights` entry for a tag absent from `by_tag_now` is ignored. A tag that is neither
    in the catalogue nor `user_*` raises ValueError.

    The "unexplained" row is not model output; the simulated total is the sum of `value` over
    rows with kind != "unexplained".

    Contract for the TypeScript port: results must agree within 1e-9 relative. To make that
    robust, every sum here iterates tags in SORTED tag-id order with an explicit left-to-right
    `+=` loop (no `sum()`, no `fsum`), so the port must do the same.
    """
    labels = labels or {}
    eff: dict[str, float] = {}
    for tag_id in sorted(by_tag_now):
        _lookup(tag_id)
        v = by_tag_now[tag_id]
        if v is None or not np.isfinite(v):
            continue
        eff[tag_id] = float(v) * float(weights.get(tag_id, 1.0))
    if not eff:
        return []
    total = 0.0
    for v in eff.values():
        total += v
    have_measured = measured is not None and np.isfinite(measured)
    denom = max(float(measured), total) if have_measured else total

    def row(key, label, kind, sector, value, color):
        share = None if denom == 0 else value / denom
        minor = share is not None and share < SHARE_MINOR and kind != "unexplained"
        return BreakdownRow(key, label, kind, sector, value, share, minor, color)

    groups: dict[str, dict[str, BreakdownRow]] = {k: {} for k in ("fire", "local", "transported", "user")}
    fire_sum: dict[str, float] = {}
    for tag_id, v in eff.items():  # sorted tag-id order
        if tag_id.startswith("user_"):
            groups["user"][tag_id] = row(f"user:{tag_id}", labels.get(tag_id, DEFAULT_USER_LABEL),
                                         "user", None, v, USER_COLOR)
            continue
        tag = _lookup(tag_id)
        if tag.kind in _FIRE_KINDS:
            fire_sum[tag.region] = fire_sum.get(tag.region, 0.0) + v
        elif tag.region == city_region:
            name = _SECTOR_LABEL[tag.sector].lower()
            groups["local"][tag_id] = row(f"local:{tag.sector}", f"Local {name}", "local",
                                          tag.sector, v, tag.color)
        else:
            name = _SECTOR_LABEL[tag.sector].lower()
            groups["transported"][tag_id] = row(
                f"transported:{tag.sector}:{tag.region}",
                f"Transported {name} — {_REGION_NAMES[tag.region]}",
                "transported", tag.sector, v, tag.color)
    fire_color = next(t.color for t in TAGS if t.kind == "fire")
    for state, v in fire_sum.items():
        groups["fire"][state] = row(f"fire:{state}", f"Fires (satellite) — {_FIRE_STATE_NAMES[state]}",
                                    "fire", None, v, fire_color)

    rows: list[BreakdownRow] = []
    for kind in ("fire", "local", "transported", "user"):
        rows += sorted((r for r in groups[kind].values() if r.value != 0),
                       key=lambda r: (-r.value, r.key))
    if have_measured and measured > total:
        rows.append(row("unexplained", "Not explained by model", "unexplained", None,
                        float(measured) - total, UNEXPLAINED_COLOR))
    return rows


# --- arrival ---

class ArrivalLabel(TypedDict, total=False):
    kind: Literal["present", "arrives", "none"]
    age_h: float | None
    in_h: int


def arrival(fire_series: np.ndarray, hour: int, age_h: float | None = None) -> ArrivalLabel:
    """Smoke status at `hour` from the city's total fire contribution per hour (after weights).

    "present" (with the caller's `age_h`, None if NaN) if the value at `hour` is at or above FIRE_ARRIVAL_UGM3;
    "arrives" with `in_h` hours to the first later hour at or above it; else "none". NaN counts as
    below the threshold; earlier hours are ignored. `hour` outside the series raises IndexError.
    """
    s = np.asarray(fire_series, dtype=float)
    if not 0 <= hour < len(s):
        raise IndexError(f"hour {hour} outside 0..{len(s) - 1}")
    age_h = None if age_h is None or not np.isfinite(age_h) else float(age_h)
    hit = np.where(np.isfinite(s), s, -np.inf) >= FIRE_ARRIVAL_UGM3
    if hit[hour]:
        return {"kind": "present", "age_h": age_h}
    later = np.flatnonzero(hit[hour + 1:])
    if later.size:
        return {"kind": "arrives", "in_h": int(later[0]) + 1}
    return {"kind": "none"}


# --- back-trajectory ---

def _terrain(elev: np.ndarray, lon: float, lat: float) -> tuple[float, bool]:
    """(terrain height with sea clamped to 0, inside the domain) at a point."""
    ix, iy = cell_index(lon, lat)
    if not inside(ix, iy):
        return 0.0, False
    return max(float(elev[int(iy), int(ix)]), 0.0), True


def _passable(elev, lon, lat, ceiling) -> bool:
    h, ok = _terrain(elev, lon, lat)
    return (not ok) or h <= ceiling  # outside the domain counts as passable (then we stop)


def _allowed(elev, lon, lat, dlon, dlat, ceiling) -> bool:
    """A move is allowed if both its destination and its midpoint are passable."""
    return (_passable(elev, lon + dlon, lat + dlat, ceiling)
            and _passable(elev, lon + 0.5 * dlon, lat + 0.5 * dlat, ceiling))


def back_trajectory(
    met: MetField, elev: np.ndarray, lon: float, lat: float, hour: int,
    hours_back: int = 72, met_offset_h: float = 0.0,
) -> list[tuple[float, float]]:
    """Where the air at (lon, lat) in the middle of output hour `hour` came from.

    Integrates backward with the mean wind only (no turbulence), time step DT_S, sampling met at
    the parcel's current position and time (`met_offset_h + hour + 0.5` hours since the met start,
    going backward), moving by -u dt, -v dt. A backward move is refused if the terrain at its
    midpoint or destination exceeds the terrain here plus the mixing height (the transport rule,
    whose ceiling is parcel altitude + blh/2 with altitude = terrain + blh/2, without height
    relaxation; it includes the no-corner-cutting condition); then x-only, then y-only is tried,
    else the parcel stays. Stops early if the parcel leaves the domain, met is NaN or the met time
    range is exhausted; an `hour` whose time already lies outside the met range returns just
    `[(lon, lat)]`. Returns one (lon, lat) per hour, most recent first, starting with the city.
    """
    deg = 180.0 / np.pi
    points = [(float(lon), float(lat))]
    t0 = met_offset_h + hour + 0.5
    steps_per_hour = round(3600 / DT_S)
    for k in range(hours_back * steps_per_hour):
        t = t0 - k * DT_S / 3600.0
        if t < 0 or t > met.hours - 1:
            break
        s = met.sample(lon, lat, t)
        u, v, blh = float(s.u), float(s.v), float(s.blh)
        if not (np.isfinite(u) and np.isfinite(v) and np.isfinite(blh)):
            break
        dlat = -v * DT_S / EARTH_RADIUS_M * deg
        dlon = -u * DT_S / (EARTH_RADIUS_M * np.cos(np.radians(lat))) * deg
        ceiling = _terrain(elev, lon, lat)[0] + blh
        ok_x = _allowed(elev, lon, lat, dlon, 0.0, ceiling)
        ok_y = _allowed(elev, lon, lat, 0.0, dlat, ceiling)
        if _allowed(elev, lon, lat, dlon, dlat, ceiling) and (ok_x or ok_y):
            lon, lat = lon + dlon, lat + dlat
        elif ok_x:
            lon = lon + dlon
        elif ok_y:
            lat = lat + dlat
        if not inside(*cell_index(lon, lat)):
            break
        if (k + 1) % steps_per_hour == 0:
            points.append((float(lon), float(lat)))
    return points
