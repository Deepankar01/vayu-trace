import json
from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest

from vayu.constants import DT_S
from vayu.domain import NX, NY, TAGS, cell_area_m2
from vayu.emissions import Emissions
from vayu.errors import UpstreamError
from vayu.met import MetRaw, MetSample, lattice
from vayu.sim import particles, run
from vayu.sim.run import (
    RunResult,
    fires_assumed_from,
    haze_factor,
    load_run,
    parcels_per_tag_hour,
    run_date,
    run_window,
    simulate,
)

NOW = datetime(2026, 11, 11, 7, 30, tzinfo=UTC)
START = datetime(2023, 11, 3, tzinfo=UTC)
ALL_TAG_IDS = [t.id for t in TAGS]
STEPS = 3600 // DT_S


class StubMet:
    """Uniform met everywhere; `blh` may be a function of time (hours)."""

    def __init__(self, hours=100, u=0.0, v=0.0, blh=500.0, rh=0.5, precip=0.0):
        self.hours = hours
        self.blh_estimated = False
        self.u, self.v, self.blh, self.rh, self.precip = u, v, blh, rh, precip

    def sample(self, lon, lat, t_hours):
        shape = np.broadcast(np.asarray(lon), np.asarray(lat), np.asarray(t_hours)).shape
        full = lambda x: np.full(shape, x, dtype=float)
        blh = self.blh(float(t_hours)) if callable(self.blh) else self.blh
        return MetSample(full(self.u), full(self.v), full(blh), full(self.rh), full(20.0),
                         full(self.precip))


def flat():
    return np.zeros((NY, NX), dtype=np.float32)


def two_tag_emissions(hours):
    em = Emissions()
    for h in range(hours):
        em.add("vehicles_delhi_ncr", h, [226, 226, 227], [112, 113, 112], [3.0, 1.0, 0.5])
        em.add("fire_punjab", h, [240, 241], [100, 101], [2.0, 0.25 * (h + 1)])
    return em


def one_cell(tag, iy, ix, kg=1.0):
    em = Emissions()
    em.add(tag, 0, [iy], [ix], [kg])
    return em


# --- window ---

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


def test_window_rejects_future_date_and_naive_now():
    with pytest.raises(ValueError):
        run_window(date(2026, 11, 12), NOW)
    with pytest.raises(ValueError):
        run_window(date(2023, 11, 5), datetime(2026, 11, 11))


def test_fires_assumed_from():
    assert fires_assumed_from(datetime(2026, 11, 8, tzinfo=UTC), NOW, 144) == 72  # today
    assert fires_assumed_from(datetime(2026, 11, 8, tzinfo=UTC), NOW, 72) is None
    assert fires_assumed_from(START, NOW, 144) is None
    assert fires_assumed_from(datetime(2026, 11, 11, 3, tzinfo=UTC), NOW, 144) == 0


def test_parcel_budget_catalogue():
    assert parcels_per_tag_hour("industry_rest_of_india") == 400
    assert parcels_per_tag_hour("dust_rest_of_india") == 400
    assert parcels_per_tag_hour("industry_bihar") == 100
    assert parcels_per_tag_hour("fire_other") == 100
    assert sum(parcels_per_tag_hour(t) == 400 for t in ALL_TAG_IDS) == 4


# --- fields ---

def test_haze_factor():
    np.testing.assert_allclose(haze_factor(np.array([0.0, 0.5, 0.95, 0.99])),
                               [1.0, 1.125, 5.5125, 5.5125])
    assert np.isnan(haze_factor(np.array([np.nan])))[0]


def test_concentration_units(tmp_path, monkeypatch):
    """Hour mean of 1 kg released in one cell, mixing height rising 100 m per hour."""
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)  # parcels stay in their cell
    blh = lambda t: 300.0 + 100.0 * t
    iy, ix = 200, 150
    res = simulate(one_cell("industry_bihar", iy, ix), StubMet(3, blh=blh), flat(), START, 2,
                   tmp_path / "run", spinup_h=0, particles_per_tag_hour=10)
    # Mass sampled before each step: surviving fraction after the deposition so far.
    frac, samples = 1.0, []
    for i in range(2 * STEPS):
        samples.append(frac)
        frac *= np.exp(-particles.V_DEP_M_S / blh(i / STEPS) * DT_S)
    for h in range(2):
        field = res.frame(h)["industry_bihar"]
        assert field.dtype == np.float32 and field.shape == (NY, NX)
        mean_kg = np.mean(samples[h * STEPS:(h + 1) * STEPS])
        volume_blh = 0.5 * (blh(h) + blh(h + 1))  # mean of the hour's start and end
        expected = mean_kg * 1e9 / (cell_area_m2()[iy] * volume_blh)
        np.testing.assert_allclose(field[iy, ix], expected, rtol=1e-5)
        assert np.count_nonzero(field) == 1  # young parcels are not smoothed


