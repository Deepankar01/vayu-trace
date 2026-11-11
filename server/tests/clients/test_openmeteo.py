import json
import sys
import time
from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
import pytest
import respx

from vayu.clients import openmeteo
from vayu.errors import UpstreamError
from vayu.met import MetField

FIX = Path(__file__).parent.parent / "fixtures" / "openmeteo"
ARCHIVE = "https://archive-api.open-meteo.com/v1/archive"
FORECAST = "https://api.open-meteo.com/v1/forecast"
CAMS = "https://air-quality-api.open-meteo.com/v1/air-quality"
NOW = datetime(2026, 11, 11, 6, tzinfo=UTC)
VARS = openmeteo.HOURLY_VARIABLES
REAL_TIME = time.time
NULLS = None  # variable the fake nulls out; set per test via monkeypatch


def fake_response(request: httpx.Request) -> httpx.Response:
    """Synthetic Open-Meteo reply: wind_speed_10m encodes the endpoint (1 archive, 2 forecast),
    temperature_2m encodes the point as lat * 100 + lon."""
    q = request.url.params
    n = len(q["latitude"].split(","))
    if "archive" in str(request.url):
        first, last, code = q["start_date"], q["end_date"], 1.0
        t0 = datetime.fromisoformat(first)
        t1 = datetime.fromisoformat(last) + timedelta(hours=23)
    else:
        today = datetime(NOW.year, NOW.month, NOW.day)
        t0 = today - timedelta(days=int(q["past_days"]))
        t1 = today + timedelta(days=int(q["forecast_days"]), hours=-1)
        code = 2.0
    times = []
    t = t0
    while t <= t1:
        times.append(t.strftime("%Y-%m-%dT%H:%M"))
        t += timedelta(hours=1)
    lats = [float(v) for v in q["latitude"].split(",")]
    lons = [float(v) for v in q["longitude"].split(",")]
    body = []
    for lat, lon in zip(lats, lons, strict=True):
        hourly = {"time": times}
        for name in VARS:
            hourly[name] = [5.0] * len(times)
        hourly["wind_speed_10m"] = [code] * len(times)  # which endpoint answered
        hourly["temperature_2m"] = [lat * 100 + lon] * len(times)  # which point this is
        if NULLS:
            hourly[NULLS] = [None] * len(times)
        body.append({"hourly": hourly})
    return httpx.Response(200, json=body if n > 1 else body[0])


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as m:
        m.get(url__startswith=ARCHIVE).mock(side_effect=fake_response)
        m.get(url__startswith=FORECAST).mock(side_effect=fake_response)
        yield m


def test_parse_recorded_archive_batch():
    raw = json.loads((FIX / "archive_2023-11-05.json").read_text())
    start = datetime(2023, 11, 5, tzinfo=UTC)
    out = openmeteo._parse_batch(raw, start, 24)
    assert out["wind_speed_10m"].shape == (24, 3)
    assert out["wind_speed_10m"][0, 0] == pytest.approx(raw[0]["hourly"]["wind_speed_10m"][0])
    assert out["boundary_layer_height"].dtype == np.float32


def test_nulls_become_nan():
    start = datetime(2023, 11, 5, tzinfo=UTC)
    body = {"hourly": {"time": ["2023-11-05T00:00", "2023-11-05T01:00"],
                       **{v: [None, 1.0] for v in VARS}}}
    out = openmeteo._parse_batch(body, start, 3)  # 3rd hour absent from reply
    col = out["boundary_layer_height"][:, 0]
    assert np.isnan(col[0]) and col[1] == 1.0 and np.isnan(col[2])


def test_fetch_met_lattice_and_requests(mock):
    raw = openmeteo.fetch_met(NOW - timedelta(days=1, hours=6), 24, NOW)
    assert raw.hours == 24
    assert raw.variables["temperature_2m"].shape == (24, 33, 33)
    assert raw.variables["temperature_2m"].dtype == np.float32
    assert raw.lon[0] == 66.0 and raw.lon[-1] == 98.0 and raw.lat[0] == 6.0 and raw.lat[-1] == 38.0
    assert len(mock.calls) == 22  # ceil(1089 / 50) batches
    first = mock.calls[0].request.url.params
    assert first["wind_speed_unit"] == "ms" and first["timezone"] == "GMT"
    assert first["hourly"] == ",".join(VARS)
    assert len(first["latitude"].split(",")) == 50
    # point order: lat-major, so index [lat_i, lon_j] holds the right coordinates
    assert first["latitude"].split(",")[:2] == ["6.0", "6.0"]
    assert first["longitude"].split(",")[:2] == ["66.0", "67.0"]


