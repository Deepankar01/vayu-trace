"""data.gov.in: CPCB real-time AQI feed (resource 3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69).

Records are one per station per pollutant. Fields used: `city`, `station`, `pollutant_id`
("PM2.5"), `pollutant_avg` (the feed's older spelling `avg_value` is accepted too) and
`last_update` ("dd-mm-YYYY HH:MM:SS", Indian time). "NA" means missing.

The API key is a query parameter, so no URL is ever cached, logged or put in an error message.
"""
import json
from datetime import datetime, timedelta

import httpx

from vayu import config
from vayu.cache import cached_bytes
from vayu.cities import City
from vayu.errors import UpstreamError

SERVICE = "data.gov.in"
URL = "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69"
POLLUTANT = "PM2.5"
PAGE_LIMIT = 1000
MAX_PAGES = 20
STALE_AFTER = timedelta(hours=6)  # records this far behind the feed's newest are not "live"
REQUIRED_KEYS = ("city", "station", "pollutant_id", "last_update")
TTL_S = 15 * 60
TIMEOUT_S = 120  # the service is slow
VALUE_MAX = 2000.0  # ug/m3; larger or negative readings are not plausible PM2.5

# Spellings the feed may use for our city names (lowercase). Matching is case-insensitive on
# the feed's `city` field; these cover well-known renamings. Unverified against a live reply:
# the feed was unreachable when this was written.
ALIASES: dict[str, tuple[str, ...]] = {
    "gurugram": ("gurgaon",),
    "prayagraj": ("allahabad",),
    "bengaluru": ("bangalore",),
}


def _fetch_page(offset: int) -> bytes:
    params = {
        "api-key": config.data_gov_in_api_key(), "format": "json", "limit": PAGE_LIMIT,
        "offset": offset, "filters[pollutant_id]": POLLUTANT,
    }
    try:
        resp = httpx.get(URL, params=params, timeout=TIMEOUT_S)
    except httpx.HTTPError as exc:
        # str(exc) may quote the URL, which holds the key: describe the failure by type only
        raise UpstreamError(SERVICE, f"request failed ({type(exc).__name__})") from None
    if resp.status_code != 200:
        raise UpstreamError(SERVICE, f"HTTP {resp.status_code}")
    return resp.content


def _records(raw: bytes) -> tuple[list[dict], int | None]:
    """(records, total) from one page. An error payload served with HTTP 200 raises."""
    try:
        body = json.loads(raw)
    except ValueError as exc:
        raise UpstreamError(SERVICE, "unparseable reply") from exc
    if not isinstance(body, dict) or body.get("error") or body.get("status") == "error":
        raise UpstreamError(SERVICE, "error payload in reply")
    records = body.get("records")
    if not isinstance(records, list) or not all(isinstance(r, dict) for r in records):
        raise UpstreamError(SERVICE, "reply has no records list")
    try:
        total = int(body["total"])
    except (KeyError, TypeError, ValueError):
        total = None
    return records, total


def _avg_field(rec: dict):
    return rec["pollutant_avg"] if "pollutant_avg" in rec else rec.get("avg_value")


def _number(text) -> float | None:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None  # "NA", empty, missing
    return value if 0.0 <= value <= VALUE_MAX else None  # also rejects NaN


def _stamp(text) -> datetime | None:
    try:
        return datetime.strptime(text, "%d-%m-%Y %H:%M:%S")
    except (TypeError, ValueError):
        return None


def _check_schema(records: list[dict]) -> None:
    """Fail loudly if the feed no longer looks like the one this client understands.

    Without this a renamed field, an ignored filter or a changed date format would read as
    "no data" for every city. After it, None from `live_pm25` means "no valid record for this
    city while the feed is healthy".
    """
    if not records:
        raise UpstreamError(SERVICE, "feed returned no PM2.5 records")
    for rec in records:
        missing = [k for k in REQUIRED_KEYS if k not in rec]
        if missing or ("pollutant_avg" not in rec and "avg_value" not in rec):
            raise UpstreamError(SERVICE, f"record lacks expected fields {missing or ['pollutant_avg']}")
    pm25 = [r for r in records if str(r["pollutant_id"]).strip().upper() == POLLUTANT]
    if not any(_number(_avg_field(r)) is not None and _stamp(r["last_update"]) is not None
               for r in pm25):
        raise UpstreamError(
            SERVICE, "no record has both a numeric PM2.5 average and a parseable last_update")


def _all_records() -> bytes:
    """Every PM2.5 record of the feed, paged by the feed's own `total`, validated, as JSON."""
    out: list[dict] = []
    total: int | None = None
    for _ in range(MAX_PAGES):
        records, page_total = _records(_fetch_page(len(out)))
        if total is None:
            total = page_total
            if total is None:
                raise UpstreamError(SERVICE, "reply has no total")
        if not records and len(out) < total:
            raise UpstreamError(SERVICE, f"feed ended at {len(out)} of {total} records")
        out.extend(records)
        if len(out) >= total:
            break
    else:
        raise UpstreamError(SERVICE, f"more than {MAX_PAGES} pages; stopped at {len(out)}")
    _check_schema(out)
    return json.dumps({"records": out}).encode()


def live_pm25(city: City) -> float | None:
    """Mean over the city's stations of each station's latest published PM2.5 average, ug/m3.

    What the number is: the feed's `pollutant_avg` for PM2.5, as CPCB publishes it with the
    min and max for the same record. The feed's field description does not state the averaging
    period and we could not read it (the service was down), so treat it as "CPCB's published
    PM2.5 average for the latest update", NOT a verified hourly or 24-hour mean. It is a live
    indicator only; the hourly measurements used for comparison come from OpenAQ.

    Stations are matched by the feed's `city` field, case-insensitively, also under the aliases
    in `ALIASES`. Only a station's LATEST record counts: if that is "NA" the station is
    missing (no fallback to an older one). Records more than 6 hours older than the newest
    `last_update` in the feed, and records without a station name, are ignored. The feed is
    schema-checked before it is cached, so None means this city has no valid record while the
    feed is healthy; a broken feed raises UpstreamError. Cached 15 minutes (one shared copy of
    the whole feed's PM2.5 records).
    """
    raw = cached_bytes("datagov", f"pm25:{PAGE_LIMIT}", _all_records, TTL_S)
    records = _records(raw)[0]
    stamps = [t for r in records if (t := _stamp(r.get("last_update"))) is not None]
    if not stamps:
        raise UpstreamError(SERVICE, "cached feed has no parseable last_update")
    cutoff = max(stamps) - STALE_AFTER
    names = {city.name.lower(), city.id, *ALIASES.get(city.id, ())}
    latest: dict[str, tuple[datetime, float | None]] = {}
    for rec in records:
        if str(rec.get("city", "")).strip().lower() not in names:
            continue
        if str(rec.get("pollutant_id", "")).strip().upper() != POLLUTANT:
            continue
        station = str(rec.get("station", "")).strip()
        when = _stamp(rec.get("last_update"))
        if not station or when is None or when < cutoff:
            continue
        if station not in latest or when >= latest[station][0]:
            latest[station] = (when, _number(_avg_field(rec)))
    values = [v for _, v in latest.values() if v is not None]
    return sum(values) / len(values) if values else None
