import gzip
import json
import logging
import shutil
import threading
import time
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest
from fastapi.testclient import TestClient

from vayu import api
from vayu.cities import BY_ID, CITIES
from vayu.clients.firms import Detections
from vayu.clients.openaq import MeasuredSeries
from vayu.domain import NX, NY, TAGS, cell_index
from vayu.encode import HAZE, decode_frame
from vayu.errors import UpstreamError
from vayu.met import MetRaw, lattice

DAY = date(2023, 11, 5)
START = datetime(2023, 11, 3, tzinfo=UTC)
MADE = datetime(2026, 11, 11, 6, 0, tzinfo=UTC)
NOW = datetime(2026, 11, 11, 7, 30, tzinfo=UTC)
HOURS = 3
SPINUP = 2
TAG_IDS = [t.id for t in TAGS]
DELHI_IX, DELHI_IY = (int(v) for v in cell_index(BY_ID["delhi"].lon, BY_ID["delhi"].lat))


class FakeRun:
    """A tiny stand-in for RunResult: 3 hours, two emitting tags, one missing cell."""

    def __init__(self, out_dir, run_id="20261111T060000Z-aaaaaaaa"):
        self.out_dir = out_dir / "runs" / DAY.isoformat() / run_id
        self.out_dir.mkdir(parents=True, exist_ok=True)
        (self.out_dir / "run.json").write_text(json.dumps({"seed": 0}))
        self.start, self.hours, self.tags = START, HOURS, TAG_IDS
        self.forecast_from = self.fires_assumed_from = None
        self.blh_estimated = True
        self.step_stats = {"left_domain": 1, "depleted": 2, "missing_met": 0}
        self.made_at, self.format_version = MADE, 3
        self.constants = {"SPINUP_H": SPINUP}

    @property
    def run_id(self):
        return self.out_dir.name

    def frame(self, h):
        zero = np.zeros((NY, NX), np.float32)
        zero[0, 0] = np.nan  # mixing height missing here: every tag NaN
        out = {t: zero.copy() for t in self.tags}
        out["vehicles_delhi_ncr"] = np.where(np.isnan(zero), np.nan, 10.0 * (h + 1)).astype(np.float32)
        fire = zero.copy()
        fire[DELHI_IY - 1:DELHI_IY + 2, DELHI_IX - 1:DELHI_IX + 2] = 2.5
        out["fire_punjab"] = fire
        return out

    def haze(self, h):
        return np.full((NY, NX), 1.5, np.float32)

    def fire_age_h(self, h):
        a = np.full((NY, NX), np.nan, np.float32)
        a[DELHI_IY - 1:DELHI_IY + 2, DELHI_IX - 1:DELHI_IX + 2] = 7.0
        return a


def fake_raw(start, hours, nan_wind=False):
    lon, lat = lattice()
    shape = (hours, len(lat), len(lon))
    f = lambda x: np.full(shape, x, dtype=np.float32)
    speed = f(2.0)
    if nan_wind:
        speed[:, 0, 0] = np.nan
    return MetRaw(start, hours, lon, lat, {
        "wind_speed_10m": speed, "wind_direction_10m": f(270.0),
        "wind_speed_100m": speed, "wind_direction_100m": f(270.0),
        "temperature_2m": f(20.0), "relative_humidity_2m": f(50.0),
        "precipitation": f(0.0), "boundary_layer_height": f(500.0),
    })