def test_linearity(tmp_path):
    em = two_tag_emissions(6)
    met = StubMet(u=4.0, v=-1.5)
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


def test_linearity_any_factor_with_depletion(tmp_path, monkeypatch):
    counts = {"a": [], "b": []}
    real_step = run.step
    current = []

    def recording_step(p, *args, **kw):
        out, stats = real_step(p, *args, **kw)
        counts[current[0]].append(len(out))
        return out, stats

    monkeypatch.setattr(run, "step", recording_step)
    em = two_tag_emissions(8)
    met = StubMet(u=2.0, v=1.0, precip=5.0)  # washout removes ~66 % per hour
    current[:] = ["a"]
    a = simulate(em, met, flat(), START, 4, tmp_path / "a", spinup_h=4, seed=3,
                 particles_per_tag_hour=40)
    current[:] = ["b"]
    b = simulate(em.scaled(0.7), met, flat(), START, 4, tmp_path / "b", spinup_h=4, seed=3,
                 particles_per_tag_hour=40)
    assert counts["a"] == counts["b"] and len(counts["a"]) == 8 * STEPS
    assert a.step_stats == b.step_stats and a.step_stats["depleted"] > 0
    for h in range(4):
        fa, fb = a.frame(h), b.frame(h)
        assert np.any(fa["fire_punjab"])
        for tag in ALL_TAG_IDS:
            np.testing.assert_allclose(fb[tag], 0.7 * fa[tag].astype(float), rtol=1e-6)


def test_spinup_not_in_output(tmp_path):
    res = simulate(two_tag_emissions(5), StubMet(), flat(), START, 3, tmp_path / "run",
                   spinup_h=2, particles_per_tag_hour=5)
    assert res.hours == 3
    assert sorted(p.name for p in (tmp_path / "run").glob("frame_*.npz")) == [
        "frame_000.npz", "frame_001.npz", "frame_002.npz"]
    assert np.any(res.frame(0)["vehicles_delhi_ncr"])
    with pytest.raises(IndexError):
        res.frame(3)
    assert res.start == START


def test_zero_emission_tag_is_zero_field(tmp_path):
    em = two_tag_emissions(3)
    em.add("dust_punjab", 0, [240], [100], [0.0])
    res = simulate(em, StubMet(), flat(), START, 2, tmp_path / "run", spinup_h=1,
                   particles_per_tag_hour=5)
    assert res.tags == ALL_TAG_IDS
    for h in range(2):
        frame = res.frame(h)
        assert list(frame) == ALL_TAG_IDS
        for tag in ("dust_punjab", "industry_bihar"):
            assert frame[tag].shape == (NY, NX) and frame[tag].dtype == np.float32
            assert not np.any(frame[tag])


def test_missing_blh_stays_missing(tmp_path):
    res = simulate(two_tag_emissions(2), StubMet(blh=np.nan), flat(), START, 1, tmp_path / "run",
                   spinup_h=1, particles_per_tag_hour=5)
    frame = res.frame(0)
    assert np.isnan(frame["vehicles_delhi_ncr"]).all()
    assert np.isnan(frame["industry_bihar"]).all()  # omitted tags carry the same gaps
    assert res.step_stats["missing_met"] == 20  # 10 parcels released in each of 2 hours


