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
ARCHIVE_FINAL_AFTER = timedelta(days=10)  # reanalysis publication lag: younger days may be holes
ARCHIVE_PROVISIONAL_TTL_S = 6 * 3600
MAX_RETRIES = 5  # on HTTP 429 or a garbled 200 body, sleeping 1, 2, 4, 8, 16 s
MAX_PAST_DAYS, MAX_FORECAST_DAYS = 92, 16  # Open-Meteo limits
_COMMON = {"wind_speed_unit": "ms", "timezone": "GMT"}


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware (UTC)")
    return dt.astimezone(UTC)


class _BadBody(Exception):
    """A 200 reply whose body is not a usable Open-Meteo hourly reply (retried)."""


class _ErrorReply(_BadBody):
    """`{"error": true, "reason": ...}`: the service refused the request; retrying will not help."""


def _check_body(raw: bytes, params: dict) -> None:
    """Raise _BadBody unless `raw` is JSON shaped like a reply to `params`: an object, or a list
    of one object per requested point, each with `hourly.time` and every requested variable (a
    list, which may be all null). `{"error": true, ...}` raises _ErrorReply."""
    try:
        body = json.loads(raw)
    except ValueError:
        raise _BadBody("not JSON") from None
    if isinstance(body, dict) and body.get("error"):
        raise _ErrorReply(f"error reply ({body.get('reason') or 'no reason given'})")
    items = body if isinstance(body, list) else [body]
    n_points = len(str(params.get("latitude", "")).split(","))
    if not items or (isinstance(body, list) and n_points > 1 and len(items) != n_points):
        raise _BadBody("wrong number of points")
    wanted = [n for n in ("time", *str(params.get("hourly", "")).split(",")) if n]
    for item in items:
        hourly = item.get("hourly") if isinstance(item, dict) else None
        if not isinstance(hourly, dict):
            raise _BadBody("no hourly block")
        missing = [n for n in wanted if not isinstance(hourly.get(n), list)]
        if missing:
            raise _BadBody(f"hourly lacks {', '.join(missing)}")


def _get(url: str, params: dict, sleep: Callable[[float], None]) -> bytes:
    """GET with exponential backoff on 429 and on a 200 whose body fails `_check_body` (so an
    unusable body never reaches the cache). An error payload or any other non-200 status raises
    at once."""
    problem = "HTTP 429"
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = httpx.get(url, params=params, timeout=120)
        except httpx.HTTPError as exc:
            raise UpstreamError(SERVICE, f"request failed: {exc}") from exc
        if resp.status_code == 200:
            try:
                _check_body(resp.content, params)
                return resp.content
            except _ErrorReply as exc:
                raise UpstreamError(SERVICE, f"{exc} from {url}") from None
            except _BadBody as exc:
                problem = f"unusable reply ({exc})"
        elif resp.status_code != 429:
            raise UpstreamError(SERVICE, f"HTTP {resp.status_code} from {url}")
        else:
            problem = "HTTP 429"
        if attempt < MAX_RETRIES:
            sleep(2**attempt)
    raise UpstreamError(SERVICE, f"{problem} from {url} after {MAX_RETRIES} retries")


def _cache_key(url: str, params: dict) -> str:
    return url + "?" + "&".join(f"{k}={params[k]}" for k in sorted(params))


def _loads(raw: bytes, url: str) -> list | dict:
    try:
        return json.loads(raw)
    except ValueError as exc:
        raise UpstreamError(SERVICE, f"unparseable response from {url}") from exc


def _cached_json(url: str, params: dict, ttl_s: float | None, sleep) -> list | dict:
    raw = cached_bytes("openmeteo", _cache_key(url, params),
                       lambda: _get(url, params, sleep), ttl_s)
    return _loads(raw, url)


class _Miss(Exception):
    pass


def _raise_miss() -> bytes:
    raise _Miss


def _archive_has_holes(data: bytes) -> bool:
    """True if any variable except boundary_layer_height (null for whole years) has a null."""
    try:
        body = json.loads(data)
    except ValueError:
        return True
    for item in body if isinstance(body, list) else [body]:
        hourly = item.get("hourly", {}) if isinstance(item, dict) else {}
        for name, values in hourly.items():
            if name not in ("time", "boundary_layer_height") and any(v is None for v in values):
                return True
    return False