@pytest.fixture
def env(tmp_path, monkeypatch):
    """Offline API: a stored fake run, stubbed clients and clock, fresh in-process state."""
    state = {"run": None, "built": 0, "met_calls": [], "live_calls": 0}
    fake = FakeRun(tmp_path)

    def load_run(day, now):
        return state["run"] if day == DAY else None

    def run_date(day, now, progress):
        progress(0.0, "fetching fires")
        progress(0.5, "simulating")
        state["built"] += 1
        state["run"] = fake
        return fake

    def fetch_met(start, hours, now):
        state["met_calls"].append((start, hours, now))
        return fake_raw(start, hours, nan_wind=True)

    def live(city):
        state["live_calls"] += 1
        return 55.0

    t0 = np.datetime64("2023-11-03T00:20", "m")
    dets = Detections(
        np.array([75.12345, 76.0, 77.0]), np.array([30.98765, 30.0, 29.0]),
        np.array([12.34, 5.0, 1.0]),
        np.array([t0, np.datetime64("2023-11-03T03:00", "m"), np.datetime64("2023-11-03T02:59", "m")]),
        np.array([True, False, False]), np.array(["N", "N", "N"]),
    )

    def detections(day):
        return dets if day == date(2023, 11, 3) else Detections.empty()

    monkeypatch.setattr(api, "_S", api._State())
    monkeypatch.setattr(api, "_now", lambda: NOW)
    monkeypatch.setattr(api, "load_run", load_run)
    monkeypatch.setattr(api, "run_date", run_date)
    monkeypatch.setattr(api, "fetch_met", fetch_met)
    monkeypatch.setattr(api, "elevation", lambda: np.zeros((NY, NX), np.float32))
    monkeypatch.setattr(api, "detections", detections)
    monkeypatch.setattr(api, "city_pm25", lambda city, start, hours, now=None: MeasuredSeries(
        np.full(hours, np.nan, np.float32), 0))
    monkeypatch.setattr(api, "live_pm25", live)
    monkeypatch.setattr(api, "fetch_cams_pm25", lambda lat, lon, start, hours: np.r_[
        np.full(hours - 1, 42.0), np.nan])
    state["fake"] = fake
    state["plain_run_date"] = run_date
    state["client"] = TestClient(api.app)
    return state


def ready(env):
    env["run"] = env["fake"]
    return env["client"]


def wait_status(client, day=DAY, timeout=10.0):
    end = time.monotonic() + timeout
    while time.monotonic() < end:
        body = client.get(f"/api/runs/{day.isoformat()}").json()
        if body.get("status") != "running":
            return body
        time.sleep(0.01)
    raise AssertionError("build did not finish")


# --- runs ---

def test_health(env):
    assert env["client"].get("/api/health").json() == {"ok": True}


def test_post_run_then_ready(env):
    c = env["client"]
    r = c.post("/api/runs", json={"date": "2023-11-05"})
    assert r.status_code == 202 and r.json() == {"run_id": "2023-11-05"}
    body = wait_status(c)
    assert body == {"status": "ready", "progress": 1.0, "stage": "ready", "error": None}
    assert env["built"] == 1
    assert env["met_calls"] == [(START - timedelta(hours=SPINUP), SPINUP + HOURS + 1, MADE)]
    extras = env["fake"].out_dir.parent / f"{env['fake'].run_id}.extras"
    assert (extras / "cities.json").is_file() and (extras / "fires.json").is_file()
    assert c.get("/api/runs/2023-11-05/meta").status_code == 200


def test_post_existing_valid_run_returns_200(env):
    r = ready(env).post("/api/runs", json={"date": "2023-11-05"})
    assert r.status_code == 200 and r.json() == {"run_id": "2023-11-05", "status": "ready"}
    assert env["built"] == 0


def test_second_post_while_building_does_not_start_another(env, monkeypatch):
    gate, started = threading.Event(), threading.Event()
    plain = api.run_date

    def slow(day, now, progress):
        started.set()
        gate.wait(10)
        return plain(day, now, progress)

    monkeypatch.setattr(api, "run_date", slow)
    c = env["client"]
    assert c.post("/api/runs", json={"date": "2023-11-05"}).status_code == 202
    assert started.wait(5)
    second = c.post("/api/runs", json={"date": "2023-11-05"})
    assert second.status_code == 202 and second.json() == {"run_id": "2023-11-05"}
    assert c.get("/api/runs/2023-11-05").json()["status"] == "running"
    gate.set()
    assert wait_status(c)["status"] == "ready"
    assert env["built"] == 1


