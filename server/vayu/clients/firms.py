"""NASA FIRMS VIIRS active-fire detections for the model domain."""
import csv
import io
from collections import Counter
from dataclasses import dataclass
from datetime import UTC, date, datetime, timedelta

import httpx
import numpy as np

from vayu import config
from vayu.cache import cached_bytes
from vayu.domain import LAT_MAX, LAT_MIN, LON_MAX, LON_MIN
from vayu.errors import UpstreamError

_BASE = "https://firms.modaps.eosdis.nasa.gov/api"
SATELLITES = ("VIIRS_SNPP", "VIIRS_NOAA20", "VIIRS_NOAA21")
DOMAIN_BBOX = (LON_MIN, LAT_MIN, LON_MAX, LAT_MAX)  # west, south, east, north (FIRMS order)

AVAILABILITY_TTL_S = 6 * 3600
RECENT_TTL_S = 3600
IMMUTABLE_AFTER_DAYS = 7
CHUNK_DAYS = 5  # FIRMS limits day_range per request; 5 keeps requests small
HISTORY_DAYS = 30
STATIC_MIN_DAYS = 20  # a 0.01 deg cell firing on this many of the previous 30 days is static
STATIC_CELL_DEG = 0.01


@dataclass
class Detections:
    lon: np.ndarray
    lat: np.ndarray
    frp_mw: np.ndarray
    acq_utc: np.ndarray  # datetime64[m]
    is_day: np.ndarray  # bool
    satellite: np.ndarray  # str

    def __len__(self) -> int:
        return len(self.lon)

    @classmethod
    def empty(cls) -> "Detections":
        return cls(
            np.empty(0), np.empty(0), np.empty(0), np.empty(0, dtype="datetime64[m]"),
            np.empty(0, dtype=bool), np.empty(0, dtype="U8"),
        )

    @classmethod
    def concat(cls, parts: list["Detections"]) -> "Detections":
        if not parts:
            return cls.empty()
        return cls(*(np.concatenate([getattr(p, f) for p in parts]) for f in
                     ("lon", "lat", "frp_mw", "acq_utc", "is_day", "satellite")))

    def select(self, mask: np.ndarray) -> "Detections":
        return Detections(self.lon[mask], self.lat[mask], self.frp_mw[mask], self.acq_utc[mask],
                          self.is_day[mask], self.satellite[mask])


def _today() -> date:
    """Today's UTC date (FIRMS days are UTC). Patched in tests."""
    return datetime.now(UTC).date()


def _get(url: str, expect_header: str) -> bytes:
    """GET `url`; error text never includes the URL because it carries the key."""
    try:
        resp = httpx.get(url, timeout=120.0)
    except httpx.HTTPError as exc:
        raise UpstreamError("firms", f"request failed ({type(exc).__name__})") from None
    if resp.status_code != 200:
        raise UpstreamError("firms", f"HTTP {resp.status_code}")
    if resp.text.strip().startswith("Invalid MAP_KEY"):
        raise UpstreamError("firms", "Invalid MAP_KEY")
    first_line = resp.text.lstrip().split("\n", 1)[0]
    if not first_line.startswith(expect_header):
        # a 200 with a non-CSV body (rate limit, bad area/date) must not look like "no fires"
        raise UpstreamError("firms", "unexpected response body (not CSV)")
    return resp.content


def availability() -> dict[str, tuple[date, date]]:
    """data_id -> (first date, last date) of FIRMS coverage."""
    url = f"{_BASE}/data_availability/csv/{config.firms_map_key()}/all"
    raw = cached_bytes("firms", "availability", lambda: _get(url, "data_id"), ttl_s=AVAILABILITY_TTL_S)
    return {
        row["data_id"]: (date.fromisoformat(row["min_date"]), date.fromisoformat(row["max_date"]))
        for row in csv.DictReader(io.StringIO(raw.decode()))
    }


def _bbox_str(bbox: tuple[float, float, float, float]) -> str:
    return ",".join(f"{v:g}" for v in bbox)


