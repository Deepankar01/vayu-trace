"""Open-Meteo meteorology (forecast + archive) and CAMS PM2.5 for the model domain. No API key."""
import json
import math
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta

import httpx
import numpy as np

from vayu.cache import cached_bytes
from vayu.constants import MET_BATCH
from vayu.errors import UpstreamError
from vayu.met import NLAT, NLON, VARIABLES, MetRaw, lattice

SERVICE = "open-meteo"
FORECAST_URL = "https://api.open-meteo.com/v1/forecast"
ARCHIVE_URL = "https://archive-api.open-meteo.com/v1/archive"
AIR_QUALITY_URL = "https://air-quality-api.open-meteo.com/v1/air-quality"

HOURLY_VARIABLES = VARIABLES
ARCHIVE_LAG = timedelta(days=5)  # hours older than now - this come from the archive
FORECAST_TTL_S = 3600
MAX_RETRIES = 5  # on HTTP 429, sleeping 1, 2, 4, 8, 16 s
MAX_PAST_DAYS, MAX_FORECAST_DAYS = 92, 16  # Open-Meteo limits
_COMMON = {"wind_speed_unit": "ms", "timezone": "GMT"}


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware (UTC)")
    return dt.astimezone(UTC)


def _get(url: str, params: dict, sleep: Callable[[float], None]) -> bytes:
    """GET with exponential backoff on 429. Anything else non-200 raises at once."""
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = httpx.get(url, params=params, timeout=120)
        except httpx.HTTPError as exc:
            raise UpstreamError(SERVICE, f"request failed: {exc}") from exc
        if resp.status_code == 200:
            return resp.content
        if resp.status_code != 429:
            raise UpstreamError(SERVICE, f"HTTP {resp.status_code} from {url}")
        if attempt < MAX_RETRIES:
            sleep(2**attempt)
    raise UpstreamError(SERVICE, f"HTTP 429 from {url} after {MAX_RETRIES} retries")


def _cached_json(url: str, params: dict, ttl_s: float | None, sleep) -> list | dict:
    key = url + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))
    raw = cached_bytes("openmeteo", key, lambda: _get(url, params, sleep), ttl_s)
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise UpstreamError(SERVICE, f"unparseable response from {url}") from exc