def test_builds_are_serialised(env, monkeypatch):
    active, peak = [0], [0]
    lock = threading.Lock()
    plain = api.run_date

    def counting(day, now, progress):
        with lock:
            active[0] += 1
            peak[0] = max(peak[0], active[0])
        time.sleep(0.05)
        with lock:
            active[0] -= 1
        if day != DAY:
            raise UpstreamError("firms", "no fire product covers it")
        return plain(day, now, progress)

    monkeypatch.setattr(api, "run_date", counting)
    c = env["client"]
    for d in ("2023-11-05", "2023-11-06", "2023-11-07"):
        assert c.post("/api/runs", json={"date": d}).status_code == 202
    for d in (date(2023, 11, 5), date(2023, 11, 6), date(2023, 11, 7)):
        wait_status(c, d)
    assert peak[0] == 1


@pytest.mark.parametrize("value", ["2026-11-12", "2030-01-01"])
def test_future_date_422(env, value):
    r = env["client"].post("/api/runs", json={"date": value})
    assert r.status_code == 422 and "future" in r.json()["detail"]


def test_today_is_allowed(env):
    assert env["client"].post("/api/runs", json={"date": "2026-11-11"}).status_code == 202


def test_before_min_date_422(env):
    assert api.MIN_DATE == date(2018, 4, 1)
    r = env["client"].post("/api/runs", json={"date": "2018-03-31"})
    assert r.status_code == 422 and "2018-04-01" in r.json()["detail"]
    assert env["client"].post("/api/runs", json={"date": "2018-04-01"}).status_code == 202


@pytest.mark.parametrize("value", ["2023-13-01", "05/11/2023", "yesterday", "2023-11-5", 20231105])
def test_malformed_date_422(env, value):
    assert env["client"].post("/api/runs", json={"date": value}).status_code == 422


def test_unknown_run_404(env):
    c = env["client"]
    assert c.get("/api/runs/2023-11-04").status_code == 404
    assert c.get("/api/runs/2023-11-04/meta").status_code == 404
    assert c.get("/api/runs/2023-11-04/frames/0").status_code == 404
    assert c.get("/api/runs/not-a-date").status_code == 422


def test_upstream_error_surfaces_message(env, monkeypatch):
    def broken(day, now, progress):
        progress(0.05, "fetching weather")
        raise UpstreamError("open-meteo", "HTTP 500 from archive")

    monkeypatch.setattr(api, "run_date", broken)
    c = env["client"]
    c.post("/api/runs", json={"date": "2023-11-05"})
    body = wait_status(c)
    assert body["status"] == "error" and body["error"] == "open-meteo: HTTP 500 from archive"
    # a new POST after an error starts again
    monkeypatch.setattr(api, "run_date", env["plain_run_date"])
    assert c.post("/api/runs", json={"date": "2023-11-05"}).status_code == 202
    assert wait_status(c)["status"] == "ready"


def test_other_error_is_generic_and_logged(env, monkeypatch, caplog):
    def broken(day, now, progress):
        raise RuntimeError("disk exploded at /secret/path")

    monkeypatch.setattr(api, "run_date", broken)
    c = env["client"]
    with caplog.at_level(logging.ERROR, logger="vayu.api"):
        c.post("/api/runs", json={"date": "2023-11-05"})
        body = wait_status(c)
    assert body["status"] == "error" and "secret" not in body["error"]
    assert "disk exploded" in caplog.text and "Traceback" in caplog.text


# --- meta ---

