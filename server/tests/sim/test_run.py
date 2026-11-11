import json
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest

from vayu.domain import NX, NY, TAGS, cell_area_m2
from vayu.emissions import Emissions
from vayu.errors import UpstreamError
from vayu.met import MetRaw, MetSample, lattice
from vayu.sim import particles, run
from vayu.sim.run import RunResult, haze_factor, load_run, run_date, run_window, simulate

NOW = datetime(2026, 11, 11, 7, 30, tzinfo=UTC)
START = datetime(2023, 11, 3, tzinfo=UTC)
ALL_TAG_IDS = [t.id for t in TAGS]


class StubMet:
    """Uniform met everywhere and at all times."""

    def __init__(self, hours, u=0.0, v=0.0, blh=500.0, rh=0.5, precip=0.0):
        self.hours = hours
        self.blh_estimated = False
        self.u, self.v, self.blh, self.rh, self.precip = u, v, blh, rh, precip

    def sample(self, lon, lat, t_hours):
        shape = np.broadcast(np.asarray(lon), np.asarray(lat), np.asarray(t_hours)).shape
        full = lambda x: np.full(shape, x, dtype=float)
        return MetSample(full(self.u), full(self.v), full(self.blh), full(self.rh), full(20.0),
                         full(self.precip))


def flat():
    return np.zeros((NY, NX), dtype=np.float32)


def two_tag_emissions(hours):
    em = Emissions()
    for h in range(hours):
        em.add("vehicles_delhi_ncr", h, [226, 226, 227], [112, 113, 112], [3.0, 1.0, 0.5])
        em.add("fire_punjab", h, [240, 241], [100, 101], [2.0, 0.25 * (h + 1)])
    return em


def test_window_past_date():
    assert run_window(date(2023, 11, 5), NOW) == (START, None)


def test_window_today():
    start, forecast_from = run_window(NOW.date(), NOW)
    assert start == datetime(2026, 11, 8, tzinfo=UTC)
    hours_since = int((NOW - start) / timedelta(hours=1))
    assert forecast_from == hours_since + 1 == 80


def test_window_today_on_the_hour_is_not_forecast():
    now = datetime(2026, 11, 11, 7, tzinfo=UTC)
    assert run_window(now.date(), now) == (datetime(2026, 11, 8, tzinfo=UTC), 80)


def test_window_recent_past_date_reaches_into_forecast():
    start, forecast_from = run_window(date(2026, 11, 10), NOW)
    assert start == datetime(2026, 11, 8, tzinfo=UTC)
    assert forecast_from == 80


def test_window_rejects_future_date():
    with pytest.raises(ValueError):
        run_window(date(2026, 11, 12), NOW)


def test_haze_factor():
    np.testing.assert_allclose(haze_factor(np.array([0.0, 0.5, 0.95, 0.99])),
                               [1.0, 1.125, 5.5125, 5.5125])
    assert np.isnan(haze_factor(np.array([np.nan])))[0]


def test_concentration_units(tmp_path, monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)  # parcels stay in their cell
    iy, ix = 200, 150
    em = Emissions()
    em.add("industry_bihar", 0, [iy], [ix], [1.0])
    res = simulate(em, StubMet(2), flat(), START, 2, tmp_path, spinup_h=0,
                   particles_per_tag_hour=10)
    assert not np.any(res.frame(0)["industry_bihar"])  # frame 0 is before hour 0's release
    field = res.frame(1)["industry_bihar"]
    assert field.dtype == np.float32 and field.shape == (NY, NX)
    deposited = np.exp(-particles.V_DEP_M_S / 500.0 * 3600)  # one hour of dry deposition
    expected = 1.0 * deposited * 1e9 / (cell_area_m2()[iy] * 500.0)
    np.testing.assert_allclose(field[iy, ix], expected, rtol=1e-5)
    field[iy, ix] = 0
    assert not np.any(field)