def test_archive_vs_forecast_split(mock):
    # cutoff is NOW - 5 days = 2026-11-06T06:00; hours 0..5 are archive, the rest forecast
    start = datetime(2026, 11, 6, tzinfo=UTC)
    raw = openmeteo.fetch_met(start, 12, NOW)
    code = raw.variables["wind_speed_10m"][:, 0, 0]
    assert list(code) == [1.0] * 6 + [2.0] * 6
    hosts = {str(c.request.url).split("?")[0] for c in mock.calls}
    assert hosts == {ARCHIVE, FORECAST}
    fc = next(c.request.url.params for c in mock.calls if FORECAST in str(c.request.url))
    assert "past_days" in fc and "forecast_days" in fc
    assert int(fc["past_days"]) == 5 and "start_date" not in fc


def test_all_archive_makes_no_forecast_call(mock):
    openmeteo.fetch_met(datetime(2023, 11, 5, tzinfo=UTC), 24, NOW)
    assert {str(c.request.url).split("?")[0] for c in mock.calls} == {ARCHIVE}


def test_reply_to_lattice_mapping(mock):
    raw = openmeteo.fetch_met(datetime(2023, 11, 5, tzinfo=UTC), 2, NOW)
    temp = raw.variables["temperature_2m"]
    # flat index = lat_i * 33 + lon_j; 49 and 50 straddle the first batch seam
    for flat in (0, 1, 32, 33, 49, 50, 51, 1088):
        lat_i, lon_j = divmod(flat, 33)
        assert temp[0, lat_i, lon_j] == (6 + lat_i) * 100 + (66 + lon_j), flat
        assert temp[1, lat_i, lon_j] == temp[0, lat_i, lon_j]
    assert np.isfinite(temp).all()


def old_start():
    return datetime(2023, 11, 5, tzinfo=UTC)


def cache_names(tmp_path):
    return {p.name for p in (tmp_path / "cache" / "openmeteo").iterdir()}


def test_old_complete_archive_is_cached_for_good(mock, tmp_path):
    openmeteo.fetch_met(old_start(), 24, NOW)
    n = len(mock.calls)
    # a much later "now" is past any TTL; an immutable entry is still served from disk
    openmeteo.fetch_met(old_start(), 24, NOW + timedelta(days=30))
    assert len(mock.calls) == n


def test_archive_with_nulls_is_provisional(mock, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "NULLS", "temperature_2m")
    openmeteo.fetch_met(old_start(), 24, NOW)
    n = len(mock.calls)
    openmeteo.fetch_met(old_start(), 24, NOW)
    assert len(mock.calls) == n  # within the 6 h TTL it is still served from cache
    # after the TTL it is fetched again (and a final entry was never written)
    monkeypatch.setattr(time, "time", lambda: REAL_TIME() + 7 * 3600)
    openmeteo.fetch_met(old_start(), 24, NOW)
    assert len(mock.calls) == 2 * n


def test_null_blh_alone_does_not_block_final(mock, monkeypatch):
    monkeypatch.setattr(sys.modules[__name__], "NULLS", "boundary_layer_height")
    openmeteo.fetch_met(old_start(), 24, NOW)
    n = len(mock.calls)
    monkeypatch.setattr(time, "time", lambda: REAL_TIME() + 30 * 86400)
    openmeteo.fetch_met(old_start(), 24, NOW)
    assert len(mock.calls) == n


def test_recent_archive_day_is_provisional(mock, monkeypatch):
    # last archive day (2026-11-05) is only 6 days before NOW: not final even with no nulls
    openmeteo.fetch_met(datetime(2026, 11, 5, tzinfo=UTC), 6, NOW)
    n = len(mock.calls)
    monkeypatch.setattr(time, "time", lambda: REAL_TIME() + 7 * 3600)
    openmeteo.fetch_met(datetime(2026, 11, 5, tzinfo=UTC), 6, NOW)
    assert len(mock.calls) == 2 * n