def test_haze_and_fire_age_grids(tmp_path, monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    em = one_cell("fire_punjab", 240, 100)
    em.add("vehicles_delhi_ncr", 0, [226], [112], [1.0])
    res = simulate(em, StubMet(rh=0.5), flat(), START, 3, tmp_path / "run", spinup_h=0,
                   particles_per_tag_hour=4)
    np.testing.assert_allclose(res.haze(1), 1.125)
    # Samples at ages h, h + 1/6, ..., h + 5/6; the earlier ones carry slightly more mass, so the
    # lower weighted median is the third sample.
    for h in (0, 2):
        age = res.fire_age_h(h)
        assert age[240, 100] == pytest.approx(h + 1 / 3, abs=1e-4)
        age[240, 100] = np.nan
        assert np.isnan(age).all()  # vehicle parcels do not count; empty cells are NaN


def test_weighted_median_by_cell():
    cell = np.array([5, 5, 5, 2, 2, 9])
    age = np.array([3.0, 1.0, 2.0, 7.0, 4.0, 6.0])
    w = np.array([1.0, 1.0, 5.0, 1.0, 3.0, 2.0])
    out = run._weighted_median_by_cell(cell, age, w, 10)
    assert out[5] == 2.0 and out[2] == 4.0 and out[9] == 6.0
    assert np.isnan(out[[0, 1, 3, 4, 6, 7, 8]]).all()


# --- smoothing kernel ---

@pytest.mark.parametrize("r", [1, 2])
def test_box_spread_conserves_mass_including_edges(r):
    rng = np.random.default_rng(0)
    m = np.zeros((NY, NX))
    m[rng.integers(0, NY, 300), rng.integers(0, NX, 300)] = rng.uniform(0, 1e3, 300)
    m[0, 0] = m[0, NX - 1] = m[NY - 1, 0] = m[NY - 1, NX - 1] = 5.0  # corners
    m[0, 100] = m[150, NX - 1] = m[1, 1] = 7.0  # edges and one cell in
    out = run._box_spread(m, r)
    assert out.sum() == pytest.approx(m.sum(), rel=1e-6)
    assert (out >= 0).all()


def test_box_spread_corner_shares_equally_over_in_domain_cells():
    m = np.zeros((NY, NX))
    m[0, NX - 1] = 9.0
    out = run._box_spread(m, 2)
    assert np.count_nonzero(out) == 9  # 3 x 3 of the 5 x 5 box is inside the domain
    np.testing.assert_allclose(out[:3, NX - 3:], 1.0)


def test_box_spread_untouched_cells_stay_exactly_zero():
    m = np.zeros((NY, NX))
    m[100, 100] = 1e12
    m[200, 200] = 1e-6
    out = run._box_spread(m, 1)
    assert np.count_nonzero(out) == 18
    assert out[150, 150] == 0.0


@pytest.mark.parametrize("spinup, width", [(10, 3), (25, 5)])
def test_aged_parcels_are_spread(tmp_path, monkeypatch, spinup, width):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    iy, ix = 200, 150
    res = simulate(one_cell("industry_bihar", iy, ix), StubMet(), flat(), START, 1,
                   tmp_path / "run", spinup_h=spinup, particles_per_tag_hour=10)
    field = res.frame(0)["industry_bihar"].astype(float)
    assert np.count_nonzero(field) == width * width
    r = width // 2
    box_mass = field[iy - r:iy + r + 1, ix - r:ix + r + 1] * cell_area_m2()[
        iy - r:iy + r + 1, None] * 500.0 / 1e9
    np.testing.assert_allclose(box_mass, box_mass[0, 0], rtol=1e-6)  # equal shares of mass
    frac = np.exp(-particles.V_DEP_M_S / 500.0 * DT_S * (spinup * STEPS + np.arange(STEPS)))
    assert box_mass.sum() == pytest.approx(frac.mean(), rel=1e-5)  # nothing lost to the kernel


# --- simulate housekeeping ---

def test_rejects_unknown_tag(tmp_path):
    em = Emissions()
    em.add("not_a_tag", 0, [1], [1], [1.0])
    with pytest.raises(ValueError, match="not_a_tag"):
        simulate(em, StubMet(), flat(), START, 1, tmp_path / "run", spinup_h=1)


def test_met_must_cover_the_last_hour_end(tmp_path):
    with pytest.raises(ValueError, match="met covers"):
        simulate(two_tag_emissions(3), StubMet(hours=3), flat(), START, 2, tmp_path / "run",
                 spinup_h=1)


def test_default_budget_gives_rest_of_india_more_parcels(tmp_path):
    em = one_cell("industry_rest_of_india", 100, 100)
    em.add("industry_bihar", 0, [200], [200], [1.0])
    res = simulate(em, StubMet(), flat(), START, 1, tmp_path / "run", spinup_h=1)
    meta = json.loads((res.out_dir / "run.json").read_text())
    assert meta["peak_parcels"] == 500
    assert meta["parcels_per_tag_hour"] == {"industry_bihar": 100, "industry_rest_of_india": 400}
    assert meta["frame_semantics"] == "hour_mean"


def test_progress_monotonic_and_ends_at_1(tmp_path):
    calls = []
    simulate(two_tag_emissions(4), StubMet(), flat(), START, 2, tmp_path / "run", spinup_h=2,
             particles_per_tag_hour=5, progress=lambda f, s: calls.append((f, s)))
    fractions = [f for f, _ in calls]
    assert fractions == sorted(fractions)
    assert fractions[-1] == 1.0
    assert any("simulating hour 4/4" == s for _, s in calls)


def test_failed_run_keeps_previous_and_leaves_no_temp_dirs(tmp_path, monkeypatch):
    out = tmp_path / "runs" / "x"
    first = simulate(two_tag_emissions(3), StubMet(), flat(), START, 2, out, spinup_h=1,
                     particles_per_tag_hour=5, fires_assumed_from=1)
    assert first.fires_assumed_from == 1

    def broken(*a, **kw):
        raise RuntimeError("boom")

    monkeypatch.setattr(run, "step", broken)
    with pytest.raises(RuntimeError, match="boom"):
        simulate(two_tag_emissions(3), StubMet(), flat(), START, 2, out, spinup_h=1)
    assert [p.name for p in out.parent.iterdir()] == ["x"]
    assert RunResult.from_dir(out) is not None


def test_rerun_replaces_existing_directory(tmp_path):
    out = tmp_path / "run"
    simulate(two_tag_emissions(4), StubMet(), flat(), START, 3, out, spinup_h=1,
             particles_per_tag_hour=5)
    res = simulate(two_tag_emissions(3), StubMet(), flat(), START, 2, out, spinup_h=1,
                   particles_per_tag_hour=5)
    assert res.hours == 2 and not (out / "frame_002.npz").exists()
    assert [p.name for p in tmp_path.iterdir()] == ["run"]


@pytest.mark.parametrize("content", ["{", '{"complete": true}', '["complete"]',
                                     '{"complete": true, "hours": "x"}'])
def test_from_dir_malformed_run_json_is_none(tmp_path, content):
    (tmp_path / "run.json").write_text(content)
    assert RunResult.from_dir(tmp_path) is None


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


PAST = date(2023, 11, 5)


def test_run_date_builds_spun_up_window(offline, tmp_path):
    progress = []
    res = run_date(PAST, NOW, lambda f, s: progress.append((f, s)))
    sim_start = START - timedelta(hours=2)
    assert offline["fires"] == [(sim_start, 5, NOW)]
    assert offline["met"] == [(sim_start, 6, NOW)]  # one hour more: the last hour's end
    assert res.hours == 3 and res.start == START and res.forecast_from is None
    assert res.fires_assumed_from is None and res.made_at == NOW
    meta = json.loads((tmp_path / "runs" / "2023-11-05" / "run.json").read_text())
    assert meta["complete"] is True and meta["start"] == START.isoformat()
    assert meta["format_version"] == 2 and meta["frame_semantics"] == "hour_mean"
    assert meta["made_at"] == NOW.isoformat()
    assert meta["constants"] == run.constants_snapshot()
    assert meta["constants"]["DT_S"] == 600 and meta["constants"]["PARTICLES_PER_TAG_HOUR"] == 5
    fractions = [f for f, _ in progress]
    assert fractions == sorted(fractions) and fractions[-1] == 1.0
    stages = [s for _, s in progress]
    for stage in ("fetching fires", "fetching weather", "terrain", "writing"):
        assert stage in stages


def test_cached_second_call_does_not_simulate(offline):
    first = run_date(PAST, NOW, lambda f, s: None)
    progress = []
    second = run_date(PAST, NOW, lambda f, s: progress.append(f))
    assert offline["simulate"] == 1
    assert progress[-1] == 1.0
    for tag, field in first.frame(2).items():
        np.testing.assert_array_equal(second.frame(2)[tag], field)


def test_final_run_is_served_later(offline):
    run_date(PAST, NOW, lambda f, s: None)
    assert load_run(PAST, NOW + timedelta(days=30)) is not None


def test_recent_run_goes_stale(offline):
    today = NOW.date()
    run_date(today, NOW, lambda f, s: None)
    assert load_run(today, NOW + timedelta(minutes=59)) is not None
    assert load_run(today, NOW + timedelta(hours=2)) is None  # not final, older than an hour
    assert load_run(today, NOW + timedelta(days=1)) is None  # window moved as well
    run_date(today, NOW + timedelta(hours=2), lambda f, s: None)
    assert offline["simulate"] == 2


def test_changed_constants_invalidate(offline, monkeypatch):
    run_date(PAST, NOW, lambda f, s: None)
    monkeypatch.setattr(particles, "K_H_M2_S", 1000)
    assert load_run(PAST, NOW) is None


def test_old_format_invalidates(offline, tmp_path):
    run_date(PAST, NOW, lambda f, s: None)
    path = tmp_path / "runs" / "2023-11-05" / "run.json"
    meta = json.loads(path.read_text())
    meta["format_version"] = 1
    path.write_text(json.dumps(meta))
    assert load_run(PAST, NOW) is None


def test_upstream_error_propagates_and_leaves_no_run(offline, monkeypatch, tmp_path):
    def broken(start, hours, now):
        raise UpstreamError("open-meteo", "HTTP 500")

    monkeypatch.setattr(run, "fetch_met", broken)
    with pytest.raises(UpstreamError):
        run_date(PAST, NOW, lambda f, s: None)
    assert load_run(PAST, NOW) is None
    assert not (tmp_path / "runs").exists() or not any((tmp_path / "runs").iterdir())


def test_load_run_needs_complete_marker_and_all_frames(offline, tmp_path):
    run_date(PAST, NOW, lambda f, s: None)
    assert isinstance(load_run(PAST, NOW), RunResult)
    folder = tmp_path / "runs" / "2023-11-05"
    (folder / "frame_002.npz").unlink()
    assert load_run(PAST, NOW) is None
    (folder / "run.json").unlink()
    assert load_run(PAST, NOW) is None
