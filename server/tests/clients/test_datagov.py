import json
from pathlib import Path

import httpx
import pytest
import respx

from vayu import cities
from vayu.clients import datagov
from vayu.errors import UpstreamError

FIX = Path(__file__).parent.parent / "fixtures" / "datagov"
URL = "https://api.data.gov.in/resource/3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69"
PAGE = (FIX / "synthetic_delhi_page.json").read_bytes()


@pytest.fixture
def mock():
    with respx.mock(assert_all_called=False) as m:
        yield m


def serve(mock, content=PAGE, status=200):
    return mock.get(url__startswith=URL).mock(
        return_value=httpx.Response(status, content=content))


def test_live_value_parsed(mock):
    serve(mock)
    # Anand Vihar 210, ITO 150, R K Puram latest record 180; Lodhi Road is "NA" (skipped)
    assert datagov.live_pm25(cities.BY_ID["delhi"]) == pytest.approx(180.0)


def test_live_missing_city_returns_none(mock):
    serve(mock)
    assert datagov.live_pm25(cities.BY_ID["patna"]) is None


def test_live_all_na_returns_none(mock):
    serve(mock)
    assert datagov.live_pm25(cities.BY_ID["mumbai"]) is None


def test_alias_matches_feed_spelling(mock):
    serve(mock)
    assert datagov.live_pm25(cities.BY_ID["gurugram"]) == 160.0  # the feed says "Gurgaon"


def test_other_pollutants_are_ignored(mock):
    records = [rec("A", "35", pollutant_id="NO2"), rec("P", "80", city="Patna")]
    assert live(mock, records) is None


def test_401_raises_upstream_error(mock):
    serve(mock, b'{"error": "Key not authorised"}', status=401)
    with pytest.raises(UpstreamError) as exc:
        datagov.live_pm25(cities.BY_ID["delhi"])
    assert exc.value.service == "data.gov.in"


def test_gateway_error_raises_upstream_error(mock):
    serve(mock, b"", status=502)
    with pytest.raises(UpstreamError, match="502"):
        datagov.live_pm25(cities.BY_ID["delhi"])


@pytest.mark.parametrize("body", [b"<html>", b'{"error": "Invalid api key"}',
                                  b'{"status": "error", "records": []}', b'{"total": 3}'])
def test_bad_body_raises_and_is_not_cached(mock, body):
    route = mock.get(url__startswith=URL).mock(side_effect=[
        httpx.Response(200, content=body), httpx.Response(200, content=PAGE)])
    with pytest.raises(UpstreamError):
        datagov.live_pm25(cities.BY_ID["delhi"])
    assert datagov.live_pm25(cities.BY_ID["delhi"]) == pytest.approx(180.0)
    assert route.call_count == 2


def test_cached_for_fifteen_minutes_across_cities(mock, monkeypatch):
    route = serve(mock)
    stamps = []
    real = datagov.cached_bytes
    monkeypatch.setattr(datagov, "cached_bytes",
                        lambda ns, key, fetch, ttl_s=None: stamps.append(ttl_s)
                        or real(ns, key, fetch, ttl_s))
    datagov.live_pm25(cities.BY_ID["delhi"])
    datagov.live_pm25(cities.BY_ID["gurugram"])
    assert route.call_count == 1 and stamps == [900, 900]


def test_pages_are_followed(mock, monkeypatch):
    monkeypatch.setattr(datagov, "PAGE_LIMIT", 2)
    recs = json.loads(PAGE)["records"]
    pages = [recs[0:2], recs[2:4], recs[4:6], recs[6:8], recs[8:]]
    route = mock.get(url__startswith=URL).mock(side_effect=[
        httpx.Response(200, json={"total": len(recs), "records": p}) for p in pages])
    assert datagov.live_pm25(cities.BY_ID["delhi"]) == pytest.approx(180.0)
    assert [c.request.url.params["offset"] for c in route.calls] == ["0", "2", "4", "6", "8"]


def test_key_is_sent_but_never_stored(mock, tmp_path):
    serve(mock)
    datagov.live_pm25(cities.BY_ID["delhi"])
    assert mock.calls[0].request.url.params["api-key"] == "TESTKEY"
    stored = b"".join(p.read_bytes() for p in tmp_path.rglob("*") if p.is_file())
    assert b"TESTKEY" not in stored and b"api-key" not in stored


def test_network_failure_message_does_not_leak_the_key(mock):
    mock.get(url__startswith=URL).mock(side_effect=httpx.ConnectTimeout("timeout"))
    with pytest.raises(UpstreamError) as exc:
        datagov.live_pm25(cities.BY_ID["delhi"])
    assert "TESTKEY" not in str(exc.value)


def page(records, total=None, **extra):
    return json.dumps({"total": len(records) if total is None else total,
                       "records": records, **extra}).encode()


def rec(station, avg, stamp="11-11-2026 10:00:00", city="Delhi", **over):
    return {"city": city, "station": station, "pollutant_id": "PM2.5", "pollutant_avg": avg,
            "last_update": stamp, **over}


