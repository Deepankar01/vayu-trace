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