def _archive_json(url: str, params: dict, may_be_final: bool, sleep) -> list | dict:
    """Archive reply, cached immutably only when final; provisional ones live 6 h under another key.

    Final needs the last requested day to be 10+ days old (`may_be_final`) and no nulls in any
    variable but boundary_layer_height. Finality is part of the cache key so the two never mix.
    """
    key = _cache_key(url, params)
    try:
        return _loads(cached_bytes("openmeteo", "final:" + key, _raise_miss, None), url)
    except _Miss:
        pass

    def fetch() -> bytes:
        data = _get(url, params, sleep)
        if may_be_final and not _archive_has_holes(data):
            cached_bytes("openmeteo", "final:" + key, lambda: data, None)
        return data

    raw = cached_bytes("openmeteo", "provisional:" + key, fetch, ARCHIVE_PROVISIONAL_TTL_S)
    return _loads(raw, url)


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


def _fetch_segment(url, extra, start, hours, lon_flat, lat_flat, ttl_s, sleep, may_be_final=False):
    """Fetch one contiguous stretch of hours for every lattice point, in batches."""
    out = {n: np.full((hours, len(lon_flat)), np.nan, dtype=np.float32) for n in HOURLY_VARIABLES}
    for a in range(0, len(lon_flat), MET_BATCH):
        b = min(a + MET_BATCH, len(lon_flat))
        params = {
            "latitude": ",".join(str(float(v)) for v in lat_flat[a:b]),
            "longitude": ",".join(str(float(v)) for v in lon_flat[a:b]),
            "hourly": ",".join(HOURLY_VARIABLES), **_COMMON, **extra,
        }
        if url == ARCHIVE_URL:
            body = _archive_json(url, params, may_be_final, sleep)
        else:
            body = _cached_json(url, params, ttl_s, sleep)
        parsed = _parse_batch(body, start, hours)
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
        final = d1 <= (now - ARCHIVE_FINAL_AFTER).date()
        parts.append((0, n_arch, ARCHIVE_URL, extra, None, final))
    if n_arch < hours:
        first = (start + timedelta(hours=n_arch)).date()
        last = (start + timedelta(hours=hours - 1)).date()
        today: date = now.date()
        past = min(max((today - first).days, 0), MAX_PAST_DAYS)
        ahead = min(max((last - today).days + 1, 1), MAX_FORECAST_DAYS)
        extra = {"past_days": past, "forecast_days": ahead}
        parts.append((n_arch, hours - n_arch, FORECAST_URL, extra, FORECAST_TTL_S, False))

    variables = {n: np.full((hours, len(lon_flat)), np.nan, dtype=np.float32)
                 for n in HOURLY_VARIABLES}
    for offset, count, url, extra, ttl_s, final in parts:
        seg_start = start + timedelta(hours=offset)
        seg = _fetch_segment(url, extra, seg_start, count, lon_flat, lat_flat, ttl_s, sleep, final)
        for name in HOURLY_VARIABLES:
            variables[name][offset:offset + count] = seg[name]
    return MetRaw(
        start, hours, lon, lat,
        {n: a.reshape(hours, NLAT, NLON) for n, a in variables.items()},
    )


CAMS_VARIABLES = {"pm25": "pm2_5", "pm10": "pm10"}


def fetch_cams_pm25(
    lat: float, lon: float, start: datetime, hours: int,
    sleep: Callable[[float], None] = time.sleep, *, pollutant: str = "pm25",
) -> np.ndarray:
    """CAMS hourly PM2.5 (ug/m3) at one point for `hours` hours from `start`; NaN where null.
    `pollutant="pm10"` gives PM10 instead."""
    variable = CAMS_VARIABLES[pollutant]
    start = _utc(start)
    end = start + timedelta(hours=max(hours - 1, 0))
    params = {
        "latitude": lat, "longitude": lon, "hourly": variable, "timezone": "GMT",
        "start_date": start.date().isoformat(), "end_date": end.date().isoformat(),
    }
    settled = end < datetime.now(UTC) - ARCHIVE_LAG
    body = _cached_json(AIR_QUALITY_URL, params, None if settled else FORECAST_TTL_S, sleep)
    if not isinstance(body, dict) or "hourly" not in body:
        raise UpstreamError(SERVICE, "no hourly data in air-quality reply")
    return _series(body["hourly"], variable, start, hours)