def test_meta_contains_34_tags_and_40_cities(env):
    m = ready(env).get("/api/runs/2023-11-05/meta").json()
    assert len(m["tags"]) == 34 and len(m["cities"]) == 40
    assert set(m["tags"][0]) == {"id", "kind", "sector", "region", "label", "color"}
    assert m["date"] == "2023-11-05" and m["build_id"] == env["fake"].run_id
    assert m["made_at"] == MADE.isoformat()
    assert m["hours"] == [(START + timedelta(hours=h)).isoformat() for h in range(HOURS)]
    assert m["frame_semantics"] == "hour_mean_trapezoid"
    assert m["forecast_from"] is None and m["fires_assumed_from"] is None
    assert m["grid"] == {"lon_min": 66.0, "lat_min": 6.0, "cell": 0.1, "nx": 320, "ny": 320}
    notes = m["notes"]
    assert notes["blh_estimated"] is True and notes["dust_available"] is False
    assert notes["fire_scaling_default"] == 1.0 and notes["city_area_km"] == 30
    assert notes["share_uncertainty_pp"] == {"default": 10, "delhi": 5}
    assert notes["min_date"] == "2018-04-01" and notes["step_stats"]["depleted"] == 2
    assert {"inventory_source", "inventory_year"} <= set(notes)
    delhi = next(c for c in m["cities"] if c["id"] == "delhi")
    assert delhi["region"] == "delhi_ncr" and "cams" not in delhi
    assert set(delhi["by_tag"]) == {"vehicles_delhi_ncr", "fire_punjab"}  # zero tags omitted
    assert delhi["by_tag"]["vehicles_delhi_ncr"] == [10.0, 20.0, 30.0]
    assert delhi["fire_age_h"] == [7.0, 7.0, 7.0]
    assert set(delhi["met"]) == {"wind_ms", "wind_dir_deg", "rh", "temp_c", "blh_m"}
    assert delhi["met"]["wind_ms"][0] == pytest.approx(2.0)
    chennai = next(c for c in m["cities"] if c["id"] == "chennai")
    assert chennai["fire_age_h"] == [None, None, None]  # NaN -> null


def test_meta_never_contains_nan(env):
    r = ready(env).get("/api/runs/2023-11-05/meta")
    assert "NaN" not in r.text and "Infinity" not in r.text
    json.loads(r.text, parse_constant=lambda c: pytest.fail(f"non-JSON constant {c}"))


def test_clean_json_response_maps_nan_to_null():
    body = api.CleanJSONResponse({"a": [float("nan"), np.float32(1.5), float("inf")],
                                  "b": np.array([np.nan, 2.0]), "c": np.int64(3)}).body
    assert json.loads(body) == {"a": [None, 1.5, None], "b": [None, 2.0], "c": 3}


def test_meta_built_on_demand_for_stored_run(env):
    c = ready(env)
    assert c.get("/api/runs/2023-11-05").json()["status"] == "ready"
    assert c.get("/api/runs/2023-11-05/meta").status_code == 200
    assert len(env["met_calls"]) == 1
    api._S.builds.clear()  # a restarted process reads the extras back from disk
    assert c.get("/api/runs/2023-11-05/meta").status_code == 200
    assert len(env["met_calls"]) == 1


# --- frames ---

def test_frame_decodes_and_matches_fields(env):
    r = ready(env).get("/api/runs/2023-11-05/frames/1")
    assert r.status_code == 200 and r.headers["content-type"] == "application/octet-stream"
    out = decode_frame(r.content)
    want = env["fake"].frame(1)
    assert list(out)[-1] == HAZE and np.allclose(out[HAZE], 1.5)
    # tags that are zero except for the missing cell are kept, so the gap stays visible
    assert set(out) == set(TAG_IDS) | {HAZE}
    assert out["industry_bihar"][0, 1] == 0 and np.isnan(out["industry_bihar"][0, 0])
    for tag in ("vehicles_delhi_ncr", "fire_punjab"):
        assert np.isnan(out[tag][0, 0])
        np.testing.assert_allclose(out[tag], want[tag], atol=float(np.nanmax(want[tag])) / 65535)