def test_linearity(tmp_path):
    em = two_tag_emissions(6)
    met = StubMet(6, u=4.0, v=-1.5)
    a = simulate(em, met, flat(), START, 3, tmp_path / "a", spinup_h=3, seed=7,
                 particles_per_tag_hour=50)
    b = simulate(em.scaled(2.0), met, flat(), START, 3, tmp_path / "b", spinup_h=3, seed=7,
                 particles_per_tag_hour=50)
    for h in range(3):
        fa, fb = a.frame(h), b.frame(h)
        assert np.any(fa["vehicles_delhi_ncr"]) and np.any(fa["fire_punjab"])
        for tag in ALL_TAG_IDS:
            np.testing.assert_array_equal(fb[tag], 2 * fa[tag])
        np.testing.assert_array_equal(a.fire_age_h(h), b.fire_age_h(h))


def test_spinup_not_in_output(tmp_path):
    em = two_tag_emissions(5)
    res = simulate(em, StubMet(5), flat(), START, 3, tmp_path, spinup_h=2,
                   particles_per_tag_hour=5)
    assert res.hours == 3
    assert sorted(p.name for p in tmp_path.glob("frame_*.npz")) == [
        "frame_000.npz", "frame_001.npz", "frame_002.npz"]
    assert np.any(res.frame(0)["vehicles_delhi_ncr"])  # spin-up releases are already present
    with pytest.raises(IndexError):
        res.frame(3)
    assert res.start == START


def test_zero_emission_tag_is_zero_field(tmp_path):
    em = two_tag_emissions(3)
    em.add("dust_punjab", 0, [240], [100], [0.0])
    res = simulate(em, StubMet(3), flat(), START, 2, tmp_path, spinup_h=1,
                   particles_per_tag_hour=5)
    assert res.tags == ALL_TAG_IDS
    for h in range(2):
        frame = res.frame(h)
        assert list(frame) == ALL_TAG_IDS
        for tag in ("dust_punjab", "industry_bihar"):
            assert frame[tag].shape == (NY, NX) and frame[tag].dtype == np.float32
            assert not np.any(frame[tag])


def test_missing_blh_stays_missing(tmp_path):
    em = two_tag_emissions(2)
    res = simulate(em, StubMet(2, blh=np.nan), flat(), START, 1, tmp_path, spinup_h=1,
                   particles_per_tag_hour=5)
    frame = res.frame(0)
    assert np.isnan(frame["vehicles_delhi_ncr"]).all()
    assert np.isnan(frame["industry_bihar"]).all()  # omitted tags carry the same gaps
    assert res.step_stats["missing_met"] == 10


