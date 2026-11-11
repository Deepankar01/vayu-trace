from datetime import UTC, datetime, timedelta
from pathlib import Path

import httpx
import numpy as np
import pytest
import respx

from vayu import cities
from vayu.clients import openaq
from vayu.errors import UpstreamError

FIX = Path(__file__).parent.parent / "fixtures" / "openaq"
LOCATIONS = "https://api.openaq.org/v3/locations"
SENSORS = "https://api.openaq.org/v3/sensors/"
DELHI = cities.BY_ID["delhi"]
START = datetime(2026, 11, 5, tzinfo=UTC)
NOW = datetime(2026, 11, 11, 12, tzinfo=UTC)
OLD_NOW = datetime(2026, 12, 1, tzinfo=UTC)  # makes a 5 Nov window "final"


def loc(loc_id, dlat, provider="CPCB", sensors=None, param="pm25"):
    """A location `dlat` degrees north of Delhi (so a bigger dlat is further away)."""
    sensors = [loc_id * 10] if sensors is None else sensors
    return {
        "id": loc_id, "name": f"station {loc_id}", "provider": {"id": 1, "name": provider},
        "coordinates": {"latitude": DELHI.lat + dlat, "longitude": DELHI.lon},
        "sensors": [{"id": s, "name": param, "parameter": {"id": 2, "name": param}}
                    for s in sensors],
        "datetimeFirst": {"utc": "2018-01-01T00:00:00Z"},
        "datetimeLast": {"utc": "2026-11-11T00:00:00Z"},
    }


def row(hour, value, minute=30, interval="01:00:00"):
    """One OpenAQ hourly row whose period starts at START + hour (+ minute)."""
    t = START + timedelta(hours=hour, minutes=minute)
    stamp = {"utc": t.strftime("%Y-%m-%dT%H:%M:%SZ"), "local": "unused"}
    return {"value": value, "period": {"interval": interval, "datetimeFrom": stamp,
                                       "datetimeTo": stamp}}


def ok(results):
    return httpx.Response(200, json={"meta": {"found": len(results)}, "results": results})


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as m:
        yield m


def serve(mock, locations, hours_by_sensor):
    mock.get(url=LOCATIONS).mock(return_value=ok(locations))
    for sid, rows in hours_by_sensor.items():
        mock.get(url__startswith=f"{SENSORS}{sid}/hours").mock(return_value=ok(rows))


def run(hours=4, now=NOW, **kw):
    return openaq.city_pm25(DELHI, START, hours, now=now, sleep=lambda s: None, **kw)


def test_median_across_stations(mock):
    serve(mock, [loc(1, 0.01), loc(2, 0.02), loc(3, 0.03)],
          {10: [row(0, 10.0), row(1, 100.0)], 20: [row(0, 20.0), row(1, 200.0)],
           30: [row(0, 60.0)]})
    out = run()
    assert out.station_count == 3
    assert out.values.dtype == np.float32
    assert out.values[0] == pytest.approx(20.0)  # median of 10, 20, 60
    assert out.values[1] == pytest.approx(150.0)  # median of the two stations that have a value
    assert np.isnan(out.values[2:]).all()


def test_gap_is_nan(mock):
    serve(mock, [loc(1, 0.01)], {10: [row(0, 5.0), row(2, 7.0)]})
    out = run()
    assert out.values[0] == 5.0 and out.values[2] == 7.0
    assert np.isnan(out.values[1]) and np.isnan(out.values[3])  # never zero-filled
    assert out.station_count == 1


def test_no_stations_returns_all_nan_and_zero_count(mock):
    serve(mock, [loc(1, 0.01, provider="AirGradient"), loc(2, 0.02, param="no2")], {})
    out = run()
    assert out.station_count == 0
    assert out.values.shape == (4,) and np.isnan(out.values).all()


def test_only_cpcb_provider_used(mock):
    serve(mock, [loc(1, 0.01, provider="AirGradient"), loc(2, 0.02, provider="caaqm"),
                 loc(3, 0.03)],
          {30: [row(0, 40.0)]})
    out = run()
    assert out.station_count == 1 and out.values[0] == 40.0
    called = {str(c.request.url.path) for c in mock.calls}
    assert called == {"/v3/locations", "/v3/sensors/30/hours"}