def test_frame_gzip_and_cache_headers(env):
    c = ready(env)
    build = env["fake"].run_id
    r = c.get(f"/api/runs/2023-11-05/frames/0?build={build}", headers={"Accept-Encoding": "gzip"})
    assert r.headers["content-encoding"] == "gzip"
    assert r.headers["cache-control"] == "private, max-age=3600"
    assert r.headers["x-vayu-build"] == build
    raw = c.get("/api/runs/2023-11-05/frames/0", headers={"Accept-Encoding": "identity"})
    assert "content-encoding" not in raw.headers and raw.headers["cache-control"] == "no-cache"
    assert decode_frame(raw.content).keys() == decode_frame(r.content).keys()
    assert len(gzip.compress(raw.content)) < len(raw.content)


def test_frame_hour_out_of_range_404(env):
    c = ready(env)
    assert c.get("/api/runs/2023-11-05/frames/3").status_code == 404
    assert c.get("/api/runs/2023-11-05/frames/-1").status_code == 404


def test_build_mismatch_409(env):
    c = ready(env)
    for path in ("frames/0", "fires", "wind/0", "cities/delhi/path/0"):
        r = c.get(f"/api/runs/2023-11-05/{path}?build=20200101T000000Z-bbbbbbbb")
        assert r.status_code == 409, path
        assert r.json() == {"detail": "run was rebuilt", "build_id": env["fake"].run_id}
    r = c.post("/api/runs/2023-11-05/sources?build=20200101T000000Z-bbbbbbbb", json=SOURCE)
    assert r.status_code == 409


# --- fires, wind, path, cams, measured ---

def test_fires_in_window_with_hour_index(env):
    fires = ready(env).get("/api/runs/2023-11-05/fires").json()
    # hour 3 (03:00) is outside the 3-hour window; night detections are kept
    assert sorted(fires) == [[75.123, 30.988, 12.3, 0], [77.0, 29.0, 1.0, 2]]


def test_wind_shape_and_nulls(env):
    w = ready(env).get("/api/runs/2023-11-05/wind/1").json()
    assert (w["step"], w["lon0"], w["lat0"], w["nx"], w["ny"]) == (1.0, 66.0, 6.0, 33, 33)
    assert len(w["u"]) == len(w["v"]) == 33 * 33
    assert w["u"][0] is None and w["v"][0] is None  # NaN at the south-west lattice point
    assert w["u"][1] == pytest.approx(2.0) and w["v"][1] == pytest.approx(0.0, abs=1e-6)
    assert ready(env).get("/api/runs/2023-11-05/wind/3").status_code == 404


def test_path_starts_at_city_and_goes_upwind(env):
    p = ready(env).get("/api/runs/2023-11-05/cities/delhi/path/2").json()
    assert p[0] == [round(BY_ID["delhi"].lon, 3), round(BY_ID["delhi"].lat, 3)]
    assert len(p) > 1 and p[1][0] < p[0][0]  # westerly wind: the air came from the west
    assert ready(env).get("/api/runs/2023-11-05/cities/atlantis/path/0").status_code == 404


def test_cams(env):
    r = ready(env).get("/api/runs/2023-11-05/cities/delhi/cams")
    assert r.json() == {"values": [42.0, 42.0, None]}


def test_measured_no_stations_returns_nulls(env):
    r = ready(env).get("/api/runs/2023-11-05/cities/delhi/measured").json()
    assert r == {"values": [None, None, None], "station_count": 0, "live": None,
                 "live_error": None, "source": "CPCB via OpenAQ",
                 "aligned": "hour mean, overlap-weighted"}
    assert env["live_calls"] == 0  # the window does not include the current hour


def test_measured_live_only_when_window_includes_now(env, monkeypatch):
    c = ready(env)
    env["fake"].start = NOW - timedelta(hours=1)  # the window includes the current hour
    assert c.get("/api/runs/2023-11-05/cities/delhi/measured").json()["live"] == 55.0

    def down(city):
        raise UpstreamError("data.gov.in", "HTTP 502")

    monkeypatch.setattr(api, "live_pm25", down)
    r = c.get("/api/runs/2023-11-05/cities/delhi/measured")
    assert r.status_code == 200
    assert r.json()["live"] is None and r.json()["live_error"] == "data.gov.in: HTTP 502"


