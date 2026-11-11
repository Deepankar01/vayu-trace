import math
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest

from vayu import constants as C
from vayu.clients import firms
from vayu.clients.firms import Detections
from vayu.domain import cell_index
from vayu.emissions import fires

LUDHIANA = (75.85, 30.90)
ODISHA = (85.0, 20.0)
DAY = date(2025, 11, 1)
SPREAD = 10.0 * math.sqrt(2 * math.pi) * C.FIRE_SIGMA_H * 3600 * C.BIOMASS_KG_PER_MJ / 1000


def det(rows):
    """rows: (lon, lat, frp, 'HH:MM', is_day, satellite) for DAY."""
    if not rows:
        return Detections.empty()
    lon, lat, frp, hm, isd, sat = zip(*rows)
    return Detections(np.array(lon), np.array(lat), np.array(frp, dtype=float),
                      np.array([f"{DAY}T{t}" for t in hm], dtype="datetime64[m]"),
                      np.array(isd), np.array(sat, dtype="U8"))


def patch(monkeypatch, by_day):
    """by_day: date -> Detections (missing days empty). Returns call log."""
    calls = []

    def fake(day):
        calls.append(day)
        d = by_day.get(day, Detections.empty())
        return d
    monkeypatch.setattr(firms, "detections", fake)
    return calls


def total(em, tag, hours):
    return sum(em.hour(tag, h)[2].sum() for h in range(hours))


def at(em, tag, h):
    iy, ix, kg = em.hour(tag, h)
    return dict(zip(zip(iy.tolist(), ix.tolist()), kg.tolist()))


START = datetime(2025, 11, 1, tzinfo=UTC)
LATER = datetime(2025, 12, 1, tzinfo=UTC)  # historical replay: everything observed


def test_single_fire_mass(monkeypatch):
    patch(monkeypatch, {DAY: det([(*LUDHIANA, 10.0, "09:00", True, "VIIRS_SNPP")])})
    em = fires.fire_emissions(START, 24, LATER)
    expected = SPREAD * C.EF_PM25_CROP_G_PER_KG
    assert total(em, "fire_punjab", 24) == pytest.approx(expected, rel=0.01)
    assert em.tags == ["fire_punjab"]


def test_two_satellites_average_not_sum(monkeypatch):
    rows = [(*LUDHIANA, 10.0, "09:00", True, "VIIRS_SNPP"),
            (*LUDHIANA, 10.0, "09:00", True, "VIIRS_NOAA20")]
    patch(monkeypatch, {DAY: det(rows)})
    em = fires.fire_emissions(START, 24, LATER)
    assert total(em, "fire_punjab", 24) == pytest.approx(SPREAD * C.EF_PM25_CROP_G_PER_KG, rel=0.01)


def test_satellite_that_saw_nothing_in_cell_counts_as_zero(monkeypatch):
    rows = [(*LUDHIANA, 10.0, "09:00", True, "VIIRS_SNPP"),
            (*ODISHA, 10.0, "09:00", True, "VIIRS_NOAA20")]
    patch(monkeypatch, {DAY: det(rows)})
    em = fires.fire_emissions(START, 24, LATER)
    assert total(em, "fire_punjab", 24) == pytest.approx(
        0.5 * SPREAD * C.EF_PM25_CROP_G_PER_KG, rel=0.01)


def test_pixels_in_one_cell_sum(monkeypatch):
    rows = [(*LUDHIANA, 5.0, "09:00", True, "VIIRS_SNPP"),
            (*LUDHIANA, 5.0, "09:00", True, "VIIRS_SNPP")]
    patch(monkeypatch, {DAY: det(rows)})
    em = fires.fire_emissions(START, 24, LATER)
    assert total(em, "fire_punjab", 24) == pytest.approx(SPREAD * C.EF_PM25_CROP_G_PER_KG, rel=0.01)


def test_profile_peaks_at_0900_utc(monkeypatch):
    patch(monkeypatch, {DAY: det([(*LUDHIANA, 10.0, "08:30", True, "VIIRS_SNPP")])})
    em = fires.fire_emissions(START, 24, LATER)
    per_hour = [em.hour("fire_punjab", h)[2].sum() for h in range(24)]
    # the peak (09:00 UTC) is the edge between hours [8,9) and [9,10): they tie and are the maxima
    assert per_hour[8] == pytest.approx(per_hour[9])
    assert set(np.argsort(per_hour)[-2:]) == {8, 9}
    assert fires.profile(np.arange(0, 24, 0.25)).argmax() == 36  # t = 9.0 h
    assert fires.PEAK_HOUR_UTC == 9.0
    assert fires.hourly_shares().sum() == pytest.approx(1.0, abs=1e-12)


def test_frp_is_scaled_to_peak_by_profile(monkeypatch):
    # detection 2.5 h (= 1 sigma) after the peak: g = exp(-0.5), so peak FRP = frp / g
    patch(monkeypatch, {DAY: det([(*LUDHIANA, 10.0, "11:30", True, "VIIRS_SNPP")])})
    em = fires.fire_emissions(START, 24, LATER)
    assert total(em, "fire_punjab", 24) == pytest.approx(
        SPREAD * C.EF_PM25_CROP_G_PER_KG / math.exp(-0.5), rel=0.01)


