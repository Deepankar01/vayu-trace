from datetime import date
from pathlib import Path

import httpx
import numpy as np
import pytest
import respx

from vayu.clients import firms
from vayu.errors import UpstreamError

FIX = Path(__file__).parent.parent / "fixtures" / "firms"
AVAIL_URL = "https://firms.modaps.eosdis.nasa.gov/api/data_availability/csv/TESTKEY/all"
AREA = "https://firms.modaps.eosdis.nasa.gov/api/area/csv/TESTKEY/"
PUNJAB = (73, 28, 78, 33)
HEADER_NRT = ("latitude,longitude,bright_ti4,scan,track,acq_date,acq_time,satellite,instrument,"
              "confidence,version,bright_ti5,frp,daynight\n")


@pytest.fixture
def avail_route():
    with respx.mock(assert_all_called=False) as mock:
        mock.get(AVAIL_URL).respond(text=(FIX / "availability.csv").read_text())
        yield mock


def empty_sp(request):
    return httpx.Response(200, text=(FIX / "punjab_snpp_sp_2023-11-05.csv").read_text().splitlines()[0])


def requested_products(mock):
    return [str(c.request.url).removeprefix(AREA).split("/")[0]
            for c in mock.calls if "/area/" in str(c.request.url)]


def test_parses_punjab_2023(avail_route):
    avail_route.get(url__regex=AREA + r"VIIRS_SNPP_SP/73,28,78,33/1/2023-11-05").respond(
        text=(FIX / "punjab_snpp_sp_2023-11-05.csv").read_text())
    det = firms._product_detections("VIIRS_SNPP_SP", date(2023, 11, 5), PUNJAB)
    # 3778 rows recorded; 8 are type 2 (offshore) and are dropped
    assert len(det) == 3770
    assert (det.frp_mw > 0).all()
    assert ((det.lon >= 73) & (det.lon <= 78) & (det.lat >= 28) & (det.lat <= 33)).all()
    assert det.acq_utc.dtype == np.dtype("datetime64[m]")
    assert det.acq_utc[0] == np.datetime64("2023-11-05T08:14")
    assert det.is_day.dtype == bool and det.is_day[0]


def test_prefers_sp_inside_range(avail_route):
    avail_route.get(url__startswith=AREA).mock(side_effect=empty_sp)
    firms.detections(date(2023, 11, 5))
    assert sorted(requested_products(avail_route)) == [
        "VIIRS_NOAA20_SP", "VIIRS_NOAA21_SP", "VIIRS_SNPP_SP"]


def test_falls_back_to_nrt(avail_route):
    avail_route.get(url__startswith=AREA).respond(text=HEADER_NRT)
    firms.detections(date(2026, 11, 10))
    products = requested_products(avail_route)
    assert "VIIRS_NOAA20_NRT" in products and "VIIRS_NOAA21_NRT" in products
    assert not any(p.endswith("_SP") for p in products)


def test_skips_stale_satellite(avail_route):
    avail_route.get(url__startswith=AREA).respond(text=HEADER_NRT)
    firms.detections(date(2026, 11, 10))
    assert not any(p.startswith("VIIRS_SNPP") for p in requested_products(avail_route))


def test_no_product_covering_day_raises(avail_route):
    with pytest.raises(UpstreamError, match="no fire product covers 2010-01-01"):
        firms.detections(date(2010, 1, 1))
    assert requested_products(avail_route) == []


def test_invalid_key_raises(avail_route):
    avail_route.get(AVAIL_URL).respond(text="Invalid MAP_KEY.")
    with pytest.raises(UpstreamError) as err:
        firms.availability()
    assert err.value.service == "firms"
    assert "TESTKEY" not in str(err.value)


def test_http_error_raises(avail_route):
    avail_route.get(AVAIL_URL).respond(status_code=500)
    with pytest.raises(UpstreamError, match="firms: HTTP 500"):
        firms.availability()


def test_cache_hits_once(avail_route):
    firms.availability()
    firms.availability()
    assert avail_route.calls.call_count == 1


def test_nrt_static_sources_dropped(avail_route):
    day = date(2026, 11, 10)

    def area(request):
        parts = str(request.url).removeprefix(AREA).split("/")
        n_days, start = int(parts[2]), date.fromisoformat(parts[3])
        rows = []
        for i in range(n_days):
            d = start.toordinal() + i
            iso = date.fromordinal(d).isoformat()
            # static flare fires every day; transient fire only on the requested day
            rows.append(f"20.0,75.0,330,0.5,0.4,{iso},100,N,VIIRS,n,2,300,10.0,N")
            if d == day.toordinal():
                rows.append(f"21.0,76.0,330,0.5,0.4,{iso},100,N,VIIRS,n,2,300,5.0,N")
        return httpx.Response(200, text=HEADER_NRT + "\n".join(rows) + "\n")

    avail_route.get(url__startswith=AREA).mock(side_effect=area)
    det = firms.detections(day)
    assert set(det.lat.tolist()) == {21.0}
    assert (det.frp_mw == 5.0).all() and not det.is_day.any()


def test_non_csv_200_body_rejected_and_not_cached(avail_route):
    route = avail_route.get(url__startswith=AREA).respond(text="Rate limit exceeded.")
    for _ in range(2):
        with pytest.raises(UpstreamError, match="firms"):
            firms._area_csv("VIIRS_NOAA20_NRT", PUNJAB, date(2026, 11, 10), 1)
    assert route.call_count == 2
    avail_route.get(AVAIL_URL).respond(text="<html>oops</html>")
    with pytest.raises(UpstreamError):
        firms.availability()


def test_header_only_body_is_accepted(avail_route):
    avail_route.get(url__startswith=AREA).respond(text=HEADER_NRT)
    assert len(firms.detections(date(2026, 11, 10))) == 0


def test_partial_day_never_promoted_to_final(avail_route, monkeypatch):
    day = date(2026, 11, 10)
    route = avail_route.get(url__startswith=AREA).respond(text=HEADER_NRT)
    monkeypatch.setattr(firms, "_today", lambda: date(2026, 11, 10))
    firms._area_csv("VIIRS_NOAA20_NRT", PUNJAB, day, 1)
    assert route.call_count == 1
    # 10 days later the day is old enough to be final: must refetch, not reuse the partial copy
    monkeypatch.setattr(firms, "_today", lambda: date(2026, 11, 20))
    firms._area_csv("VIIRS_NOAA20_NRT", PUNJAB, day, 1)
    assert route.call_count == 2
    firms._area_csv("VIIRS_NOAA20_NRT", PUNJAB, day, 1)
    assert route.call_count == 2  # final copy is cached


def test_static_history_chunks_shared_between_days(avail_route):
    route = avail_route.get(url__startswith=AREA).respond(text=HEADER_NRT)
    firms._static_cells("VIIRS_NOAA20", date(2026, 11, 10))
    first = route.call_count
    firms._static_cells("VIIRS_NOAA20", date(2026, 11, 11))
    assert route.call_count - first <= 1
