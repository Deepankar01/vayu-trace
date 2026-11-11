"""OpenAQ v3: hourly CPCB PM2.5 measurements around a city. Missing data stays NaN.

Facts verified against the live API on 2026-11-11:
- The key travels in the `X-API-Key` header, never in a URL (so never in a cache key).
- `/locations?coordinates=lat,lon&radius=m` (radius <= 25000) lists locations; CPCB-fed ones have
  `provider.name == "CPCB"` and a sensor whose `parameter.name == "pm25"`. A location can carry
  two pm25 sensors (a legacy one and a newer one covering different years).
- `/sensors/{id}/hours` returns one-hour averages. CPCB reports hours on the Indian clock, so the
  periods run :30 to :30 UTC. We label each value by the UTC hour its period *starts* in
  (floor of `period.datetimeFrom.utc`): index h covers [start + h, start + h + 1) in the sense that
  the averaging window begins inside that hour. That is up to 30 minutes of skew, never more.
- Rate limit headers: `x-ratelimit-limit` (60), `x-ratelimit-remaining`, `x-ratelimit-reset`
  (seconds until the window resets).
- OpenAQ's CPCB-provider history has a hole: Delhi's older sensors end in 2022 and the current
  ones begin in 2025, so a window in between has no stations with data (all NaN, count 0).
"""
import json
import math
import time
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, datetime, timedelta

import httpx
import numpy as np

from vayu import config
from vayu.cache import cached_bytes
from vayu.cities import City
from vayu.errors import UpstreamError

SERVICE = "openaq"
BASE_URL = "https://api.openaq.org/v3"
PROVIDER = "CPCB"
PARAMETER = "pm25"
RADIUS_M = 25_000  # OpenAQ's maximum search radius
MAX_STATIONS = 5
MAX_CANDIDATES = 15  # stations tried (nearest first) while looking for MAX_STATIONS with data
VALUE_MAX = 2000.0  # ug/m3; PM2.5 outside [0, VALUE_MAX] is a sensor error, treated as missing
DISCOVERY_TTL_S = 7 * 24 * 3600
FINAL_AFTER = timedelta(days=3)  # a window ending this long before the fetch is final
PROVISIONAL_TTL_S = 3600
CHUNK_HOURS = 720  # one request per 30 days keeps each reply under the 1000-row page limit
MAX_RETRIES = 5  # on HTTP 429, waiting for the reset the server announces
DEFAULT_RESET_S = 60.0
HOUR = timedelta(hours=1)


@dataclass(frozen=True)
class MeasuredSeries:
    values: np.ndarray  # (hours,) float32 ug/m3, NaN where no station has a value
    station_count: int  # stations that contributed at least one value (0: all NaN)


@dataclass(frozen=True)
class Station:
    id: int
    name: str
    distance_m: float
    sensor_ids: tuple[int, ...]  # pm25 sensors
    first: datetime | None
    last: datetime | None


def _now() -> datetime:
    return datetime.now(UTC)


def _utc(dt: datetime) -> datetime:
    if dt.tzinfo is None:
        raise ValueError("datetime must be timezone-aware (UTC)")
    return dt.astimezone(UTC)


def _iso(dt: datetime) -> str:
    return dt.strftime("%Y-%m-%dT%H:%M:%SZ")


def _parse_ts(text) -> datetime | None:
    if not isinstance(text, str):
        return None
    try:
        return datetime.fromisoformat(text).astimezone(UTC)
    except ValueError:
        return None


def _wait_s(resp: httpx.Response) -> float:
    try:
        return max(float(resp.headers["x-ratelimit-reset"]), 1.0)
    except (KeyError, ValueError):
        return DEFAULT_RESET_S


def _get(path: str, params: dict, sleep: Callable[[float], None]) -> bytes:
    """GET with the key in a header. 401 fails at once; 429 waits for the reset, then retries."""
    url = BASE_URL + path
    headers = {"X-API-Key": config.openaq_api_key()}
    for attempt in range(MAX_RETRIES + 1):
        try:
            resp = httpx.get(url, params=params, headers=headers, timeout=60)
        except httpx.HTTPError as exc:
            raise UpstreamError(SERVICE, f"request failed: {exc}") from exc
        if resp.status_code == 200:
            if resp.headers.get("x-ratelimit-remaining") == "0":
                sleep(_wait_s(resp))  # spend nothing more until the window resets
            return resp.content
        if resp.status_code == 401:
            raise UpstreamError(SERVICE, "HTTP 401: the OpenAQ API key was rejected")
        if resp.status_code != 429:
            raise UpstreamError(SERVICE, f"HTTP {resp.status_code} from {path}")
        if attempt < MAX_RETRIES:
            sleep(_wait_s(resp))
    raise UpstreamError(SERVICE, f"HTTP 429 from {path} after {MAX_RETRIES} retries")


def _results(raw: bytes, what: str) -> list[dict]:
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise UpstreamError(SERVICE, f"unparseable {what} reply") from exc
    results = body.get("results") if isinstance(body, dict) else None
    if not isinstance(results, list) or not all(isinstance(r, dict) for r in results):
        raise UpstreamError(SERVICE, f"unexpected {what} reply (no results list)")
    return results


def _validated(path: str, params: dict, what: str, sleep) -> Callable[[], bytes]:
    """Fetch that checks the body before it can reach the cache."""
    def fetch() -> bytes:
        raw = _get(path, params, sleep)
        _results(raw, what)
        return raw
    return fetch


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


