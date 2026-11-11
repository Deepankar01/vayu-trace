"""OpenAQ v3: hourly CPCB PM2.5 measurements around a city. Missing data stays NaN.

Facts verified against the live API on 2026-11-11:
- The key travels in the `X-API-Key` header, never in a URL (so never in a cache key).
- `/locations?coordinates=lat,lon&radius=m` (radius <= 25000) lists locations; CPCB-fed ones have
  `provider.name == "CPCB"` and a sensor whose `parameter.name == "pm25"`. A location can carry
  two pm25 sensors (a legacy one and a newer one covering different years), and one physical
  site can appear as two locations 0 m apart; locations within 300 m are merged into one station.
- `/sensors/{id}/hours` returns one-hour averages. CPCB reports on the Indian clock, so real
  periods run [HH:30, HH+1:30) UTC.
- Alignment: output index h is the mean over [start + h, start + h + 1) UTC, built as the
  overlap-weighted mean of the periods overlapping that hour (for :30 periods, the mean of the
  two straddling periods; whole-hour periods map directly). If any needed period is missing or
  invalid, the hour is NaN; nothing is filled from one side. One extra hour is fetched on each
  side of the window so edge hours are complete.
- Rate limit headers: `x-ratelimit-limit` (60), `x-ratelimit-remaining`, `x-ratelimit-reset`
  (seconds until the window resets).
- COVERAGE GAP: the CPCB-provider PM2.5 history in OpenAQ for Delhi runs to about Oct 2022 and
  starts again on 2025-02-18; dates in between return no measurements (all NaN, station_count 0).
  The `caaqm` provider is deliberately not used: its Delhi sensors also end by 2022-10-31 and it
  would duplicate sites. See docs/data-notes.md, "Measured data coverage".
"""
import json
import math
import time
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
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
MAX_WAIT_S = 120.0
EMPTY_DISCOVERY_TTL_S = 3600  # an empty locations reply may be a glitch: do not pin it
EMPTY_HOURS_TTL_S = 24 * 3600  # OpenAQ holes can be backfilled: an empty window is never final
MERGE_M = 300.0  # locations this close are one physical site
HOUR = timedelta(hours=1)
SPAN_WORKERS = 8  # parallel /sensors/{id} lookups (well inside the 60 requests/minute limit)


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
        wait = float(resp.headers["x-ratelimit-reset"])
    except (KeyError, ValueError):
        return DEFAULT_RESET_S
    if not math.isfinite(wait):
        return DEFAULT_RESET_S
    return min(max(wait, 1.0), MAX_WAIT_S)


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
    found = (body.get("meta") or {}).get("found") if isinstance(body.get("meta"), dict) else None
    digits = "".join(ch for ch in str(found) if ch.isdigit()) if found is not None else ""
    if digits and int(digits) > len(results):
        raise UpstreamError(
            SERVICE, f"truncated {what} reply: {len(results)} of {found} results returned")
    return results


def _validated(path: str, params: dict, what: str, sleep) -> Callable[[], bytes]:
    """Fetch that checks the body before it can reach the cache."""
    def fetch() -> bytes:
        raw = _get(path, params, sleep)
        _results(raw, what)
        return raw
    return fetch


class _Miss(Exception):
    pass


def _raise_miss() -> bytes:
    raise _Miss


def _cached_unless_empty(key, fetch, ttl_s, empty_ttl_s, what, stable_prefix="") -> list[dict]:
    """Results of `fetch`, cached `ttl_s` when non-empty but at most `empty_ttl_s` when empty."""
    main = f"{stable_prefix}{key}"
    try:
        return _results(cached_bytes("openaq", main, _raise_miss, ttl_s), what)
    except _Miss:
        pass

    def fetch_and_promote() -> bytes:
        raw = fetch()
        if _results(raw, what):
            cached_bytes("openaq", main, lambda: raw, ttl_s)
        return raw

    return _results(
        cached_bytes("openaq", f"empty-ok:{main}", fetch_and_promote, empty_ttl_s), what)


def _haversine_m(lat1: float, lon1: float, lat2: float, lon2: float) -> float:
    p1, p2 = math.radians(lat1), math.radians(lat2)
    a = (math.sin((p2 - p1) / 2) ** 2
         + math.cos(p1) * math.cos(p2) * math.sin(math.radians(lon2 - lon1) / 2) ** 2)
    return 2 * 6_371_000 * math.asin(math.sqrt(a))


