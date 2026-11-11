"""data.gov.in: CPCB real-time AQI feed (resource 3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69).

Records are one per station per pollutant. Fields used: `city`, `station`, `pollutant_id`
("PM2.5"), `pollutant_avg` (the feed's older spelling `avg_value` is accepted too) and
`last_update` ("dd-mm-YYYY HH:MM:SS", Indian time). "NA" means missing.

The API key is a query parameter, so no URL is ever cached, logged or put in an error message.
"""
import json
from datetime import datetime

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
TTL_S = 15 * 60
TIMEOUT_S = 120  # the service is slow
VALUE_MAX = 2000.0  # ug/m3; larger or negative readings are not plausible PM2.5

# Spellings the feed may use for our city names (lowercase). Matching is case-insensitive on
# the feed's `city` field; these cover well-known renamings. Unverified against a live reply
# (see the task report): the feed was unreachable when this was written.
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


def _all_records() -> bytes:
    """Every PM2.5 record of the feed, paged and validated, as one JSON document."""
    out: list[dict] = []
    for page in range(MAX_PAGES):
        records, total = _records(_fetch_page(page * PAGE_LIMIT))
        out.extend(records)
        if len(records) < PAGE_LIMIT or (total is not None and len(out) >= total):
            break
    return json.dumps({"records": out}).encode()


def _number(text) -> float | None:
    try:
        value = float(text)
    except (TypeError, ValueError):
        return None  # "NA", empty, missing
    return value if 0.0 <= value <= VALUE_MAX else None  # also rejects NaN


def _stamp(text) -> datetime:
    try:
        return datetime.strptime(text, "%d-%m-%Y %H:%M:%S")
    except (TypeError, ValueError):
        return datetime.min


def live_pm25(city: City) -> float | None:
    """Mean over the city's stations of each station's latest published PM2.5 average, ug/m3.

    What the number is: the feed's `pollutant_avg` for PM2.5, as CPCB publishes it with the
    min and max for the same record. The feed's field description does not state the averaging
    period and we could not read it (the service was down), so treat it as "CPCB's published
    PM2.5 average for the latest update", NOT a verified hourly or 24-hour mean. It is a live
    indicator only; the hourly measurements used for comparison come from OpenAQ.

    Stations are matched by the feed's `city` field, case-insensitively, also under the aliases
    in `ALIASES`. A station's records with "NA" are skipped; the latest `last_update` among
    its valid records counts. Returns None when no station of the city has a valid value.
    Cached 15 minutes (one shared copy of the whole feed's PM2.5 records).
    """
    raw = cached_bytes("datagov", f"pm25:{PAGE_LIMIT}", _all_records, TTL_S)
    names = {city.name.lower(), city.id, *ALIASES.get(city.id, ())}
    latest: dict[str, tuple[datetime, float]] = {}
    for rec in _records(raw)[0]:
        if str(rec.get("city", "")).strip().lower() not in names:
            continue
        if str(rec.get("pollutant_id", "")).strip().upper() != POLLUTANT:
            continue
        value = _number(rec.get("pollutant_avg", rec.get("avg_value")))
        if value is None:
            continue
        station = str(rec.get("station", ""))
        when = _stamp(rec.get("last_update"))
        if station not in latest or when >= latest[station][0]:
            latest[station] = (when, value)
    if not latest:
        return None
    return sum(v for _, v in latest.values()) / len(latest)