def test_nearest_five_stations_only(mock):
    locs = [loc(i, 0.01 * i) for i in range(1, 8)]  # ids 1..7, nearest first
    serve(mock, locs, {i * 10: [row(0, float(i))] for i in range(1, 8)})
    out = run()
    assert out.station_count == 5
    assert out.values[0] == 3.0  # median of 1..5 (stations 6 and 7 are not used)


def test_station_without_data_in_window_is_skipped_not_counted(mock):
    serve(mock, [loc(1, 0.01), loc(2, 0.02)], {10: [], 20: [row(0, 9.0)]})
    out = run()
    assert out.station_count == 1 and out.values[0] == 9.0


def test_two_sensors_of_one_station_are_merged(mock):
    serve(mock, [loc(1, 0.01, sensors=[10, 11])], {10: [row(0, 5.0)], 11: [row(1, 6.0)]})
    out = run()
    assert out.station_count == 1
    assert out.values[0] == 5.0 and out.values[1] == 6.0


def test_absurd_and_negative_values_are_missing(mock):
    serve(mock, [loc(1, 0.01)],
          {10: [row(0, -3.0), row(1, 2000.5), row(2, 2000.0), row(3, 0.0)]})
    out = run()
    assert np.isnan(out.values[:2]).all()
    assert out.values[2] == 2000.0 and out.values[3] == 0.0  # edges are valid readings


def test_period_start_is_floored_to_the_utc_hour(mock):
    # Indian-clock hours start at :30 UTC; whole-hour periods are placed the same way
    serve(mock, [loc(1, 0.01)], {10: [row(0, 1.0, minute=30), row(1, 2.0, minute=0)]})
    out = run()
    assert out.values[0] == 1.0 and out.values[1] == 2.0


def test_non_hourly_periods_and_out_of_window_rows_are_ignored(mock):
    serve(mock, [loc(1, 0.01)],
          {10: [row(0, 9.0, interval="00:15:00"), row(-5, 8.0), row(50, 7.0), row(1, 4.0)]})
    out = run()
    assert np.isnan(out.values[0]) and out.values[1] == 4.0


def test_stations_outside_the_window_are_not_queried(mock):
    old = loc(1, 0.01)
    old["datetimeLast"] = {"utc": "2022-10-31T00:45:00Z"}
    serve(mock, [old, loc(2, 0.02)], {20: [row(0, 3.0)]})
    out = run()
    assert out.station_count == 1
    assert all("/sensors/10/" not in str(c.request.url) for c in mock.calls)


def test_naive_or_off_hour_start_rejected():
    with pytest.raises(ValueError):
        openaq.city_pm25(DELHI, datetime(2026, 11, 5), 4)
    with pytest.raises(ValueError):
        openaq.city_pm25(DELHI, START + timedelta(minutes=5), 4)


def test_recorded_delhi_locations_nearest_first_cpcb_only(mock):
    mock.get(url=LOCATIONS).mock(
        return_value=httpx.Response(200, content=(FIX / "locations_delhi.json").read_bytes()))
    stations = openaq.stations_near(DELHI)
    assert len(stations) == 57  # the recorded reply holds 57 CPCB locations with pm25
    dists = [s.distance_m for s in stations]
    assert dists == sorted(dists) and dists[0] < 3000
    assert all(s.sensor_ids for s in stations)


def test_recorded_hours_align_and_keep_the_real_gap(mock):
    serve(mock, [loc(1, 0.01, sensors=[12234778])], {})
    mock.get(url__startswith=f"{SENSORS}12234778/hours").mock(
        return_value=httpx.Response(
            200, content=(FIX / "hours_12234778_2026-11-05.json").read_bytes()))
    out = run(hours=24)
    # the first period of the day starts 01:30 UTC; 00:30 has no reading upstream
    assert np.isnan(out.values[0]) and out.values[1] == 252.0 and out.values[2] == 270.0
    assert np.isfinite(out.values[1:]).sum() >= 20