def _series(hourly: dict, name: str, start: datetime, hours: int) -> np.ndarray:
    """One variable placed on `start + h` hours; NaN for nulls and hours the reply lacks."""
    out = np.full(hours, np.nan, dtype=np.float32)
    start64 = np.datetime64(_utc(start).replace(tzinfo=None), "m")
    times = np.array(hourly["time"], dtype="datetime64[m]")
    idx = ((times - start64) // np.timedelta64(1, "h")).astype(int)
    values = np.array([np.nan if v is None else v for v in hourly.get(name, [None] * len(idx))],
                      dtype=np.float32)
    keep = (idx >= 0) & (idx < hours)
    out[idx[keep]] = values[keep]
    return out


def _parse_batch(body, start: datetime, hours: int) -> dict[str, np.ndarray]:
    """Per-variable (hours, n_points) float32 from a bare object or a list of objects."""
    items = body if isinstance(body, list) else [body]
    for item in items:
        if not isinstance(item, dict) or "hourly" not in item:
            reason = item.get("reason") if isinstance(item, dict) else None
            raise UpstreamError(SERVICE, f"no hourly data in reply ({reason or 'unexpected shape'})")
    return {
        name: np.stack([_series(i["hourly"], name, start, hours) for i in items], axis=1)
        for name in HOURLY_VARIABLES
    }


def _fetch_segment(url, extra, start, hours, lon_flat, lat_flat, ttl_s, sleep):
    """Fetch one contiguous stretch of hours for every lattice point, in batches."""
    out = {n: np.full((hours, len(lon_flat)), np.nan, dtype=np.float32) for n in HOURLY_VARIABLES}
    for a in range(0, len(lon_flat), MET_BATCH):
        b = min(a + MET_BATCH, len(lon_flat))
        params = {
            "latitude": ",".join(str(float(v)) for v in lat_flat[a:b]),
            "longitude": ",".join(str(float(v)) for v in lon_flat[a:b]),
            "hourly": ",".join(HOURLY_VARIABLES), **_COMMON, **extra,
        }
        parsed = _parse_batch(_cached_json(url, params, ttl_s, sleep), start, hours)
        for name in HOURLY_VARIABLES:
            if parsed[name].shape[1] != b - a:
                raise UpstreamError(SERVICE, "reply has the wrong number of points")
            out[name][:, a:b] = parsed[name]
    return out


def fetch_met(
    start: datetime, hours: int, now: datetime, sleep: Callable[[float], None] = time.sleep
) -> MetRaw:
    """Hourly met on the 1 degree lattice for `hours` hours from `start` (UTC, on the hour).

    Hours strictly older than `now - 5 days` come from the archive (immutable, cached forever),
    the rest from the forecast endpoint (cached one hour); the two are stitched into one series.
    """
    start, now = _utc(start), _utc(now)
    lon, lat = lattice()
    lon_flat, lat_flat = np.meshgrid(lon, lat)  # lat-major: index = lat_i * NLON + lon_j
    lon_flat, lat_flat = lon_flat.ravel(), lat_flat.ravel()

    n_arch = min(max(math.ceil((now - ARCHIVE_LAG - start) / timedelta(hours=1)), 0), hours)
    parts = []
    if n_arch > 0:
        d0 = start.date()
        d1 = (start + timedelta(hours=n_arch - 1)).date()
        extra = {"start_date": d0.isoformat(), "end_date": d1.isoformat()}
        parts.append((0, n_arch, ARCHIVE_URL, extra, None))
    if n_arch < hours:
        first = (start + timedelta(hours=n_arch)).date()
        last = (start + timedelta(hours=hours - 1)).date()
        today: date = now.date()
        past = min(max((today - first).days, 0), MAX_PAST_DAYS)
        ahead = min(max((last - today).days + 1, 1), MAX_FORECAST_DAYS)
        extra = {"past_days": past, "forecast_days": ahead}
        parts.append((n_arch, hours - n_arch, FORECAST_URL, extra, FORECAST_TTL_S))

    variables = {n: np.full((hours, len(lon_flat)), np.nan, dtype=np.float32)
                 for n in HOURLY_VARIABLES}
    for offset, count, url, extra, ttl_s in parts:
        seg_start = start + timedelta(hours=offset)
        seg = _fetch_segment(url, extra, seg_start, count, lon_flat, lat_flat, ttl_s, sleep)
        for name in HOURLY_VARIABLES:
            variables[name][offset:offset + count] = seg[name]
    return MetRaw(
        start, hours, lon, lat,
        {n: a.reshape(hours, NLAT, NLON) for n, a in variables.items()},
    )


def fetch_cams_pm25(
    lat: float, lon: float, start: datetime, hours: int,
    sleep: Callable[[float], None] = time.sleep,
) -> np.ndarray:
    """CAMS hourly PM2.5 (ug/m3) at one point for `hours` hours from `start`; NaN where null."""
    start = _utc(start)
    end = start + timedelta(hours=max(hours - 1, 0))
    params = {
        "latitude": lat, "longitude": lon, "hourly": "pm2_5", "timezone": "GMT",
        "start_date": start.date().isoformat(), "end_date": end.date().isoformat(),
    }
    settled = end < datetime.now(UTC) - ARCHIVE_LAG
    body = _cached_json(AIR_QUALITY_URL, params, None if settled else FORECAST_TTL_S, sleep)
    if not isinstance(body, dict) or "hourly" not in body:
        raise UpstreamError(SERVICE, "no hourly data in air-quality reply")
    return _series(body["hourly"], "pm2_5", start, hours)