def test_night_only_cell_uses_floored_profile(monkeypatch):
    patch(monkeypatch, {DAY: det([(*LUDHIANA, 1.0, "20:00", False, "VIIRS_SNPP")])})
    em = fires.fire_emissions(START, 24, LATER)
    assert total(em, "fire_punjab", 24) == pytest.approx(
        0.1 * SPREAD * C.EF_PM25_CROP_G_PER_KG / C.FIRE_PROFILE_FLOOR, rel=0.01)


def test_night_pixels_ignored_when_cell_has_day_pixels(monkeypatch):
    rows = [(*LUDHIANA, 10.0, "09:00", True, "VIIRS_SNPP"),
            (*LUDHIANA, 5.0, "20:00", False, "VIIRS_SNPP")]
    patch(monkeypatch, {DAY: det(rows)})
    em = fires.fire_emissions(START, 24, LATER)
    assert total(em, "fire_punjab", 24) == pytest.approx(SPREAD * C.EF_PM25_CROP_G_PER_KG, rel=0.01)


def test_tagged_by_state(monkeypatch):
    rows = [(*LUDHIANA, 10.0, "09:00", True, "VIIRS_SNPP"),
            (*ODISHA, 10.0, "09:00", True, "VIIRS_SNPP")]
    patch(monkeypatch, {DAY: det(rows)})
    em = fires.fire_emissions(START, 24, LATER)
    assert sorted(em.tags) == ["fire_other", "fire_punjab"]
    assert total(em, "fire_punjab", 24) == pytest.approx(SPREAD * C.EF_PM25_CROP_G_PER_KG, rel=0.01)
    assert total(em, "fire_other", 24) == pytest.approx(SPREAD * C.EF_PM25_VEG_G_PER_KG, rel=0.01)
    ix, iy = cell_index(np.array([ODISHA[0]]), np.array([ODISHA[1]]))
    assert list(at(em, "fire_other", 9)) == [(int(iy[0]), int(ix[0]))]


def test_forecast_hours_use_three_day_mean_in_firefc_tags(monkeypatch):
    days = {DAY - timedelta(days=k): det([(*LUDHIANA, 10.0 * k, "09:00", True, "VIIRS_SNPP")])
            for k in (1, 2, 3)}
    # det() stamps DAY on acq time; re-stamp per day
    for d, dt in days.items():
        dt.acq_utc = np.array([f"{d}T09:00"], dtype="datetime64[m]")
    days[DAY] = det([(*LUDHIANA, 999.0, "09:00", True, "VIIRS_SNPP")])  # today: must be ignored
    calls = patch(monkeypatch, days)
    now = datetime(2025, 11, 1, 15, tzinfo=UTC)
    start = datetime(2025, 10, 31, 12, tzinfo=UTC)
    em = fires.fire_emissions(start, 48, now)  # 12 observed hours, then 36 forecast hours
    assert DAY not in calls
    assert sorted(em.tags) == ["fire_punjab", "firefc_punjab"]
    mean_peak = (10 + 20 + 30) / 3
    shares = fires.hourly_shares()
    # forecast hour index 12 is 2025-11-01 00:00 UTC; index 21 is 09:00 UTC
    (kg,) = at(em, "firefc_punjab", 21).values()
    assert kg == pytest.approx(mean_peak / 10 * SPREAD * C.EF_PM25_CROP_G_PER_KG * shares[9])
    assert at(em, "fire_punjab", 12) == {}  # observed tag has nothing at/after today 00:00
    assert at(em, "firefc_punjab", 11) == {}
    # hours of 2025-11-02 reuse the same profile
    assert at(em, "firefc_punjab", 12 + 24 + 9)
    # observed 2025-10-31 hours 12..23 carry that day's (10 MW) field
    obs = sum(at(em, "fire_punjab", h).popitem()[1] for h in range(12) if at(em, "fire_punjab", h))
    assert obs == pytest.approx(
        SPREAD * C.EF_PM25_CROP_G_PER_KG * shares[12:].sum())


def test_historical_replay_has_no_forecast_tags(monkeypatch):
    patch(monkeypatch, {DAY: det([(*LUDHIANA, 10.0, "09:00", True, "VIIRS_SNPP")])})
    em = fires.fire_emissions(START, 24, LATER)
    assert not any(t.startswith("firefc_") for t in em.tags)


def test_no_detections_gives_zero_arrays(monkeypatch):
    patch(monkeypatch, {})
    em = fires.fire_emissions(START, 48, datetime(2025, 11, 2, 6, tzinfo=UTC))
    for tag in ("fire_punjab", "firefc_punjab", "fire_other"):
        for h in (0, 30):
            iy, ix, kg = em.hour(tag, h)
            assert len(iy) == len(ix) == len(kg) == 0


def test_upstream_error_propagates(monkeypatch):
    from vayu.errors import UpstreamError

    def boom(day):
        raise UpstreamError("firms", "down")
    monkeypatch.setattr(firms, "detections", boom)
    with pytest.raises(UpstreamError):
        fires.fire_emissions(START, 24, LATER)


def test_rejects_naive_or_unaligned_start():
    with pytest.raises(ValueError):
        fires.fire_emissions(datetime(2025, 11, 1), 1, LATER)
    with pytest.raises(ValueError):
        fires.fire_emissions(START + timedelta(minutes=30), 1, LATER)