def test_haze_and_fire_age_grids(tmp_path, monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    em = Emissions()
    em.add("fire_punjab", 0, [240], [100], [1.0])
    em.add("vehicles_delhi_ncr", 0, [226], [112], [1.0])
    res = simulate(em, StubMet(3, rh=0.5), flat(), START, 3, tmp_path, spinup_h=0,
                   particles_per_tag_hour=4)
    np.testing.assert_allclose(res.haze(1), 1.125)
    age = res.fire_age_h(2)
    assert age[240, 100] == pytest.approx(2.0)
    age[240, 100] = np.nan
    assert np.isnan(age).all()  # vehicle parcels do not count; empty cells are NaN
    assert np.isnan(res.fire_age_h(0)).all()


def test_weighted_median_by_cell():
    cell = np.array([5, 5, 5, 2, 2, 9])
    age = np.array([3.0, 1.0, 2.0, 7.0, 4.0, 6.0])
    w = np.array([1.0, 1.0, 5.0, 1.0, 3.0, 2.0])
    out = run._weighted_median_by_cell(cell, age, w, 10)
    assert out[5] == 2.0 and out[2] == 4.0 and out[9] == 6.0
    assert np.isnan(out[[0, 1, 3, 4, 6, 7, 8]]).all()


def test_rejects_unknown_tag(tmp_path):
    em = Emissions()
    em.add("not_a_tag", 0, [1], [1], [1.0])
    with pytest.raises(ValueError, match="not_a_tag"):
        simulate(em, StubMet(2), flat(), START, 1, tmp_path, spinup_h=1)


def test_progress_monotonic_and_ends_at_1(tmp_path):
    calls = []
    simulate(two_tag_emissions(4), StubMet(4), flat(), START, 2, tmp_path, spinup_h=2,
             particles_per_tag_hour=5, progress=lambda f, s: calls.append((f, s)))
    fractions = [f for f, _ in calls]
    assert fractions == sorted(fractions)
    assert fractions[-1] == 1.0
    assert any("simulating hour 4/4" == s for _, s in calls)


# --- run_date / load_run, with every upstream replaced ---

def fake_raw(start, hours):
    lon, lat = lattice()
    shape = (hours, len(lat), len(lon))
    values = {
        "wind_speed_10m": 2.0, "wind_direction_10m": 270.0, "wind_speed_100m": 3.0,
        "wind_direction_100m": 270.0, "temperature_2m": 20.0, "relative_humidity_2m": 60.0,
        "precipitation": 0.0, "boundary_layer_height": 600.0,
    }
    return MetRaw(start, hours, lon, lat,
                  {k: np.full(shape, v, dtype=np.float32) for k, v in values.items()})


@pytest.fixture
def offline(monkeypatch):
    """Short window, few parcels, and fake fires / inventory / weather / terrain."""
    monkeypatch.setattr(run, "WINDOW_H", 3)
    monkeypatch.setattr(run, "SPINUP_H", 2)
    monkeypatch.setattr(run, "PARTICLES_PER_TAG_HOUR", 5)
    calls = {"fires": [], "met": [], "simulate": 0}

    def fires(start, hours, now):
        calls["fires"].append((start, hours, now))
        return two_tag_emissions(hours)

    def met(start, hours, now):
        calls["met"].append((start, hours, now))
        return fake_raw(start, hours)

    real_simulate = run.simulate

    def counting_simulate(*a, **kw):
        calls["simulate"] += 1
        return real_simulate(*a, **kw)

    monkeypatch.setattr(run, "fire_emissions", fires)
    monkeypatch.setattr(run, "inventory_emissions", Emissions)
    monkeypatch.setattr(run, "fetch_met", met)
    monkeypatch.setattr(run, "elevation", flat)
    monkeypatch.setattr(run, "simulate", counting_simulate)
    return calls


def test_run_date_builds_spun_up_window(offline, tmp_path):
    progress = []
    res = run_date(date(2023, 11, 5), NOW, lambda f, s: progress.append((f, s)))
    sim_start = START - timedelta(hours=2)
    assert offline["fires"] == [(sim_start, 5, NOW)]
    assert offline["met"] == [(sim_start, 5, NOW)]
    assert res.hours == 3 and res.start == START and res.forecast_from is None
    meta = json.loads((tmp_path / "runs" / "2023-11-05" / "run.json").read_text())
    assert meta["complete"] is True and meta["start"] == START.isoformat()
    assert meta["particles_per_tag_hour"] == 5 and meta["dt_s"] == 600
    fractions = [f for f, _ in progress]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    stages = [s for _, s in progress]
    for stage in ("fetching fires", "fetching weather", "terrain", "writing"):
        assert stage in stages


def test_cached_second_call_does_not_simulate(offline):
    first = run_date(date(2023, 11, 5), NOW, lambda f, s: None)
    progress = []
    second = run_date(date(2023, 11, 5), NOW, lambda f, s: progress.append(f))
    assert offline["simulate"] == 1
    assert progress[-1] == 1.0
    for tag, field in first.frame(2).items():
        np.testing.assert_array_equal(second.frame(2)[tag], field)


def test_upstream_error_propagates_and_leaves_no_run(offline, monkeypatch):
    def broken(start, hours, now):
        raise UpstreamError("open-meteo", "HTTP 500")

    monkeypatch.setattr(run, "fetch_met", broken)
    with pytest.raises(UpstreamError):
        run_date(date(2023, 11, 5), NOW, lambda f, s: None)
    assert load_run(date(2023, 11, 5)) is None


def test_load_run_needs_complete_marker_and_all_frames(offline, tmp_path):
    run_date(date(2023, 11, 5), NOW, lambda f, s: None)
    assert isinstance(load_run(date(2023, 11, 5)), RunResult)
    folder = tmp_path / "runs" / "2023-11-05"
    (folder / "frame_002.npz").unlink()
    assert load_run(date(2023, 11, 5)) is None
    (folder / "run.json").unlink()
    assert load_run(date(2023, 11, 5)) is None