def live(mock, records, city="delhi", total=None):
    serve(mock, page(records, total))
    return datagov.live_pm25(cities.BY_ID[city])


def test_latest_record_only_and_na_latest_means_station_missing(mock):
    records = [rec("A", "100", "11-11-2026 08:00:00"), rec("A", "NA", "11-11-2026 10:00:00"),
               rec("B", "40")]
    assert live(mock, records) == 40.0  # A's latest is NA: A is missing, not 100


def test_records_far_behind_the_feed_are_ignored(mock):
    records = [rec("A", "100", "11-11-2026 03:00:00"), rec("B", "40", "11-11-2026 10:00:00"),
               rec("C", "60", "11-11-2026 04:00:00")]  # exactly 6 h behind still counts
    assert live(mock, records) == 50.0


def test_stale_cutoff_uses_the_feed_newest_not_the_city(mock):
    records = [rec("A", "100", "11-11-2026 03:00:00"),
               rec("Z", "9", "11-11-2026 12:00:00", city="Patna")]
    assert live(mock, records) is None  # Delhi's only record is 9 h behind the newest


def test_record_without_station_name_is_skipped(mock):
    assert live(mock, [rec("", "100"), rec("B", "40")]) == 40.0


def test_healthy_feed_without_the_city_is_none(mock):
    assert live(mock, [rec("A", "50")], city="patna") is None


@pytest.mark.parametrize("records, why", [
    ([], "no records"),
    ([{k: v for k, v in rec("A", "50").items() if k != "pollutant_avg"}], "renamed average"),
    ([{k: v for k, v in rec("A", "50").items() if k != "city"}], "renamed city"),
    ([rec("A", "NA")], "no numeric value anywhere"),
    ([rec("A", "50", "2026-11-11T10:00:00")], "changed last_update format"),
    ([rec("A", "50", pollutant_id="NO2")], "filter matched nothing for PM2.5"),
])
def test_schema_mismatch_raises_instead_of_reading_as_no_data(mock, records, why):
    route = serve(mock, page(records))
    with pytest.raises(UpstreamError):
        datagov.live_pm25(cities.BY_ID["delhi"])
    serve(mock, page([rec("A", "50")]))
    assert datagov.live_pm25(cities.BY_ID["delhi"]) == 50.0, why  # nothing was cached
    assert route.call_count == 2


def test_server_page_cap_is_followed_by_offset(mock, monkeypatch):
    monkeypatch.setattr(datagov, "PAGE_LIMIT", 5)  # server returns 1 record per page anyway
    records = [rec("A", "10"), rec("B", "20"), rec("C", "60")]
    route = mock.get(url__startswith=URL).mock(side_effect=[
        httpx.Response(200, content=page(records[i:i + 1], total=3)) for i in range(3)])
    assert datagov.live_pm25(cities.BY_ID["delhi"]) == 30.0
    assert [c.request.url.params["offset"] for c in route.calls] == ["0", "1", "2"]


def test_feed_ending_before_total_raises(mock):
    mock.get(url__startswith=URL).mock(side_effect=[
        httpx.Response(200, content=page([rec("A", "10")], total=3)),
        httpx.Response(200, content=page([], total=3))])
    with pytest.raises(UpstreamError, match="1 of 3"):
        datagov.live_pm25(cities.BY_ID["delhi"])


def test_too_many_pages_raises(mock, monkeypatch):
    monkeypatch.setattr(datagov, "MAX_PAGES", 2)
    mock.get(url__startswith=URL).mock(
        return_value=httpx.Response(200, content=page([rec("A", "10")], total=9)))
    with pytest.raises(UpstreamError, match="pages"):
        datagov.live_pm25(cities.BY_ID["delhi"])


def test_reply_without_total_raises(mock):
    serve(mock, json.dumps({"records": [rec("A", "10")]}).encode())
    with pytest.raises(UpstreamError, match="total"):
        datagov.live_pm25(cities.BY_ID["delhi"])


RECORDED = sorted(FIX.glob("pm25_page_*.json"))


@pytest.mark.skipif(not RECORDED, reason="no real data.gov.in recording yet: run "
                    "`uv run python scripts/record_fixtures.py datagov` when the service is up")
def test_contract_against_the_real_recording(mock):
    pages = [json.loads(p.read_bytes()) for p in RECORDED]
    first = pages[0]["records"][0]
    assert {"city", "station", "pollutant_id", "last_update"} <= set(first)
    assert "pollutant_avg" in first or "avg_value" in first
    mock.get(url__startswith=URL).mock(side_effect=[
        httpx.Response(200, content=p.read_bytes()) for p in RECORDED])
    found = {c.id for c in cities.CITIES if datagov.live_pm25(c) is not None}
    assert len(found) > 20, sorted(found)  # most of the 40 cities
    for aliased in datagov.ALIASES:
        assert aliased in found, f"alias spelling for {aliased} did not match the real feed"