def stations_near(city: City, sleep: Callable[[float], None] = time.sleep) -> list[Station]:
    """CPCB-provider locations within 25 km with a pm25 sensor, nearest first (cached 7 days)."""
    params = {"coordinates": f"{city.lat},{city.lon}", "radius": RADIUS_M, "limit": 1000}
    key = f"locations:{city.lat},{city.lon}:{RADIUS_M}"
    raw = cached_bytes("openaq", key, _validated("/locations", params, "locations", sleep),
                       DISCOVERY_TTL_S)
    out = []
    for loc in _results(raw, "locations"):
        if (loc.get("provider") or {}).get("name") != PROVIDER:
            continue
        sensors = tuple(
            s["id"] for s in loc.get("sensors") or []
            if (s.get("parameter") or {}).get("name") == PARAMETER
        )
        coords = loc.get("coordinates") or {}
        if not sensors or "latitude" not in coords or "longitude" not in coords:
            continue
        dist = _haversine_m(city.lat, city.lon, coords["latitude"], coords["longitude"])
        out.append(Station(
            loc["id"], str(loc.get("name", "")), dist, sensors,
            _parse_ts((loc.get("datetimeFirst") or {}).get("utc")),
            _parse_ts((loc.get("datetimeLast") or {}).get("utc")),
        ))
    out.sort(key=lambda s: s.distance_m)
    return out


def _hours_raw(sensor_id: int, t0: datetime, t1: datetime, now: datetime, sleep) -> list[dict]:
    """Hourly rows for one sensor over [t0, t1); settled windows are cached forever."""
    final = t1 < now - FINAL_AFTER
    params = {"datetime_from": _iso(t0), "datetime_to": _iso(t1), "limit": 1000}
    key = f"hours:{sensor_id}:{params['datetime_from']}:{params['datetime_to']}"
    # finality is part of the key: a provisional reply is never promoted to the immutable entry
    raw = cached_bytes(
        "openaq", f"{'final' if final else 'provisional'}:{key}",
        _validated(f"/sensors/{sensor_id}/hours", params, "hours", sleep),
        None if final else PROVISIONAL_TTL_S,
    )
    return _results(raw, "hours")


def _place(rows: list[dict], start: datetime, hours: int) -> np.ndarray:
    """Place hourly rows on `start + h`; invalid, absurd or foreign-interval rows stay NaN."""
    out = np.full(hours, np.nan, dtype=np.float32)
    for row in rows:
        period = row.get("period") or {}
        if period.get("interval") != "01:00:00":
            continue
        t = _parse_ts((period.get("datetimeFrom") or {}).get("utc"))
        value = row.get("value")
        if t is None or isinstance(value, bool) or not isinstance(value, int | float):
            continue
        if not 0.0 <= value <= VALUE_MAX:
            continue
        idx = int((t.replace(minute=0, second=0, microsecond=0) - start) // HOUR)
        if 0 <= idx < hours:
            out[idx] = value
    return out


def _sensor_series(sensor_id, start, hours, now, sleep) -> np.ndarray:
    out = np.full(hours, np.nan, dtype=np.float32)
    for off in range(0, hours, CHUNK_HOURS):
        n = min(CHUNK_HOURS, hours - off)
        t0 = start + off * HOUR
        # pad by an hour each side: a period starts at :30 and may straddle the chunk edge
        rows = _hours_raw(sensor_id, t0 - HOUR, t0 + (n + 1) * HOUR, now, sleep)
        out[off:off + n] = _place(rows, t0, n)
    return out


def city_pm25(
    city: City, start: datetime, hours: int,
    now: datetime | None = None, sleep: Callable[[float], None] = time.sleep,
) -> MeasuredSeries:
    """Hourly median PM2.5 (ug/m3, CPCB via OpenAQ) over up to 5 stations within 25 km of `city`.

    `start` is tz-aware UTC on a whole hour; index h is labelled by the UTC hour in which the
    one-hour averaging period begins (see the module docstring). An hour with no station value
    is NaN, never zero and never interpolated. Stations are tried nearest first; only stations
    with at least one valid value in the window count towards `station_count` (a location that
    reported nothing then is skipped, up to 15 tried). A station's legacy and current pm25
    sensors are merged, the first valid value per hour winning.
    """
    start = _utc(start)
    if start.minute or start.second or start.microsecond:
        raise ValueError("start must be on a whole hour")
    now = _utc(now) if now is not None else _now()
    end = start + hours * HOUR
    used: list[np.ndarray] = []
    tried = 0
    for st in stations_near(city, sleep):
        if len(used) == MAX_STATIONS or tried == MAX_CANDIDATES:
            break
        if (st.last and st.last < start) or (st.first and st.first >= end):
            continue  # the station's whole record lies outside the window
        tried += 1
        series = np.full(hours, np.nan, dtype=np.float32)
        for sid in st.sensor_ids:
            s = _sensor_series(sid, start, hours, now, sleep)
            series = np.where(np.isnan(series), s, series)
        if np.isfinite(series).any():
            used.append(series)
    values = np.full(hours, np.nan, dtype=np.float32)
    if used:
        stack = np.stack(used)
        has = np.isfinite(stack).any(axis=0)
        values[has] = np.nanmedian(stack[:, has], axis=0)
    return MeasuredSeries(values, len(used))