def test_api_key_travels_in_header_not_url(mock):
    serve(mock, [loc(1, 0.01)], {10: [row(0, 1.0)]})
    run()
    for c in mock.calls:
        assert "TESTKEY" not in str(c.request.url)
        assert c.request.headers["x-api-key"] == "TESTKEY"


def test_401_raises_upstream_error(mock):
    mock.get(url=LOCATIONS).mock(return_value=httpx.Response(401, json={"message": "no"}))
    with pytest.raises(UpstreamError) as exc:
        run()
    assert exc.value.service == "openaq"
    assert mock.calls.call_count == 1  # no retry


def test_429_waits_for_reset_then_retries(mock):
    waits = []
    mock.get(url=LOCATIONS).mock(side_effect=[
        httpx.Response(429, headers={"x-ratelimit-reset": "17"}),
        ok([loc(1, 0.01)])])
    mock.get(url__startswith=f"{SENSORS}10/hours").mock(return_value=ok([row(0, 1.0)]))
    out = openaq.city_pm25(DELHI, START, 4, now=NOW, sleep=waits.append)
    assert waits == [17.0] and out.station_count == 1


def test_429_forever_raises_after_five_retries(mock):
    waits = []
    mock.get(url=LOCATIONS).mock(
        return_value=httpx.Response(429, headers={"x-ratelimit-reset": "3"}))
    with pytest.raises(UpstreamError, match="429"):
        openaq.city_pm25(DELHI, START, 4, now=NOW, sleep=waits.append)
    assert mock.calls.call_count == 6 and waits == [3.0] * 5


def test_exhausted_window_pauses_until_reset(mock):
    waits = []
    mock.get(url=LOCATIONS).mock(return_value=httpx.Response(
        200, json={"results": []}, headers={"x-ratelimit-remaining": "0",
                                            "x-ratelimit-reset": "12"}))
    openaq.city_pm25(DELHI, START, 4, now=NOW, sleep=waits.append)
    assert waits == [12.0]


@pytest.mark.parametrize("body", [b"<html>", b'{"detail": "nope"}', b'{"results": "x"}'])
def test_bad_body_raises_and_is_not_cached(mock, body):
    route = mock.get(url=LOCATIONS).mock(side_effect=[
        httpx.Response(200, content=body), ok([loc(1, 0.01)])])
    mock.get(url__startswith=f"{SENSORS}10/hours").mock(return_value=ok([row(0, 1.0)]))
    with pytest.raises(UpstreamError):
        run()
    assert run().station_count == 1  # the bad body was not cached: the retry fetched again
    assert route.call_count == 2


def test_discovery_cached_and_settled_hours_fetched_once(mock):
    serve(mock, [loc(1, 0.01)], {10: [row(0, 1.0)]})
    run(now=OLD_NOW)
    first = mock.calls.call_count
    run(now=OLD_NOW)
    assert mock.calls.call_count == first  # locations and final hours both came from cache


def test_recent_window_is_provisional_with_a_one_hour_ttl(mock, monkeypatch):
    serve(mock, [loc(1, 0.01)], {10: [row(0, 1.0)]})
    stamps = []
    real = openaq.cached_bytes

    def spy(ns, key, fetch, ttl_s=None):
        stamps.append((key.split(":")[0], ttl_s))
        return real(ns, key, fetch, ttl_s)

    monkeypatch.setattr(openaq, "cached_bytes", spy)
    run(now=NOW)  # 4 h window starting 5 Nov, 6 days before NOW: settled
    run(now=START + timedelta(hours=6))  # window ends within 3 days of "now": provisional
    assert ("final", None) in stamps and ("provisional", openaq.PROVISIONAL_TTL_S) in stamps


def test_default_clock_is_one_patchable_helper(mock, monkeypatch):
    serve(mock, [loc(1, 0.01)], {10: [row(0, 1.0)]})
    monkeypatch.setattr(openaq, "_now", lambda: OLD_NOW)
    out = openaq.city_pm25(DELHI, START, 4, sleep=lambda s: None)
    assert out.station_count == 1
