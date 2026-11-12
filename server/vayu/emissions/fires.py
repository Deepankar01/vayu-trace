"""Hourly PM2.5 and coarse (2.5-10 um) emissions from VIIRS fire radiative power (FRP).

Method, per UTC day:
 1. Each daytime detection's FRP is divided by the diurnal profile g(t) at its acquisition time
    (floored at FIRE_PROFILE_FLOOR), giving the FRP the same fire would have at the daily peak.
    Several pixels in one cell are several fires, so a cell's peak FRP for one satellite is the SUM
    over its pixels. A satellite that observed the day (any detection in the domain) but saw
    nothing in a cell contributes zero there; the per-satellite grids are AVERAGED (not summed:
    satellites re-observe the same fires).
    Night detections: if ANY satellite has a daytime detection in a cell that day, night detections
    in that cell are ignored for every satellite. If the cell has only night detections, each
    satellite's value is the SUM of its night FRP taken as the peak, with NO division by g (g
    treated as 1). A single night pixel must not be scaled up by 1/g to a large assumed daytime
    peak; under-counting night-only fires is the conservative direction.
 2. Daily energy (MJ) = FRP_peak (MW) * sqrt(2 pi) * sigma * 3600 s, the integral of the Gaussian.
 3. kg PM2.5 = MJ * BIOMASS_KG_PER_MJ * EF (g/kg) / 1000, EF by the cell's fire state.
 4. The daily mass is spread over UTC hours by the Gaussian profile, renormalised to sum to 1.
 5. Coarse smoke = PM2.5 * FIRE_COARSE_PER_PM25_{CROP,VEG} (constants.py), under `coarse_` tags.
"""
import math
from datetime import UTC, date, datetime, timedelta

import numpy as np

from vayu import constants as C
from vayu.clients import firms
from vayu.domain import COARSE_PREFIX, FIRE_STATES, NX, NY, cell_index, fire_state_mask, inside
from vayu.emissions import Emissions

PEAK_HOUR_UTC = C.FIRE_PEAK_HOUR_IST - 5.5  # IST = UTC + 5:30
FORECAST_BASIS_DAYS = 3


def profile(t_hours):
    """Unnormalised Gaussian diurnal profile, 1 at the peak; t in UTC hours."""
    return np.exp(-0.5 * ((np.asarray(t_hours, dtype=float) - PEAK_HOUR_UTC) / C.FIRE_SIGMA_H) ** 2)


def hourly_shares() -> np.ndarray:
    """Share of a day's emission in each UTC hour [h, h+1): Gaussian integral, summing to 1."""
    s = C.FIRE_SIGMA_H * math.sqrt(2.0)
    edges = [math.erf((k - PEAK_HOUR_UTC) / s) for k in range(25)]
    w = np.array([0.5 * (edges[k + 1] - edges[k]) for k in range(24)])
    return w / w.sum()


def _ef_grid() -> np.ndarray:
    crop = np.isin(fire_state_mask(), [FIRE_STATES.index(s) for s in C.CROP_STATES])
    return np.where(crop, C.EF_PM25_CROP_G_PER_KG, C.EF_PM25_VEG_G_PER_KG)


def _coarse_ratio_grid() -> np.ndarray:
    crop = np.isin(fire_state_mask(), [FIRE_STATES.index(s) for s in C.CROP_STATES])
    return np.where(crop, C.FIRE_COARSE_PER_PM25_CROP, C.FIRE_COARSE_PER_PM25_VEG)