def test_measured_openaq_error_502_and_unknown_city_404(env, monkeypatch):
    c = ready(env)
    assert c.get("/api/runs/2023-11-05/cities/atlantis/measured").status_code == 404

    def broken(city, start, hours, now=None):
        raise UpstreamError("openaq", "HTTP 503 from /locations")

    monkeypatch.setattr(api, "city_pm25", broken)
    r = c.get("/api/runs/2023-11-05/cities/delhi/measured")
    assert r.status_code == 502 and r.json() == {"detail": "openaq: HTTP 503 from /locations"}


# --- dropped sources ---

SOURCE = {"kind": "custom", "lon": 77.21, "lat": 28.61, "amount": 10.0, "start_hour": 1,
          "duration_h": 2}


def test_post_source_simulates_only_that_source(env):
    c = ready(env)
    r = c.post("/api/runs/2023-11-05/sources", json=SOURCE)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tag"]["id"] == "user_1" and body["tag"]["color"] == "#9aa3b5"
    assert body["build_id"] == env["fake"].run_id
    assert set(body["by_city"]) == {c.id for c in CITIES}
    delhi = body["by_city"]["delhi"]
    assert len(delhi) == HOURS and delhi[0] == 0.0 and delhi[1] > 0  # starts at hour 1
    assert body["by_city"]["chennai"] == [0.0, 0.0, 0.0]
    m = c.get("/api/runs/2023-11-05/meta").json()
    assert m["tags"][-1]["id"] == "user_1" and m["tags"][-1]["kind"] == "user"
    assert "user_1" in next(x for x in m["cities"] if x["id"] == "delhi")["by_tag"]


def test_extra_tags_included(env):
    c = ready(env)
    c.post("/api/runs/2023-11-05/sources", json=SOURCE)
    c.post("/api/runs/2023-11-05/sources", json={**SOURCE, "start_hour": 0, "lon": 80.0})
    plain = decode_frame(c.get("/api/runs/2023-11-05/frames/1").content)
    assert not any(t.startswith("user_") for t in plain)
    out = decode_frame(c.get("/api/runs/2023-11-05/frames/1?extra=user_1,user_2").content)
    assert {"user_1", "user_2"} <= set(out) and list(out)[-1] == HAZE
    assert out["user_1"][DELHI_IY - 3:DELHI_IY + 4, DELHI_IX - 3:DELHI_IX + 4].max() > 0
    before = decode_frame(c.get("/api/runs/2023-11-05/frames/0?extra=user_1,user_2").content)
    assert "user_1" not in before and "user_2" in before  # user_1 starts at hour 1: all zero
    assert c.get("/api/runs/2023-11-05/frames/1?extra=user_9").status_code == 404


def test_user_frames_match_by_city_scale(env):
    c = ready(env)
    small = c.post("/api/runs/2023-11-05/sources", json=SOURCE).json()["by_city"]["delhi"]
    big = c.post("/api/runs/2023-11-05/sources", json={**SOURCE, "amount": 20.0}).json()
    np.testing.assert_allclose(big["by_city"]["delhi"], np.array(small) * 2, rtol=1e-4)


@pytest.mark.parametrize("change", [
    {"lon": 100.0}, {"lat": 5.0}, {"kind": "volcano"}, {"amount": 0}, {"amount": -3},
    {"start_hour": 3}, {"start_hour": -1}, {"duration_h": 0}, {"duration_h": 73},
    {"kind": "fireworks", "amount": 7},
])
def test_dropped_outside_domain_422(env, change):
    r = ready(env).post("/api/runs/2023-11-05/sources", json={**SOURCE, **change})
    assert r.status_code == 422 and r.json()["detail"]


def test_source_cap(env):
    c = ready(env)
    for i in range(5):
        assert c.post("/api/runs/2023-11-05/sources", json=SOURCE).json()["tag"]["id"] == f"user_{i + 1}"
    r = c.post("/api/runs/2023-11-05/sources", json=SOURCE)
    assert r.status_code == 422 and "5" in r.json()["detail"]