def test_final_and_provisional_do_not_share_a_key(mock, monkeypatch):
    # same request, once as provisional (recent now) and once as final (late now)
    openmeteo.fetch_met(datetime(2026, 11, 3, tzinfo=UTC), 6, NOW)
    n = len(mock.calls)
    # the 6 h TTL has passed; an immutable read of the provisional entry would skip the fetch
    monkeypatch.setattr(time, "time", lambda: REAL_TIME() + 7 * 3600)
    openmeteo.fetch_met(datetime(2026, 11, 3, tzinfo=UTC), 6, NOW + timedelta(days=30))
    assert len(mock.calls) == 2 * n  # refetched, and now stored as final
    monkeypatch.setattr(time, "time", lambda: REAL_TIME() + 90 * 86400)
    openmeteo.fetch_met(datetime(2026, 11, 3, tzinfo=UTC), 6, NOW + timedelta(days=30))
    assert len(mock.calls) == 2 * n


def test_forecast_batches_have_one_hour_ttl(mock, monkeypatch):
    start = datetime(2026, 11, 8, tzinfo=UTC)
    openmeteo.fetch_met(start, 6, NOW)
    n = len(mock.calls)
    openmeteo.fetch_met(start, 6, NOW)
    assert len(mock.calls) == n
    monkeypatch.setattr(time, "time", lambda: REAL_TIME() + 2 * 3600)
    openmeteo.fetch_met(start, 6, NOW)
    assert len(mock.calls) == 2 * n


def test_429_then_success_retries():
    sleeps = []
    with respx.mock() as m:
        route = m.get(url__startswith=CAMS).mock(side_effect=[
            httpx.Response(429), httpx.Response(429),
            httpx.Response(200, content=(FIX / "cams_2023-11-05.json").read_bytes())])
        pm = openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24,
                                       sleep=sleeps.append)
    assert route.call_count == 3
    assert sleeps == [1, 2]
    assert pm.shape == (24,) and pm[0] == pytest.approx(114.8)


def test_429_exhausted_raises_upstream_error(mock):
    sleeps = []
    mock.get(url__startswith=ARCHIVE).respond(429)
    with pytest.raises(UpstreamError) as exc:
        openmeteo.fetch_met(datetime(2023, 11, 5, tzinfo=UTC), 24, NOW, sleep=sleeps.append)
    assert exc.value.service == "open-meteo"
    assert sleeps == [1, 2, 4, 8, 16]


def test_other_errors_raise_immediately(mock):
    sleeps = []
    mock.get(url__startswith=ARCHIVE).respond(500)
    with pytest.raises(UpstreamError):
        openmeteo.fetch_met(datetime(2023, 11, 5, tzinfo=UTC), 24, NOW, sleep=sleeps.append)
    assert sleeps == [] and mock.calls.call_count == 1


def test_cams_nulls_are_nan():
    body = {"hourly": {"time": ["2021-01-01T00:00", "2021-01-01T01:00"], "pm2_5": [None, 3.0]}}
    with respx.mock() as m:
        m.get(url__startswith=CAMS).respond(json=body)
        pm = openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2021, 1, 1, tzinfo=UTC), 2)
    assert np.isnan(pm[0]) and pm[1] == 3.0


# --- the real forecast recording (2026-11-11: Delhi, Ludhiana, Patna; past_days=1, forecast_days=2)

FC_START = datetime(2026, 11, 10, tzinfo=UTC)  # recorded on 2026-11-11, so past_days=1 starts here
FC_HOURS = 72


def recorded_forecast_body() -> list:
    return json.loads((FIX / "forecast.json").read_text())


def test_recorded_forecast_shape_and_alignment():
    body = recorded_forecast_body()
    assert isinstance(body, list) and len(body) == 3  # several coordinates: a list of objects
    for item in body:
        hourly = item["hourly"]
        assert item["timezone"] == "GMT" and item["utc_offset_seconds"] == 0
        assert len(hourly["time"]) == FC_HOURS
        assert hourly["time"][0] == "2026-11-10T00:00"  # midnight UTC of today - past_days
        assert hourly["time"][-1] == "2026-11-12T23:00"
        assert item["hourly_units"]["wind_speed_10m"] == "m/s"  # wind_speed_unit=ms honoured
        assert item["hourly_units"]["wind_speed_100m"] == "m/s"
    out = openmeteo._parse_batch(body, FC_START, FC_HOURS)
    for name in VARS:
        assert out[name].shape == (FC_HOURS, 3) and out[name].dtype == np.float32
    # first hour lands in row 0, last in the final row, nothing dropped or shifted
    assert out["wind_speed_10m"][0, 0] == pytest.approx(body[0]["hourly"]["wind_speed_10m"][0])
    assert out["wind_speed_10m"][-1, 2] == pytest.approx(body[2]["hourly"]["wind_speed_10m"][-1])
    for name in VARS:
        assert np.isfinite(out[name]).all(), name