def stations_near(city: City, sleep: Callable[[float], None] = time.sleep) -> list[Station]:
    """CPCB-provider stations within 25 km with a pm25 sensor, nearest first.

    Locations within 300 m of an already-listed (nearer) one are merged into it: one physical
    site must not enter the median twice. Cached 7 days (1 hour if the reply was empty).
    """
    params = {"coordinates": f"{city.lat},{city.lon}", "radius": RADIUS_M, "limit": 1000}
    results = _cached_unless_empty(
        f"locations:{city.lat},{city.lon}:{RADIUS_M}",
        _validated("/locations", params, "locations", sleep),
        DISCOVERY_TTL_S, EMPTY_DISCOVERY_TTL_S, "locations")
    found = []
    for loc in results:
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
        found.append((
            dist, coords["latitude"], coords["longitude"],
            Station(loc["id"], str(loc.get("name", "")), dist, sensors,
                    _parse_ts((loc.get("datetimeFirst") or {}).get("utc")),
                    _parse_ts((loc.get("datetimeLast") or {}).get("utc"))),
        ))
    found.sort(key=lambda t: t[0])
    kept: list[tuple[float, float, Station]] = []
    out: list[Station] = []
    for _dist, lat, lon, st in found:
        for i, (klat, klon, ks) in enumerate(kept):
            if _haversine_m(lat, lon, klat, klon) <= MERGE_M:
                firsts = [t for t in (ks.first, st.first) if t]
                lasts = [t for t in (ks.last, st.last) if t]
                out[i] = Station(ks.id, ks.name, ks.distance_m,
                                 ks.sensor_ids + tuple(x for x in st.sensor_ids
                                                       if x not in ks.sensor_ids),
                                 min(firsts) if firsts else None, max(lasts) if lasts else None)
                break
        else:
            kept.append((lat, lon, st))
            out.append(st)
    return out


def sensor_span(sensor_id: int, sleep: Callable[[float], None] = time.sleep
                ) -> tuple[datetime | None, datetime | None]:
    """(first, last) measurement time of one sensor, from `/sensors/{id}`. Cached 7 days (1 hour
    if the reply was empty, which gives (None, None): unknown, so the sensor is still tried).

    A location's own first/last cannot rule a window out: a station merged from co-located
    locations, or a location with a legacy and a newer pm25 sensor, spans the 2022-2025
    coverage gap even though no single sensor has data in it.
    """
    results = _cached_unless_empty(
        f"sensor:{sensor_id}", _validated(f"/sensors/{sensor_id}", {}, "sensor", sleep),
        DISCOVERY_TTL_S, EMPTY_DISCOVERY_TTL_S, "sensor")
    if not results:
        return None, None
    r = results[0]
    return (_parse_ts((r.get("datetimeFirst") or {}).get("utc")),
            _parse_ts((r.get("datetimeLast") or {}).get("utc")))


def _may_overlap(first: datetime | None, last: datetime | None,
                 start: datetime, end: datetime) -> bool:
    """False only when data from [first, last] provably cannot reach [start, end). `last` comes
    from a cache up to 7 days old, so it is only trusted past that staleness."""
    if last is not None and last + timedelta(seconds=DISCOVERY_TTL_S) < start:
        return False
    return not (first is not None and first >= end)


def _hours_raw(sensor_id: int, t0: datetime, t1: datetime, now: datetime, sleep) -> list[dict]:
    """Hourly rows for one sensor over [t0, t1).

    A settled window (ended more than 3 days before `now`) with data is cached forever under a
    `final:` key; one that is still settling is cached 1 hour under `provisional:`. An EMPTY
    reply is never final (OpenAQ may backfill holes): it lives 24 hours at most.
    """
    final = t1 < now - FINAL_AFTER
    params = {"datetime_from": _iso(t0), "datetime_to": _iso(t1), "limit": 1000}
    key = f"hours:{sensor_id}:{params['datetime_from']}:{params['datetime_to']}"
    fetch = _validated(f"/sensors/{sensor_id}/hours", params, "hours", sleep)
    if final:
        return _cached_unless_empty(key, fetch, None, EMPTY_HOURS_TTL_S, "hours", "final:")
    return _results(cached_bytes("openaq", "provisional:" + key, fetch, PROVISIONAL_TTL_S), "hours")


