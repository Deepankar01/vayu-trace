"""HTTP API for the web app (`uvicorn vayu.api:app`; the web dev server proxies `/api`).

Run identity. The API-level run id is the ISO date. Each date's current stored run has its own
build id (`RunResult.run_id`); every response derived from a run says which build it came from,
and the run-derived endpoints accept `?build=` and answer 409 when the date has been rebuilt,
so the browser never mixes two builds.

Builds run in a background thread, one at a time. A build is `run_date` followed by the
per-build extras (per-city series and the fire list), written beside the immutable run directory
in `runs/{date}/{run_id}.extras/`, which `run.py`'s cleanup removes together with the run once it
is superseded. User-dropped sources are simulated on request into the same extras directory.

The API serves per-tag fields and never applies source weights. JSON never contains NaN
(missing values are null), and no response body or log line contains an API key.
"""
import json
import logging
import math
import os
import re
import shutil
import threading
import traceback
import uuid
from collections import OrderedDict
from dataclasses import asdict, dataclass
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request
from fastapi.concurrency import run_in_threadpool
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse, Response
from pydantic import BaseModel
from starlette.exceptions import HTTPException as StarletteHTTPException

from vayu import config
from vayu.cities import BY_ID, CITIES, City
from vayu.clients.datagov import live_pm25
from vayu.clients.firms import detections
from vayu.clients.openaq import city_pm25
from vayu.clients.openmeteo import fetch_cams_pm25, fetch_met
from vayu.constants import FIRE_SCALING_DEFAULT, MET_STEP_DEG
from vayu.domain import CELL, LAT_MIN, LON_MIN, NX, NY, TAGS
from vayu.emissions.dropped import FIREWORKS_SIZE_NAMES, KINDS, dropped_emissions
from vayu.emissions.inventory import inventory_notes
from vayu.encode import HAZE, encode_frame
from vayu.errors import UpstreamError
from vayu.met import NLAT, NLON, MetField, MetRaw, lattice
from vayu.receptors import USER_COLOR, back_trajectory, city_region, city_series
from vayu.sim.run import (
    PARTICLES_PER_TAG_HOUR,
    RunResult,
    load_run,
    parcels_per_tag_hour,
    run_date,
    simulate,
)
from vayu.terrain import elevation

log = logging.getLogger("vayu.api")
# httpx logs every request URL at INFO, and the FIRMS key travels in its URL path
for _name in ("httpx", "httpcore"):
    logging.getLogger(_name).setLevel(logging.WARNING)

MIN_DATE = date(2018, 4, 1)  # confirmed in Task 16
MAX_USER_SOURCES = 5
BUILD_CACHE = 4  # builds whose RunResult and MetField are kept in memory
CITY_AREA_KM = 30  # a city value is the mean over the 3x3 cell block (receptors.city_series)
SHARE_UNCERTAINTY_PP = {"default": 10, "delhi": 5}
# A dropped source is simulated under a catalogue tag, because `simulate` only accepts catalogue
# tags. Its identity affects only the parcel budget (100 per hour for a non rest_of_india sector
# tag) and fire-age bookkeeping (none for a sector tag); the field is then served as `user_N`.
SIM_TAG = "vehicles_delhi_ncr"
_SIM = next((t for t in TAGS if t.id == SIM_TAG), None)
if _SIM is None or _SIM.kind != "sector" or (
        parcels_per_tag_hour(SIM_TAG) != PARTICLES_PER_TAG_HOUR):
    raise RuntimeError(
        f"SIM_TAG {SIM_TAG!r} must be a catalogue sector tag with the default parcel budget "
        f"({PARTICLES_PER_TAG_HOUR} per hour); pick another stand-in tag for dropped sources")
_DATE = re.compile(r"\d{4}-\d{2}-\d{2}")
_USER = re.compile(r"user_[1-9]\d*")


def _now() -> datetime:
    """The only clock read in the API (UTC); patched in tests."""
    return datetime.now(UTC)


# --- secrets and JSON ---

