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
PAGE = (FIX / "delhi_page.json").read_bytes()


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
    body = json.loads(PAGE)
    body["records"] = [r for r in body["records"] if r["pollutant_id"] != "PM2.5"]
    serve(mock, json.dumps(body).encode())
    assert datagov.live_pm25(cities.BY_ID["delhi"]) is None


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
