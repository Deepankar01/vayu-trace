"""Meteorology on the 1 degree lattice, and the interpolator the particle model samples."""
from dataclasses import dataclass
from datetime import datetime

import numpy as np

from vayu.constants import (
    BLH_DAY_BASE_M,
    BLH_DAY_HALF_WIDTH_H,
    BLH_DAY_PER_K,
    BLH_MAX_M,
    BLH_MIN_M,
    BLH_NIGHT_BASE_M,
    BLH_NIGHT_PER_MS,
    BLH_PEAK_LOCAL_HOUR,
    MET_STEP_DEG,
    WIND_BLEND_100M,
)
from vayu.domain import LAT_MAX, LAT_MIN, LON_MAX, LON_MIN

NLON = round((LON_MAX - LON_MIN) / MET_STEP_DEG) + 1
NLAT = round((LAT_MAX - LAT_MIN) / MET_STEP_DEG) + 1

VARIABLES = (
    "wind_speed_10m", "wind_direction_10m", "wind_speed_100m", "wind_direction_100m",
    "temperature_2m", "relative_humidity_2m", "precipitation", "boundary_layer_height",
)


def lattice() -> tuple[np.ndarray, np.ndarray]:
    """(lon, lat) vectors of the met lattice, inclusive of both domain edges."""
    return (LON_MIN + MET_STEP_DEG * np.arange(NLON), LAT_MIN + MET_STEP_DEG * np.arange(NLAT))


@dataclass
class MetRaw:
    """Hourly met on the lattice. Each variable is float32 (hours, NLAT, NLON), NaN where missing.

    Units as requested from Open-Meteo: wind m/s, direction degrees the wind blows FROM, 2 m
    temperature degC, relative humidity %, precipitation mm per hour, boundary layer height m.
    Hour `h` is `start + h` hours (UTC).
    """
    start: datetime
    hours: int
    lon: np.ndarray
    lat: np.ndarray
    variables: dict[str, np.ndarray]


@dataclass
class MetSample:
    u: np.ndarray  # m/s, positive eastward
    v: np.ndarray  # m/s, positive northward
    blh: np.ndarray  # m
    rh: np.ndarray  # fraction 0..1
    temp_c: np.ndarray
    precip_mm_h: np.ndarray


def kmh_to_ms(speed_kmh):
    return np.asarray(speed_kmh, dtype=float) / 3.6


def wind_uv(speed_ms, direction_deg):
    """(u, v) from speed and meteorological direction (degrees the wind blows FROM).

    Wind from 270 degrees (westerly) blows toward the east: u = +speed, v = 0.
    """
    rad = np.radians(np.asarray(direction_deg, dtype=float))
    speed = np.asarray(speed_ms, dtype=float)
    return -speed * np.sin(rad), -speed * np.cos(rad)


def clamp_blh(blh_m):
    """Limit a mixing-layer height to BLH_MIN_M..BLH_MAX_M."""
    return np.clip(blh_m, BLH_MIN_M, BLH_MAX_M)


def estimate_blh(local_hour, temp_c, wind_ms):
    """Heuristic mixing-layer height (m), used only where Open-Meteo has no value.

    A diurnal parameterisation, not a boundary-layer model:
      night   = BLH_NIGHT_BASE_M + BLH_NIGHT_PER_MS * wind     (mechanical mixing keeps it up)
      daytime = a cosine bump peaking at BLH_PEAK_LOCAL_HOUR, zero beyond +/- BLH_DAY_HALF_WIDTH_H,
                with amplitude BLH_DAY_BASE_M + BLH_DAY_PER_K * max(temp_c, 0)
      blh     = night + bump * amplitude, clamped to BLH_MIN_M..BLH_MAX_M
    Coefficients and their basis are in constants.py. Local hour = UTC hour + longitude / 15.
    """
    hour = np.asarray(local_hour, dtype=float) % 24.0
    temp = np.asarray(temp_c, dtype=float)
    wind = np.asarray(wind_ms, dtype=float)
    offset = (hour - BLH_PEAK_LOCAL_HOUR + 12.0) % 24.0 - 12.0  # signed distance to the peak
    bump = np.where(
        np.abs(offset) < BLH_DAY_HALF_WIDTH_H,
        np.cos(np.pi * offset / (2 * BLH_DAY_HALF_WIDTH_H)),
        0.0,
    )
    night = BLH_NIGHT_BASE_M + BLH_NIGHT_PER_MS * wind
    amplitude = BLH_DAY_BASE_M + BLH_DAY_PER_K * np.maximum(temp, 0.0)
    return clamp_blh(night + bump * amplitude)