def _area_csv(product: str, bbox: tuple[float, float, float, float], start: date,
              day_range: int) -> bytes:
    """Raw CSV for `day_range` days from `start`. Cache key holds no API key."""
    bbox_s = _bbox_str(bbox)
    last = start + timedelta(days=day_range - 1)
    # Finality is decided at fetch time and baked into the key, so a partial-day response
    # cached while the day was recent can never be promoted to permanent later.
    immutable = (_today() - last).days > IMMUTABLE_AFTER_DAYS
    url = (f"{_BASE}/area/csv/{config.firms_map_key()}/{product}/{bbox_s}/{day_range}/"
           f"{start.isoformat()}")
    return cached_bytes(
        "firms",
        f"{product}/{bbox_s}/{day_range}/{start.isoformat()}/{'final' if immutable else 'recent'}",
        lambda: _get(url, "latitude,longitude"),
        ttl_s=None if immutable else RECENT_TTL_S,
    )


def _rows(raw: bytes) -> list[dict[str, str]]:
    return list(csv.DictReader(io.StringIO(raw.decode())))


def _parse(raw: bytes, product: str) -> Detections:
    rows = _rows(raw)
    if product.endswith("_SP"):
        rows = [r for r in rows if r.get("type") == "0"]
    rows = [r for r in rows if float(r["frp"]) > 0]
    if not rows:
        return Detections.empty()
    acq = np.array(
        [f"{r['acq_date']}T{divmod(int(r['acq_time']), 100)[0]:02d}:"
         f"{divmod(int(r['acq_time']), 100)[1]:02d}" for r in rows],
        dtype="datetime64[m]",
    )
    return Detections(
        lon=np.array([float(r["longitude"]) for r in rows]),
        lat=np.array([float(r["latitude"]) for r in rows]),
        frp_mw=np.array([float(r["frp"]) for r in rows]),
        acq_utc=acq,
        is_day=np.array([r["daynight"] == "D" for r in rows]),
        satellite=np.array([r["satellite"] for r in rows], dtype="U8"),
    )


def _cell(lon: np.ndarray, lat: np.ndarray) -> list[tuple[int, int]]:
    scale = round(1 / STATIC_CELL_DEG)
    return list(zip(np.round(lon * scale).astype(int).tolist(),
                    np.round(lat * scale).astype(int).tolist()))


def _static_cells(satellite: str, day: date) -> set[tuple[int, int]]:
    """0.01 deg cells with NRT detections on >= 20 of the 30 days before `day`."""
    product = f"{satellite}_NRT"
    seen: set[tuple[tuple[int, int], str]] = set()
    cell_days: Counter[tuple[int, int]] = Counter()
    first = day - timedelta(days=HISTORY_DAYS)
    last = day - timedelta(days=1)
    # chunks sit on a fixed grid so consecutive target days share cached requests
    start = first - timedelta(days=first.toordinal() % CHUNK_DAYS)
    while start <= last:
        for row in _rows(_area_csv(product, DOMAIN_BBOX, start, CHUNK_DAYS)):
            if not first.isoformat() <= row["acq_date"] <= last.isoformat():
                continue
            cell = _cell(np.array([float(row["longitude"])]), np.array([float(row["latitude"])]))[0]
            if (cell, row["acq_date"]) not in seen:
                seen.add((cell, row["acq_date"]))
                cell_days[cell] += 1
        start += timedelta(days=CHUNK_DAYS)
    return {c for c, n in cell_days.items() if n >= STATIC_MIN_DAYS}


def _in_bbox(det: Detections, bbox: tuple[float, float, float, float]) -> Detections:
    w, s, e, n = bbox
    return det.select((det.lon >= w) & (det.lon <= e) & (det.lat >= s) & (det.lat <= n))


def _product_detections(product: str, day: date,
                        bbox: tuple[float, float, float, float]) -> Detections:
    """Detections for one product and day inside `bbox` (no static-source filtering)."""
    return _in_bbox(_parse(_area_csv(product, bbox, day, 1), product), bbox)


def _choose_products(day: date) -> list[str]:
    avail = availability()
    chosen = []
    for sat in SATELLITES:
        for suffix in ("SP", "NRT"):
            span = avail.get(f"{sat}_{suffix}")
            if span and span[0] <= day <= span[1]:
                chosen.append(f"{sat}_{suffix}")
                break
    return chosen


def detections(day: date) -> Detections:
    """Fire detections for one UTC day over the model domain, all usable satellites."""
    parts = []
    for product in _choose_products(day):
        det = _product_detections(product, day, DOMAIN_BBOX)
        if product.endswith("_NRT") and len(det):
            static = _static_cells(product.removesuffix("_NRT"), day)
            keep = np.array([c not in static for c in _cell(det.lon, det.lat)])
            det = det.select(keep)
        parts.append(det)
    return Detections.concat(parts)