def _daily_kg(day: date) -> np.ndarray:
    """(NY, NX) kg PM2.5 emitted on UTC `day`. Upstream errors propagate."""
    det = firms.detections(day)
    out = np.zeros((NY, NX))
    if len(det) == 0:
        return out
    ix, iy = cell_index(det.lon, det.lat)
    ok = inside(ix, iy) & np.isfinite(det.frp_mw) & (det.frp_mw > 0)
    if not ok.any():
        return out
    det, ix, iy = det.select(ok), ix[ok], iy[ok]
    minutes = (det.acq_utc - np.datetime64(day.isoformat(), "m")) / np.timedelta64(1, "m")
    g = np.maximum(profile(minutes / 60.0), C.FIRE_PROFILE_FLOOR)
    peak = det.frp_mw / g  # used for day-flagged detections only
    flat = iy * NX + ix
    sats = np.unique(det.satellite)
    day_any = np.zeros(NY * NX, dtype=bool)
    day_any[flat[det.is_day]] = True
    mean_peak = np.zeros(NY * NX)
    for sat in sats:
        m = det.satellite == sat
        day_sum = np.zeros(NY * NX)
        night_sum = np.zeros(NY * NX)
        np.add.at(day_sum, flat[m & det.is_day], peak[m & det.is_day])
        np.add.at(night_sum, flat[m & ~det.is_day], det.frp_mw[m & ~det.is_day])  # g taken as 1
        mean_peak += np.where(day_any, day_sum, night_sum)
    mean_peak = mean_peak.reshape(NY, NX) / len(sats)
    energy_mj = mean_peak * math.sqrt(2 * math.pi) * C.FIRE_SIGMA_H * 3600.0
    return energy_mj * C.BIOMASS_KG_PER_MJ * _ef_grid() / 1000.0


def _add_day(em: Emissions, prefix: str, field: np.ndarray, hour_indices: list[tuple[int, int]],
             shares: np.ndarray) -> None:
    """Add `field` * share[hour of day] to `{prefix}_{state}` for (h, hour_of_day) pairs."""
    mask = fire_state_mask()
    for si, state in enumerate(FIRE_STATES):
        sfield = np.where(mask == si, field, 0.0)
        iy, ix = np.nonzero(sfield)
        if iy.size == 0:
            continue
        for h, k in hour_indices:
            em.add(f"{prefix}_{state}", h, iy, ix, sfield[iy, ix] * shares[k])


def fire_emissions(start: datetime, hours: int, now: datetime) -> Emissions:
    """Fire PM2.5 (and coarse smoke under `coarse_` tags) for hours [start + h, start + h + 1),
    h in range(hours).

    Hours in complete UTC days before `now`'s day are observed (`fire_{state}`). Hours from 00:00
    UTC of `now`'s day on use the mean of the three complete days before it (`firefc_{state}`).
    FIRE_SCALING_DEFAULT is NOT applied here.
    """
    if start.tzinfo is None or now.tzinfo is None:
        raise ValueError("start and now must be timezone-aware")
    start, now = start.astimezone(UTC), now.astimezone(UTC)
    if (start.minute, start.second, start.microsecond) != (0, 0, 0):
        raise ValueError("start must be on a whole hour")
    today = now.date()
    shares = hourly_shares()
    observed: dict[date, list[tuple[int, int]]] = {}
    forecast: list[tuple[int, int]] = []
    for h in range(hours):
        ts = start + timedelta(hours=h)
        if ts.date() < today:
            observed.setdefault(ts.date(), []).append((h, ts.hour))
        else:
            forecast.append((h, ts.hour))
    em = Emissions()
    fields: dict[date, np.ndarray] = {}

    def field(d: date) -> np.ndarray:
        if d not in fields:
            fields[d] = _daily_kg(d)
        return fields[d]

    ratio = _coarse_ratio_grid()
    for d, idx in observed.items():
        _add_day(em, "fire", field(d), idx, shares)
        _add_day(em, COARSE_PREFIX + "fire", field(d) * ratio, idx, shares)
    if forecast:
        basis = np.mean([field(today - timedelta(days=k))
                         for k in range(1, FORECAST_BASIS_DAYS + 1)], axis=0)
        _add_day(em, "firefc", basis, forecast, shares)
        _add_day(em, COARSE_PREFIX + "firefc", basis * ratio, forecast, shares)
    return em