# --- validation, keys ---

def test_validation_404_then_contents(env, tmp_path):
    c = env["client"]
    assert c.get("/api/validation").status_code == 404
    (tmp_path / "validation.json").write_text(json.dumps({"cities": {"delhi": {"r": 0.5}}}))
    assert c.get("/api/validation").json() == {"cities": {"delhi": {"r": 0.5}}}


KEYS = {"FIRMS_MAP_KEY": "fk-PLANTED-1a2b3c", "OPENAQ_API_KEY": "oq-PLANTED-4d5e6f",
        "DATA_GOV_IN_API_KEY": "dg-PLANTED-7a8b9c"}


def test_no_key_in_any_response(env, monkeypatch, caplog):
    for name, value in KEYS.items():
        monkeypatch.setenv(name, value)
    leak = " ".join(KEYS.values())

    def raises(*a, **kw):
        raise UpstreamError("openaq", f"HTTP 401 for key {leak}")

    def run_raises(day, now, progress):
        raise RuntimeError(f"crash with {leak}")

    def live_raises(city):
        raise UpstreamError("data.gov.in", f"HTTP 502 api-key={leak}")

    c = ready(env)
    bodies = []
    with caplog.at_level(logging.DEBUG):
        paths = ["/api/health", "/api/runs/2023-11-05", "/api/runs/2023-11-05/meta",
                 "/api/runs/2023-11-05/fires", "/api/runs/2023-11-05/wind/0",
                 "/api/runs/2023-11-05/frames/0", "/api/runs/2023-11-05/cities/delhi/path/0",
                 "/api/runs/2023-11-05/cities/delhi/cams",
                 "/api/runs/2023-11-05/cities/delhi/measured", "/api/validation"]
        bodies += [c.get(p).content for p in paths]
        bodies.append(c.post("/api/runs/2023-11-05/sources", json=SOURCE).content)
        monkeypatch.setattr(api, "city_pm25", raises)
        monkeypatch.setattr(api, "fetch_cams_pm25", raises)
        bodies.append(c.get("/api/runs/2023-11-05/cities/delhi/measured").content)
        bodies.append(c.get("/api/runs/2023-11-05/cities/delhi/cams").content)
        env["fake"].start = NOW - timedelta(hours=1)
        monkeypatch.setattr(api, "city_pm25", lambda *a, **k: MeasuredSeries(np.zeros(3), 1))
        monkeypatch.setattr(api, "live_pm25", live_raises)
        bodies.append(c.get("/api/runs/2023-11-05/cities/delhi/measured").content)
        env["fake"].start = START
        monkeypatch.setattr(api, "run_date", run_raises)
        monkeypatch.setattr(api, "fetch_met", raises)
        env["run"] = None
        api._S.builds.clear()
        c.post("/api/runs", json={"date": "2023-11-05"})
        bodies.append(json.dumps(wait_status(c)).encode())
        monkeypatch.setattr(api, "run_date", env["plain_run_date"])
        shutil.rmtree(env["fake"].out_dir.parent / f"{env['fake'].run_id}.extras")
        api._S.builds.clear()
        c.post("/api/runs", json={"date": "2023-11-05"})
        bodies.append(json.dumps(wait_status(c)).encode())  # fails in fetch_met (extras)
    assert json.loads(bodies[11])["detail"] == "openaq: HTTP 401 for key *** *** ***"
    assert json.loads(bodies[13])["live_error"].startswith("data.gov.in: HTTP 502 api-key=***")
    assert json.loads(bodies[14])["error"].startswith("internal error")
    assert json.loads(bodies[15])["error"] == "openaq: HTTP 401 for key *** *** ***"
    for body in bodies:
        for value in KEYS.values():
            assert value.encode() not in body
    for value in KEYS.values():
        assert value not in caplog.text