def _place(rows: list[dict], start: datetime, hours: int) -> np.ndarray:
    """Hour means on [start + h, start + h + 1) from overlapping one-hour periods.

    Each valid period contributes value * overlap to the hours it overlaps; an hour whose
    overlapping valid periods do not cover all 3600 s (a missing, invalid or absurd neighbour)
    is NaN. Rows whose interval is not 01:00:00 are ignored; a period seen twice counts once.
    """
    num = np.zeros(hours)
    cover = np.zeros(hours)
    seen: set[datetime] = set()
    for row in rows:
        period = row.get("period") or {}
        if period.get("interval") != "01:00:00":
            continue
        t = _parse_ts((period.get("datetimeFrom") or {}).get("utc"))
        value = row.get("value")
        if t is None or t in seen or isinstance(value, bool) or not isinstance(value, int | float):
            continue
        seen.add(t)
        if not 0.0 <= value <= VALUE_MAX:
            continue
        a = (t - start).total_seconds()
        for h in range(math.floor(a / 3600), math.floor((a + 3600 - 1) / 3600) + 1):
            if 0 <= h < hours:
                overlap = min(a + 3600, (h + 1) * 3600) - max(a, h * 3600)
                num[h] += value * overlap
                cover[h] += overlap
    out = np.full(hours, np.nan, dtype=np.float32)
    full = cover >= 3600 - 1e-6
    out[full] = num[full] / cover[full]
    return out


def _sensor_series(sensor_id, start, hours, now, sleep) -> np.ndarray:
    out = np.full(hours, np.nan, dtype=np.float32)
    for off in range(0, hours, CHUNK_HOURS):
        n = min(CHUNK_HOURS, hours - off)
        t0 = start + off * HOUR
        # one extra hour each side: straddling :30 periods must be complete at the edges
        rows = _hours_raw(sensor_id, t0 - HOUR, t0 + (n + 1) * HOUR, now, sleep)
        out[off:off + n] = _place(rows, t0, n)
    return out


def city_pm25(
    city: City, start: datetime, hours: int,
    now: datetime | None = None, sleep: Callable[[float], None] = time.sleep,
) -> MeasuredSeries:
    """Hourly median PM2.5 (ug/m3, CPCB via OpenAQ) over up to 5 stations within 25 km of `city`.

    `start` is tz-aware UTC on a whole hour. Index h is the mean over [start + h, start + h + 1)
    UTC, an overlap-weighted mean of CPCB's one-hour periods (see the module docstring); an hour
    that cannot be built from complete periods is NaN, never zero and never interpolated.
    Stations are tried nearest first; only stations with at least one valid value in the window
    count towards `station_count` (a location that reported nothing then is skipped, up to 15
    tried). A station's sensors are merged, the first valid value per hour winning, and the
    median is taken per hour over the stations that have a value.

    Hourly data is requested only for sensors whose own availability (`sensor_span`) can overlap
    the window; when none can, no hourly request is made at all.
    """
    start = _utc(start)
    if start.minute or start.second or start.microsecond:
        raise ValueError("start must be on a whole hour")
    if hours <= 0:
        raise ValueError("hours must be positive")
    now = _utc(now) if now is not None else _now()
    end = start + hours * HOUR
    candidates = [st for st in stations_near(city, sleep)
                  if _may_overlap(st.first, st.last, start, end)][:MAX_CANDIDATES]
    sids = list(dict.fromkeys(s for st in candidates for s in st.sensor_ids))
    with ThreadPoolExecutor(SPAN_WORKERS) as pool:
        spans = dict(zip(sids, pool.map(lambda sid: sensor_span(sid, sleep), sids)))
    used: list[np.ndarray] = []
    for st in candidates:
        if len(used) == MAX_STATIONS:
            break
        live = [sid for sid in st.sensor_ids if _may_overlap(*spans[sid], start, end)]
        if not live:
            continue
        series = np.full(hours, np.nan, dtype=np.float32)
        for sid in live:
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