def test_recorded_forecast_winds_and_blh_are_physical():
    out = openmeteo._parse_batch(recorded_forecast_body(), FC_START, FC_HOURS)
    for name in ("wind_speed_10m", "wind_speed_100m"):
        assert (out[name] >= 0).all() and (out[name] < 40).all()  # m/s, not km/h
    for name in ("wind_direction_10m", "wind_direction_100m"):
        assert (out[name] >= 0).all() and (out[name] <= 360).all()
    assert (out["relative_humidity_2m"] >= 0).all() and (out["relative_humidity_2m"] <= 100).all()
    # the forecast feed does carry a boundary layer height (unlike the archive), and it has a day
    # cycle: shallow at night, over 1 km by afternoon
    blh = out["boundary_layer_height"]
    assert (blh > 0).all() and blh.max() > 1000 and blh.min() < 200


def test_recorded_forecast_through_fetch_met(mock):
    """The production path: fetch_met -> forecast URL -> batches -> lattice; every lattice point
    gets the recorded reply (cycled), so shapes and the mixing-height source are real."""
    recorded = recorded_forecast_body()

    def reply(request: httpx.Request) -> httpx.Response:
        n = len(request.url.params["latitude"].split(","))
        return httpx.Response(200, json=[recorded[i % 3] for i in range(n)])

    mock.get(url__startswith=FORECAST).mock(side_effect=reply)
    raw = openmeteo.fetch_met(FC_START, FC_HOURS, NOW)
    params = mock.calls[0].request.url.params
    assert params["past_days"] == "1" and params["forecast_days"] == "2"
    assert {str(c.request.url).split("?")[0] for c in mock.calls} == {FORECAST}  # no archive call
    for name in VARS:
        assert raw.variables[name].shape == (FC_HOURS, 33, 33)
        assert np.isfinite(raw.variables[name]).all(), name
    # lattice index 0 is the 1st point of the 1st batch -> recorded object 0, first hour
    assert raw.variables["wind_speed_10m"][0, 0, 0] == pytest.approx(
        recorded[0]["hourly"]["wind_speed_10m"][0])

    field = MetField(raw)
    assert field.blh_estimated is False  # mixing height came from the feed, not the estimate
    assert np.isfinite(field.grid(0)["u"]).all()


# --- a 200 reply that is not a usable body is never cached, and is retried like a 429


def _good_cams() -> httpx.Response:
    return httpx.Response(200, content=(FIX / "cams_2023-11-05.json").read_bytes())


@pytest.mark.parametrize("bad", [
    httpx.Response(200, text="streaming timeout"),
    httpx.Response(200, json={"hourly": {"time": ["2023-11-05T00:00"]}}),  # pm2_5 missing
])
def test_cams_bad_200_body_is_retried_and_not_cached(bad, tmp_path):
    sleeps = []
    start = datetime(2023, 11, 5, tzinfo=UTC)
    with respx.mock() as m:
        route = m.get(url__startswith=CAMS).mock(side_effect=[bad, _good_cams()])
        pm = openmeteo.fetch_cams_pm25(28.0, 77.0, start, 24, sleep=sleeps.append)
    assert route.call_count == 2 and sleeps == [1]
    assert pm[0] == pytest.approx(114.8)
    cached = [p.read_bytes() for p in (tmp_path / "cache" / "openmeteo").iterdir()]
    assert cached == [(FIX / "cams_2023-11-05.json").read_bytes()]


def test_bad_200_body_exhausted_raises_and_caches_nothing(tmp_path):
    sleeps = []
    with respx.mock() as m:
        m.get(url__startswith=CAMS).respond(200, text="streaming timeout")
        with pytest.raises(UpstreamError) as exc:
            openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24,
                                      sleep=sleeps.append)
    assert exc.value.service == "open-meteo" and "unusable" in exc.value.message
    assert sleeps == [1, 2, 4, 8, 16]
    assert not (tmp_path / "cache" / "openmeteo").exists()
    # a later good reply succeeds
    with respx.mock() as m:
        m.get(url__startswith=CAMS).mock(return_value=_good_cams())
        pm = openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24)
    assert pm[0] == pytest.approx(114.8)