class MetField:
    """Bilinear-in-space, linear-in-time view of a `MetRaw`."""

    _FIELDS = ("u", "v", "blh", "rh", "temp_c", "precip_mm_h")

    def __init__(self, raw: MetRaw):
        self.raw = raw
        self.hours = raw.hours
        var = raw.variables
        u10, v10 = wind_uv(var["wind_speed_10m"], var["wind_direction_10m"])
        u100, v100 = wind_uv(var["wind_speed_100m"], var["wind_direction_100m"])
        w = WIND_BLEND_100M
        u = (1 - w) * u10 + w * u100
        v = (1 - w) * v10 + w * v100
        temp = var["temperature_2m"].astype(float)

        blh = var["boundary_layer_height"].astype(float)
        missing = np.isnan(blh)
        self.blh_estimated = bool(missing.any())
        if self.blh_estimated:
            utc_hour = (raw.start.hour + np.arange(raw.hours))[:, None, None]
            local_hour = utc_hour + raw.lon[None, None, :] / 15.0
            est = estimate_blh(local_hour, temp, np.hypot(u, v))
            blh = np.where(missing, est, blh)
        blh = clamp_blh(blh)

        fields = {
            "u": u, "v": v, "blh": blh, "rh": var["relative_humidity_2m"].astype(float) / 100.0,
            "temp_c": temp, "precip_mm_h": var["precipitation"].astype(float),
        }
        self._data = np.stack([fields[k] for k in self._FIELDS]).astype(np.float32)

    def grid(self, hour: int) -> dict[str, np.ndarray]:
        """The (NLAT, NLON) fields at an integer hour since `start`."""
        return {k: self._data[i, hour].copy() for i, k in enumerate(self._FIELDS)}

    def sample(self, lon, lat, t_hours) -> MetSample:
        """Fields at positions `lon`, `lat` and fractional hours `t_hours` since `start`.

        Positions clamp to the lattice edge and time to the available hours. Output arrays have
        the broadcast shape of the inputs.

        Missing data: an output is NaN only if a lattice value it actually depends on (one with
        positive interpolation weight) is NaN, or if `lon`, `lat` or `t_hours` is itself NaN (then
        every output is NaN there). A neighbour with zero weight never contaminates a result.
        `blh` is never NaN from missing data (null values are replaced by the estimate), so it
        is NaN only for NaN inputs or when the estimate's inputs (temperature, wind) are missing.

        A scalar, non-NaN `t_hours` (what the particle step uses) takes a faster path that
        interpolates the lattice in time once and then bilinearly in space; it gives the same
        values up to float rounding and the same missing-data behaviour.
        """
        if np.ndim(t_hours) == 0 and not np.isnan(t_hours):
            return self._sample_at(lon, lat, float(t_hours))
        lon, lat, t = np.broadcast_arrays(
            np.asarray(lon, dtype=float), np.asarray(lat, dtype=float),
            np.asarray(t_hours, dtype=float),
        )
        bad = np.isnan(lon) | np.isnan(lat) | np.isnan(t)
        lon, lat, t = (np.where(bad, 0.0, x) for x in (lon, lat, t))
        fx = np.clip((lon - self.raw.lon[0]) / MET_STEP_DEG, 0, NLON - 1)
        fy = np.clip((lat - self.raw.lat[0]) / MET_STEP_DEG, 0, NLAT - 1)
        ft = np.clip(t, 0, self.hours - 1)
        ix = np.minimum(fx.astype(int), NLON - 2)
        iy = np.minimum(fy.astype(int), NLAT - 2)
        it = np.minimum(ft.astype(int), max(self.hours - 2, 0))
        wx, wy, wt = fx - ix, fy - iy, ft - it
        it1 = np.minimum(it + 1, self.hours - 1)

        d = self._data
        out = 0.0
        for tt, wt_ in ((it, 1 - wt), (it1, wt)):
            for yy, wy_ in ((iy, 1 - wy), (iy + 1, wy)):
                for xx, wx_ in ((ix, 1 - wx), (ix + 1, wx)):
                    w = wt_ * wy_ * wx_
                    out = out + np.where(w > 0, d[:, tt, yy, xx] * w, 0.0)
        out = np.where(bad, np.nan, out)
        return MetSample(*(out[i].astype(float) for i in range(len(self._FIELDS))))

    def _sample_at(self, lon, lat, t: float) -> MetSample:
        """`sample` at one time `t` (not NaN): time interpolation on the lattice, then bilinear.

        A lattice value contributes only with positive time weight and positive spatial weight,
        so the NaN rules match the general path exactly.
        """
        ft = min(max(t, 0.0), self.hours - 1)
        it = min(int(ft), max(self.hours - 2, 0))
        wt = ft - it
        it1 = min(it + 1, self.hours - 1)
        nf = len(self._FIELDS)
        slab = np.zeros((nf, NLAT * NLON))
        for tt, w in ((it, 1.0 - wt), (it1, wt)):
            if w > 0:
                slab = slab + self._data[:, tt].reshape(nf, -1).astype(float) * w
        slab = np.ascontiguousarray(slab.T)  # (lattice point, field): one row per gather
        has_nan = bool(np.isnan(slab).any())

        lon, lat = np.broadcast_arrays(np.asarray(lon, dtype=float), np.asarray(lat, dtype=float))
        bad = np.isnan(lon) | np.isnan(lat)
        lon, lat = (np.where(bad, 0.0, x) for x in (lon, lat))
        fx = np.clip((lon - self.raw.lon[0]) / MET_STEP_DEG, 0, NLON - 1)
        fy = np.clip((lat - self.raw.lat[0]) / MET_STEP_DEG, 0, NLAT - 1)
        ix = np.minimum(fx.astype(int), NLON - 2)
        iy = np.minimum(fy.astype(int), NLAT - 2)
        wx, wy = fx - ix, fy - iy
        base = iy * NLON + ix

        out = np.zeros(base.shape + (nf,))
        for dy, wy_ in ((0, 1 - wy), (1, wy)):
            for dx, wx_ in ((0, 1 - wx), (1, wx)):
                w = wy_ * wx_
                vals = slab.take(base + (dy * NLON + dx), axis=0)
                vals *= w[..., None]
                if has_nan:  # a zero-weight corner must not contribute its NaN
                    vals[w <= 0] = 0.0
                out += vals
        out[bad] = np.nan
        return MetSample(*(out[..., i].astype(float) for i in range(nf)))