def _secrets() -> list[str]:
    out = []
    for getter in (config.firms_map_key, config.openaq_api_key, config.data_gov_in_api_key):
        try:
            value = getter()
        except RuntimeError:
            continue
        if value:
            out.append(value)
    return out


def _scrub(text: str) -> str:
    for value in _secrets():
        text = text.replace(value, "***")
    return text


def clean(obj):
    """JSON-ready copy of `obj`: numpy types to Python, NaN and infinities to None."""
    if isinstance(obj, dict):
        return {str(k): clean(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [clean(v) for v in obj]
    if isinstance(obj, np.ndarray):
        return clean(obj.tolist())
    if isinstance(obj, (bool, np.bool_)):
        return bool(obj)
    if isinstance(obj, (int, np.integer)):
        return int(obj)
    if isinstance(obj, (float, np.floating)):
        v = float(obj)
        return v if math.isfinite(v) else None
    return obj


class CleanJSONResponse(JSONResponse):
    """JSON with NaN mapped to null (json.dumps(allow_nan=False) guards the rest) and API keys
    scrubbed from the text."""

    def render(self, content) -> bytes:
        text = json.dumps(clean(content), allow_nan=False, ensure_ascii=False,
                          separators=(",", ":"))
        return _scrub(text).encode("utf-8")


def _series(a) -> list[float | None]:
    """A float series for JSON at 5 significant digits, None where not finite."""
    return [float(f"{x:.5g}") if math.isfinite(x) else None
            for x in np.asarray(a, dtype=float).ravel()]


def _json(content, status_code: int = 200) -> CleanJSONResponse:
    """Every route returns this, so FastAPI's jsonable_encoder (which rejects numpy values)
    never runs and `clean` sees the raw content."""
    return CleanJSONResponse(content, status_code=status_code)


def _all_zero(values) -> bool:
    """True only for a series of exact zeros; a null (missing) value keeps the series."""
    return all(v == 0 for v in values)


def _write_json(path: Path, obj) -> None:
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    tmp.write_text(json.dumps(clean(obj), allow_nan=False, separators=(",", ":")))
    os.replace(tmp, path)


class _Rebuilt(Exception):
    """The build a request refers to is gone: superseded (`build_id` is the current one) or
    expired with nothing current (`build_id` None)."""

    def __init__(self, build_id: str | None):
        self.build_id = build_id


# --- in-process state ---

@dataclass
class _Status:
    status: str  # running | ready | error
    progress: float
    stage: str
    error: str | None = None


class _Build:
    """One stored run plus what the API derives from it, cached in memory by build id."""

    def __init__(self, run: RunResult):
        self.run = run
        self.lock = threading.RLock()
        self._met: MetField | None = None
        self._extras: dict | None = None
        self._users: dict[str, dict] | None = None
        self._user_runs: dict[str, RunResult] = {}
        self._reserved: set[str] = set()  # user tags being simulated

    @property
    def extras_dir(self) -> Path:
        return self.run.out_dir.parent / f"{self.run.run_id}.extras"

    @property
    def spinup_h(self) -> int:
        return int(self.run.constants["SPINUP_H"])

    @property
    def met_offset_h(self) -> int:
        """Hours from the met field's start to the run's start (the spin-up)."""
        return self.spinup_h

    def met(self) -> MetField:
        """The run's met, fetched again with the arguments `run_date` used (disk-cached)."""
        with self.lock:
            if self._met is None:
                run = self.run
                raw = fetch_met(run.start - timedelta(hours=self.spinup_h),
                                self.spinup_h + run.hours + 1, run.made_at)
                self._met = MetField(raw)
            return self._met


class _State:
    def __init__(self):
        self.lock = threading.Lock()
        self.build_lock = threading.Lock()  # one build at a time
        self.status: dict[date, _Status] = {}
        self.builds: OrderedDict[str, _Build] = OrderedDict()
        self._elev: np.ndarray | None = None
        self._elev_lock = threading.Lock()  # never the status lock: polling must not wait on I/O

    def set_status(self, day: date, status: str, progress: float | None = None,
                   stage: str | None = None, error: str | None = None) -> None:
        with self.lock:
            old = self.status.get(day)
            self.status[day] = _Status(
                status, old.progress if progress is None and old else (progress or 0.0),
                stage if stage is not None else (old.stage if old else ""), error)

    def build_for(self, run: RunResult) -> _Build:
        with self.lock:
            b = self.builds.get(run.run_id)
            if b is None:
                b = self.builds[run.run_id] = _Build(run)
            self.builds.move_to_end(run.run_id)
            while len(self.builds) > BUILD_CACHE:
                self.builds.popitem(last=False)
            return b

    def elev(self) -> np.ndarray:
        with self._elev_lock:
            if self._elev is None:
                self._elev = elevation()
            return self._elev


_S = _State()


# --- helpers ---

def _parse_day(text, now: datetime) -> date:
    if not isinstance(text, str) or not _DATE.fullmatch(text):
        raise HTTPException(422, "date must be YYYY-MM-DD")
    try:
        day = date.fromisoformat(text)
    except ValueError:
        raise HTTPException(422, f"{text} is not a valid date") from None
    if day < MIN_DATE:
        raise HTTPException(422, f"{day} is before {MIN_DATE}, the earliest supported date")
    if day > now.date():
        raise HTTPException(422, f"{day} is in the future (today is {now.date()} UTC)")
    return day


def _resolve(run_id: str, build: str | None) -> _Build:
    now = _now()
    day = _parse_day(run_id, now)
    run = load_run(day, now)
    if run is None:
        if build is not None:
            raise _Rebuilt(None)
        raise HTTPException(404, f"no ready run for {day}; POST /api/runs to build it")
    if build is not None and build != run.run_id:
        raise _Rebuilt(run.run_id)
    return _S.build_for(run)


def _city(city_id: str) -> City:
    city = BY_ID.get(city_id)
    if city is None:
        raise HTTPException(404, f"unknown city {city_id!r}")
    return city


def _check_hour(run, hour: int) -> None:
    if not 0 <= hour < run.hours:
        raise HTTPException(404, f"hour {hour} outside 0..{run.hours - 1}")


def _upstream(exc: UpstreamError) -> HTTPException:
    return HTTPException(502, _scrub(f"{exc.service}: {exc.message}"))


def _log_exception(message: str, exc: BaseException | None = None) -> None:
    trace = (traceback.format_exc() if exc is None
             else "".join(traceback.format_exception(exc)))
    log.error("%s\n%s", _scrub(message), _scrub(trace))


# --- extras: per-city series and fires ---

def _fires(run) -> list[list]:
    """[lon, lat, frp_mw, hour_index] for detections in the window, by acquisition time. Only
    days before the build's day are observed (the run uses persistence from then on)."""
    start64 = np.datetime64(run.start.replace(tzinfo=None), "m")
    last = (run.start + timedelta(hours=run.hours - 1)).date()
    out = []
    day = run.start.date()
    while day <= last and day < run.made_at.date():
        det = detections(day)
        h = ((det.acq_utc - start64) // np.timedelta64(1, "h")).astype(int)
        for i in np.flatnonzero((h >= 0) & (h < run.hours)):
            out.append([round(float(det.lon[i]), 3), round(float(det.lat[i]), 3),
                        round(float(det.frp_mw[i]), 1), int(h[i])])
        day += timedelta(days=1)
    return out


def _extras(b: _Build) -> dict:
    """{"cities": {id: {by_tag, fire_age_h, met}}, "fires": [...]}, built once per build."""
    with b.lock:
        if b._extras is not None:
            return b._extras
        cities_p, fires_p = b.extras_dir / "cities.json", b.extras_dir / "fires.json"
        if cities_p.is_file() and fires_p.is_file():
            b._extras = {"cities": json.loads(cities_p.read_text()),
                         "fires": json.loads(fires_p.read_text())}
            return b._extras
        series = city_series(b.run, b.met(), b.met_offset_h)
        cities = {}
        for cid, s in series.items():
            by_tag = {t: _series(v) for t, v in s.by_tag.items()}
            cities[cid] = {
                "by_tag": {t: v for t, v in by_tag.items() if not _all_zero(v)},
                "fire_age_h": _series(s.fire_age_h),
                "met": {k: _series(v) for k, v in s.met.items()},
            }
        fires = _fires(b.run)
        b.extras_dir.mkdir(parents=True, exist_ok=True)
        _write_json(cities_p, cities)
        _write_json(fires_p, fires)
        b._extras = {"cities": cities, "fires": fires}
        return b._extras


# --- builds ---

def _build(day: date) -> None:
    def report(fraction: float, stage: str) -> None:
        _S.set_status(day, "running", fraction, stage)

    try:
        with _S.build_lock:
            now = _now()  # a queued build computes its window when it actually starts
            report(0.0, "starting")
            run = run_date(day, now, lambda f, s: report(0.9 * f, s))
            report(0.9, "city series and fires")
            _extras(_S.build_for(run))
        _S.set_status(day, "ready", 1.0, "ready")
    except UpstreamError as exc:
        _S.set_status(day, "error", error=_scrub(f"{exc.service}: {exc.message}"))
    except Exception:  # noqa: BLE001 - reported as a status, traceback logged
        _log_exception(f"build for {day} failed")
        _S.set_status(day, "error",
                      error="internal error while building the run (details in the server log)")


# --- user-dropped sources ---

def _user_sources(b: _Build) -> dict[str, dict]:
    """user tag id -> stored description, in id order."""
    with b.lock:
        if b._users is None:
            found = {}
            if b.extras_dir.is_dir():
                for p in b.extras_dir.glob("user_*.json"):
                    if _USER.fullmatch(p.stem):
                        found[p.stem] = json.loads(p.read_text())
            b._users = dict(sorted(found.items(), key=lambda kv: int(kv[0][5:])))
        return b._users


def _user_field(b: _Build, tag: str, hour: int) -> np.ndarray:
    meta = _user_sources(b).get(tag)
    if meta is None:
        raise HTTPException(404, f"unknown user source {tag!r} for build {b.run.run_id}")
    if hour < meta["start_hour"]:
        return np.zeros((NY, NX), np.float32)
    with b.lock:
        sub = b._user_runs.get(tag)
        if sub is None:
            sub = RunResult.from_dir(b.extras_dir / tag)
            if sub is None:  # cleaned up with its superseded run
                raise FileNotFoundError(b.extras_dir / tag)
            b._user_runs[tag] = sub
    return sub.frame(hour - meta["start_hour"])[SIM_TAG]


class _OneTag:
    """A run view exposing only the stand-in tag (so city_series reads nothing else)."""

    def __init__(self, run: RunResult):
        self.run, self.hours, self.tags = run, run.hours, [SIM_TAG]

    def frame(self, h):
        return {SIM_TAG: self.run.frame(h)[SIM_TAG]}


def _run_seed(run) -> int:
    return int(json.loads((run.out_dir / "run.json").read_text()).get("seed", 0))


def _reserve_user_tag(b: _Build) -> str:
    """Claim the next free `user_N` id of a build (cap MAX_USER_SOURCES, counting sources in
    flight). Held only briefly: the simulation runs without the build lock."""
    with b.lock:
        taken = set(_user_sources(b)) | b._reserved
        if len(taken) >= MAX_USER_SOURCES:
            raise HTTPException(422, f"at most {MAX_USER_SOURCES} added sources per run")
        n = next(i for i in range(1, MAX_USER_SOURCES + 1) if f"user_{i}" not in taken)
        tag = f"user_{n}"
        b._reserved.add(tag)
        return tag


def _require_run_dir(run) -> None:
    """Raise FileNotFoundError (answered as 409) if the build was cleaned up meanwhile."""
    if not run.out_dir.is_dir():
        raise FileNotFoundError(run.out_dir)


def _add_source(b: _Build, req: "SourceRequest", now: datetime) -> dict:
    run = b.run
    try:  # validates every field against the run window
        dropped_emissions(req.kind, req.lon, req.lat, req.amount, req.start_hour, req.duration_h,
                          run.hours)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from None
    spec = KINDS[req.kind]
    if spec.total_kg is not None:
        label = f"{spec.label}: {FIREWORKS_SIZE_NAMES[int(req.amount)]} event"
    else:
        label = f"{spec.label}: {req.amount:g} {spec.unit}"
    tag = _reserve_user_tag(b)
    out_dir = b.extras_dir / tag
    try:
        s = req.start_hour
        sub_hours = run.hours - s
        # the sub-run starts at the source's first hour, without spin-up
        em = dropped_emissions(req.kind, req.lon, req.lat, req.amount, 0, req.duration_h,
                               sub_hours, tag_id=SIM_TAG)
        raw = b.met().raw
        off = b.met_offset_h + s
        sub_met = MetField(MetRaw(raw.start + timedelta(hours=off), raw.hours - off, raw.lon,
                                  raw.lat, {k: v[off:] for k, v in raw.variables.items()}))
        _require_run_dir(run)
        b.extras_dir.mkdir(exist_ok=True)
        if out_dir.exists():  # left by a request that died before registering it
            shutil.rmtree(out_dir)
        sub = simulate(em, sub_met, _S.elev(), run.start + timedelta(hours=s), sub_hours,
                       out_dir, seed=_run_seed(run), spinup_h=0, made_at=now)
        series = city_series(_OneTag(sub), sub_met, 0.0)
        by_city = {cid: [0.0] * s + _series(cs.by_tag[SIM_TAG]) for cid, cs in series.items()}
        meta = {"id": tag, "label": label, "color": USER_COLOR, "kind": req.kind,
                "lon": req.lon, "lat": req.lat, "amount": req.amount, "start_hour": s,
                "duration_h": req.duration_h, "by_city": by_city}
        _require_run_dir(run)
        _write_json(b.extras_dir / f"{tag}.json", meta)
        with b.lock:  # publish
            users = _user_sources(b)
            users[tag] = meta
            b._users = dict(sorted(users.items(), key=lambda kv: int(kv[0][5:])))
            b._user_runs[tag] = sub
    except BaseException:
        shutil.rmtree(out_dir, ignore_errors=True)
        raise
    finally:
        with b.lock:
            b._reserved.discard(tag)
    return {"tag": {"id": tag, "label": label, "color": USER_COLOR}, "by_city": by_city,
            "build_id": run.run_id}


# --- app ---

app = FastAPI(title="vayu", default_response_class=CleanJSONResponse)
app.add_middleware(GZipMiddleware, minimum_size=1000)


@app.middleware("http")
async def _internal_errors(request: Request, call_next):
    try:
        return await call_next(request)
    except Exception as exc:  # noqa: BLE001 - logged with keys scrubbed, generic body
        _log_exception(f"{request.method} {request.url.path} failed", exc)
        return CleanJSONResponse({"detail": "internal server error"}, status_code=500)


@app.exception_handler(StarletteHTTPException)
async def _http_error(request: Request, exc: StarletteHTTPException):
    return CleanJSONResponse({"detail": exc.detail}, status_code=exc.status_code,
                             headers=getattr(exc, "headers", None))


@app.exception_handler(RequestValidationError)
async def _invalid(request: Request, exc: RequestValidationError):
    parts = ["/".join(str(x) for x in e["loc"]) + ": " + e["msg"] for e in exc.errors()]
    return CleanJSONResponse({"detail": "; ".join(parts)}, status_code=422)


def _gone(build_id: str | None) -> CleanJSONResponse:
    detail = "run was rebuilt" if build_id is not None else "run expired"
    return CleanJSONResponse({"detail": detail, "build_id": build_id}, status_code=409)


@app.exception_handler(_Rebuilt)
async def _rebuilt(request: Request, exc: _Rebuilt):
    return _gone(exc.build_id)


@app.exception_handler(FileNotFoundError)
async def _vanished(request: Request, exc: FileNotFoundError):
    """A build's files disappeared under a request (the run was superseded and cleaned up)."""
    run_id = request.path_params.get("run_id")
    if run_id is None:
        _log_exception(f"{request.method} {request.url.path} failed", exc)
        return CleanJSONResponse({"detail": "internal server error"}, status_code=500)
    try:
        run = await run_in_threadpool(load_run, date.fromisoformat(run_id), _now())
    except (ValueError, OSError):
        run = None
    return _gone(None if run is None else run.run_id)


@app.exception_handler(UpstreamError)
async def _upstream_error(request: Request, exc: UpstreamError):
    return CleanJSONResponse({"detail": _scrub(f"{exc.service}: {exc.message}")},
                             status_code=502)


class RunRequest(BaseModel):
    date: object


class SourceRequest(BaseModel):
    kind: str
    lon: float
    lat: float
    amount: float
    start_hour: int
    duration_h: int


@app.get("/api/health")
def health():
    return _json({"ok": True})


@app.post("/api/runs")
def post_run(body: RunRequest):
    now = _now()
    day = _parse_day(body.date, now)
    run_id = day.isoformat()
    with _S.lock:
        st = _S.status.get(day)
    if st is not None and st.status == "running":
        return _json({"run_id": run_id}, 202)
    stored = load_run(day, now)  # disk I/O: outside the status lock
    with _S.lock:
        st = _S.status.get(day)
        if st is not None and st.status == "running":  # another POST started it meanwhile
            return _json({"run_id": run_id}, 202)
        if stored is not None:
            _S.status[day] = _Status("ready", 1.0, "ready")
            return _json({"run_id": run_id, "status": "ready"})
        _S.status[day] = _Status("running", 0.0, "queued")
    threading.Thread(target=_build, args=(day,), name=f"build-{day}", daemon=True).start()
    return _json({"run_id": run_id}, 202)


@app.get("/api/runs/{run_id}")
def get_run(run_id: str):
    now = _now()
    day = _parse_day(run_id, now)
    with _S.lock:
        st = _S.status.get(day)
    if st is not None and st.status != "ready":
        return _json(asdict(st))
    if load_run(day, now) is not None:
        return _json(asdict(_Status("ready", 1.0, "ready")))
    raise HTTPException(404, f"no run for {day}; POST /api/runs to build it")


@app.get("/api/runs/{run_id}/meta")
def get_meta(run_id: str):
    b = _resolve(run_id, None)
    run = b.run
    ex = _extras(b)
    users = _user_sources(b)
    by_id = {t.id: t for t in TAGS}
    tags = [{"id": t, "kind": by_id[t].kind, "sector": by_id[t].sector,
             "region": by_id[t].region, "label": by_id[t].label, "color": by_id[t].color}
            for t in run.tags]
    tags += [{"id": u, "kind": "user", "sector": None, "region": None, "label": m["label"],
              "color": m["color"]} for u, m in users.items()]
    cities = []
    for c in CITIES:
        e = ex["cities"][c.id]
        by_tag = dict(e["by_tag"])
        for u, m in users.items():
            if not _all_zero(m["by_city"][c.id]):
                by_tag[u] = m["by_city"][c.id]
        cities.append({"id": c.id, "name": c.name, "lat": c.lat, "lon": c.lon,
                       "region": city_region(c), "by_tag": by_tag,
                       "fire_age_h": e["fire_age_h"], "met": e["met"]})
    inv = inventory_notes()
    return _json({
        "date": run_id, "build_id": run.run_id,
        "made_at": None if run.made_at is None else run.made_at.isoformat(),
        "hours": [(run.start + timedelta(hours=h)).isoformat() for h in range(run.hours)],
        "forecast_from": run.forecast_from, "fires_assumed_from": run.fires_assumed_from,
        "frame_semantics": "hour_mean_trapezoid",
        "grid": {"lon_min": LON_MIN, "lat_min": LAT_MIN, "cell": CELL, "nx": NX, "ny": NY},
        "tags": tags, "cities": cities,
        "notes": {
            "blh_estimated": run.blh_estimated, "dust_available": inv["dust_available"],
            "inventory_source": inv["source"], "inventory_year": inv["year"],
            "fire_scaling_default": FIRE_SCALING_DEFAULT, "step_stats": run.step_stats,
            "city_area_km": CITY_AREA_KM, "share_uncertainty_pp": SHARE_UNCERTAINTY_PP,
            "min_date": MIN_DATE.isoformat(),
        },
    })


@app.get("/api/runs/{run_id}/frames/{hour}")
def get_frame(run_id: str, hour: int, build: str | None = None, extra: str | None = None):
    b = _resolve(run_id, build)
    run = b.run
    _check_hour(run, hour)
    extras = [t for t in (extra or "").split(",") if t]
    fields = dict(run.frame(hour))
    for tag in extras:
        fields[tag] = _user_field(b, tag, hour)
    fields[HAZE] = run.haze(hour)
    headers = {"X-Vayu-Build": run.run_id,
               # a URL without ?build= may serve a newer build later
               "Cache-Control": "private, max-age=3600" if build else "no-cache"}
    return Response(encode_frame(fields), media_type="application/octet-stream", headers=headers)


@app.get("/api/runs/{run_id}/fires")
def get_fires(run_id: str, build: str | None = None):
    return _json(_extras(_resolve(run_id, build))["fires"])


@app.get("/api/runs/{run_id}/wind/{hour}")
def get_wind(run_id: str, hour: int, build: str | None = None):
    b = _resolve(run_id, build)
    _check_hour(b.run, hour)
    g = b.met().grid(b.met_offset_h + hour)
    lon, lat = lattice()
    return _json({"step": MET_STEP_DEG, "lon0": lon[0], "lat0": lat[0], "nx": NLON, "ny": NLAT,
                  "u": np.round(g["u"].ravel(), 2), "v": np.round(g["v"].ravel(), 2)})


@app.get("/api/runs/{run_id}/cities/{city_id}/path/{hour}")
def get_path(run_id: str, city_id: str, hour: int, build: str | None = None):
    b = _resolve(run_id, build)
    city = _city(city_id)
    _check_hour(b.run, hour)
    points = back_trajectory(b.met(), _S.elev(), city.lon, city.lat, hour,
                             met_offset_h=b.met_offset_h)
    return _json([[round(lon, 3), round(lat, 3)] for lon, lat in points])


@app.get("/api/runs/{run_id}/cities/{city_id}/cams")
def get_cams(run_id: str, city_id: str, build: str | None = None):
    run = _resolve(run_id, build).run
    city = _city(city_id)
    try:
        values = fetch_cams_pm25(city.lat, city.lon, run.start, run.hours)
    except UpstreamError as exc:
        raise _upstream(exc) from None
    return _json({"values": _series(values)})


@app.get("/api/runs/{run_id}/cities/{city_id}/measured")
def get_measured(run_id: str, city_id: str, build: str | None = None):
    run = _resolve(run_id, build).run
    city = _city(city_id)
    now = _now()
    try:
        m = city_pm25(city, run.start, run.hours, now=now)
    except UpstreamError as exc:
        raise _upstream(exc) from None
    live, live_error = None, None
    if run.start <= now < run.start + timedelta(hours=run.hours):
        try:
            live = live_pm25(city)
        except UpstreamError as exc:
            live_error = _scrub(f"{exc.service}: {exc.message}")
    return _json({"values": _series(m.values), "station_count": m.station_count, "live": live,
                  "live_error": live_error, "source": "CPCB via OpenAQ",
                  "aligned": "hour mean, overlap-weighted"})


@app.post("/api/runs/{run_id}/sources")
def post_source(run_id: str, body: SourceRequest, build: str | None = None):
    return _json(_add_source(_resolve(run_id, build), body, _now()))


@app.get("/api/validation")
def get_validation():
    path = config.data_dir() / "validation.json"
    if not path.is_file():
        raise HTTPException(404, "no validation results yet")
    return _json(json.loads(path.read_text()))