def _bad_first(bad, n_bad=1):
    """Fake Open-Meteo answering `bad` to the first `n_bad` requests, then the normal reply."""
    calls = {"n": 0}

    def answer(request):
        calls["n"] += 1
        return bad if calls["n"] <= n_bad else fake_response(request)
    return answer


@pytest.mark.parametrize("endpoint,start", [
    (ARCHIVE, datetime(2023, 11, 5, tzinfo=UTC)),
    (FORECAST, datetime(2026, 11, 10, tzinfo=UTC)),
])
@pytest.mark.parametrize("bad", [
    httpx.Response(200, text="streaming timeout"),
    httpx.Response(200, json=[{"latitude": 6.0}]),  # no hourly block
])
def test_met_bad_200_body_retried_and_never_cached(endpoint, start, bad, tmp_path):
    sleeps = []
    with respx.mock() as m:
        m.get(url__startswith=endpoint).mock(side_effect=_bad_first(bad))
        raw = openmeteo.fetch_met(start, 24, NOW, sleep=sleeps.append)
    assert sleeps == [1]
    assert np.isfinite(raw.variables["temperature_2m"]).all()
    for p in (tmp_path / "cache" / "openmeteo").iterdir():
        body = json.loads(p.read_bytes())
        assert all("hourly" in item for item in body)


def test_met_bad_body_exhausted_then_good_reply_succeeds(tmp_path):
    bad = httpx.Response(200, text="streaming timeout")
    with respx.mock() as m:
        m.get(url__startswith=ARCHIVE).mock(side_effect=_bad_first(bad, n_bad=10**6))
        with pytest.raises(UpstreamError) as exc:
            openmeteo.fetch_met(old_start(), 24, NOW, sleep=lambda s: None)
    assert "unusable" in exc.value.message
    assert not (tmp_path / "cache" / "openmeteo").exists()
    with respx.mock() as m:
        m.get(url__startswith=ARCHIVE).mock(side_effect=fake_response)
        raw = openmeteo.fetch_met(old_start(), 24, NOW, sleep=lambda s: None)
    assert np.isfinite(raw.variables["temperature_2m"]).all()


SLEEPS: list = []


@pytest.mark.parametrize("url,call", [
    (CAMS, lambda: openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24,
                                             sleep=SLEEPS.append)),
    (ARCHIVE, lambda: openmeteo.fetch_met(datetime(2023, 11, 5, tzinfo=UTC), 24, NOW,
                                          sleep=SLEEPS.append)),
])
def test_error_payload_fails_fast_and_is_not_cached(url, call, tmp_path):
    SLEEPS.clear()
    with respx.mock() as m:
        route = m.get(url__startswith=url).respond(
            200, json={"error": True, "reason": "Cannot initialize WeatherVariable"})
        with pytest.raises(UpstreamError) as exc:
            call()
    assert route.call_count == 1 and SLEEPS == []
    assert "Cannot initialize WeatherVariable" in exc.value.message
    assert not (tmp_path / "cache" / "openmeteo").exists()


def test_missing_variable_is_named_in_the_error():
    with respx.mock() as m:
        m.get(url__startswith=CAMS).respond(200, json={"hourly": {"time": ["2023-11-05T00:00"]}})
        with pytest.raises(UpstreamError) as exc:
            openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24,
                                      sleep=lambda s: None)
    assert "hourly lacks pm2_5" in exc.value.message


def test_all_null_pm25_is_accepted_and_cached(tmp_path):
    times = [f"2023-11-05T{h:02d}:00" for h in range(24)]
    body = {"hourly": {"time": times, "pm2_5": [None] * 24}}
    with respx.mock() as m:
        route = m.get(url__startswith=CAMS).respond(200, json=body)
        pm = openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24)
        openmeteo.fetch_cams_pm25(28.0, 77.0, datetime(2023, 11, 5, tzinfo=UTC), 24)
    assert np.isnan(pm).all() and route.call_count == 1  # second call served from the cache
    assert len(list((tmp_path / "cache" / "openmeteo").iterdir())) == 1


def test_all_null_blh_is_accepted_and_cached(mock, monkeypatch, tmp_path):
    monkeypatch.setattr(sys.modules[__name__], "NULLS", "boundary_layer_height")
    raw = openmeteo.fetch_met(old_start(), 24, NOW, sleep=lambda s: pytest.fail("retried"))
    assert np.isnan(raw.variables["boundary_layer_height"]).all()
    n = len(mock.calls)
    openmeteo.fetch_met(old_start(), 24, NOW)
    assert len(mock.calls) == n  # cached, not refetched
