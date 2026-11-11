import json
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


def fake_response(request: httpx.Request) -> httpx.Response:
    """Synthetic Open-Meteo reply: temperature encodes the endpoint (1 archive, 2 forecast)."""
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
    hourly = {"time": times}
    for name in VARS:
        hourly[name] = [code if name == "temperature_2m" else 5.0] * len(times)
    body = [{"hourly": hourly} for _ in range(n)]
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
    temp = raw.variables["temperature_2m"][:, 0, 0]
    assert list(temp) == [1.0] * 6 + [2.0] * 6
    hosts = {str(c.request.url).split("?")[0] for c in mock.calls}
    assert hosts == {ARCHIVE, FORECAST}
    fc = next(c.request.url.params for c in mock.calls if FORECAST in str(c.request.url))
    assert "past_days" in fc and "forecast_days" in fc
    assert int(fc["past_days"]) == 5 and "start_date" not in fc


def test_all_archive_makes_no_forecast_call(mock):
    openmeteo.fetch_met(datetime(2023, 11, 5, tzinfo=UTC), 24, NOW)
    assert {str(c.request.url).split("?")[0] for c in mock.calls} == {ARCHIVE}


def test_archive_batches_cached_forecast_ttl(mock, monkeypatch):
    seen = []
    real = openmeteo.cached_bytes
    monkeypatch.setattr(openmeteo, "cached_bytes",
                        lambda ns, key, fetch, ttl_s=None: seen.append(ttl_s) or real(ns, key, fetch, ttl_s))
    openmeteo.fetch_met(datetime(2026, 11, 6, tzinfo=UTC), 12, NOW)
    assert None in seen and 3600 in seen
    n = len(mock.calls)
    openmeteo.fetch_met(datetime(2026, 11, 6, tzinfo=UTC), 12, NOW)
    assert len(mock.calls) == n  # second run served from cache


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
