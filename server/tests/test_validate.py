from datetime import UTC, date, datetime, timedelta

import numpy as np
import pytest

from vayu import validate
from vayu.validate import metrics

START = datetime(2025, 11, 3, tzinfo=UTC)


def wave(n=48, base=100.0):
    return base + 50 * np.sin(np.arange(n) / 3.0)


def test_perfect_match():
    obs = wave()
    m = metrics(obs.copy(), obs)
    assert m["n"] == 48
    assert m["r"] == pytest.approx(1.0)
    assert m["bias"] == pytest.approx(0.0, abs=1e-12)
    assert m["nmb"] == pytest.approx(0.0, abs=1e-12) and m["rmse"] == pytest.approx(0.0, abs=1e-9)
    assert m["fac2"] == 1.0


def test_constant_offset():
    obs = np.full(48, 100.0)  # constant measured, sim half of it
    m = metrics(obs / 2, obs)
    assert m["bias"] == pytest.approx(-50.0)
    assert m["nmb"] == pytest.approx(-0.5)
    assert m["rmse"] == pytest.approx(50.0)
    assert m["r"] is None  # zero variance: correlation undefined, not a number
    assert m["fac2"] == 1.0  # exactly a factor of two counts as within


def test_ignores_nan_pairs():
    obs = wave(60)
    sim = obs * 1.5
    sim[:10] = np.nan
    obs[10:20] = np.nan
    m = metrics(sim, obs)
    assert m["n"] == 40
    assert m["nmb"] == pytest.approx(0.5)
    assert m["r"] == pytest.approx(1.0)


def test_too_few_points_returns_none():
    obs = wave(30)
    sim = obs.copy()
    sim[:7] = np.nan  # 23 pairs
    m = metrics(sim, obs)
    assert m["n"] == 23
    assert all(m[k] is None for k in ("r", "bias", "nmb", "rmse", "fac2"))
    assert metrics(sim[:0], obs[:0])["n"] == 0


def test_fac2_counts_within_factor_two_of_positive_obs():
    obs = np.array([10.0] * 24 + [0.0] * 4)
    sim = np.array([5.0, 20.0, 4.9, 20.1] + [10.0] * 20 + [3.0] * 4)
    m = metrics(sim, obs)
    assert m["n"] == 28
    # obs = 0 hours are excluded from fac2 only; 22 of the 24 positive-obs hours are within
    assert m["fac2"] == pytest.approx(22 / 24)


def test_day_night_masks_follow_ist():
    day, night = validate.day_night_masks(START, 48)
    # IST = UTC + 5:30; an hour [t, t+1) UTC starts at t + 5:30 IST
    assert np.flatnonzero(day[:24]).tolist() == [5, 6, 7, 8, 9, 10, 11, 12]  # 10:30-17:30 IST
    assert np.flatnonzero(night[:24]).tolist() == [0, 17, 18, 19, 20, 21, 22, 23]  # 22:30-05:30
    assert not (day & night).any()
    assert day.sum() == 16 and night.sum() == 16


def test_bias_split_day_and_night():
    hours = 24 * 7
    obs = np.full(hours, 100.0)
    day, night = validate.day_night_masks(START, hours)
    sim = np.where(day, 60.0, np.where(night, 180.0, 100.0))
    out = validate.bias_split(sim, obs, START)
    assert out["day"] == {"n": 56, "bias": pytest.approx(-40.0), "nmb": pytest.approx(-0.4)}
    assert out["night"] == {"n": 56, "bias": pytest.approx(80.0), "nmb": pytest.approx(0.8)}
    short = validate.bias_split(sim[:24], obs[:24], START)
    assert short["day"] == {"n": 8, "bias": None, "nmb": None}


def test_simulated_total_is_null_where_any_tag_is_null():
    by_tag = {"a": [1.0, None, 3.0], "b": [2.0, 2.0, None], "c": [0.5, 0.5, 0.5]}
    out = validate.simulated_total(by_tag, 3)
    assert out[0] == pytest.approx(3.5) and np.isnan(out[1]) and np.isnan(out[2])
    assert validate.simulated_total({}, 2).tolist() == [0.0, 0.0]


def test_segments_cover_every_hour_once():
    segs = validate.segments(date(2025, 11, 3), date(2025, 11, 9))
    assert segs == [
        (date(2025, 11, 5), datetime(2025, 11, 3, tzinfo=UTC), 144),
        (date(2025, 11, 6), datetime(2025, 11, 9, tzinfo=UTC), 24),
    ]
    long = validate.segments(date(2025, 11, 1), date(2025, 11, 14))
    starts = [s for _, s, _ in long]
    assert sum(n for *_, n in long) == 14 * 24
    for (day, first, n), nxt in zip(long, starts[1:] + [None], strict=True):
        window0 = datetime.combine(day - timedelta(days=2), datetime.min.time(), tzinfo=UTC)
        assert window0 <= first and first + timedelta(hours=n) <= window0 + timedelta(hours=144)
        if nxt is not None:
            assert first + timedelta(hours=n) == nxt


def _series(n, sim_scale, offset=0.0):
    obs = wave(n) + offset
    return obs * sim_scale, obs


def test_report_rows_and_pooled():
    hours = 48
    data = {}
    for cid, scale in (("delhi", 0.5), ("noida", 1.0), ("patna", 2.0)):
        sim, obs = _series(hours, scale)
        data[cid] = {"sim": sim, "obs": obs, "cams": obs * 1.1, "stations": 3}
    data["patna"]["obs"][:] = np.nan  # no measurements at all
    report = validate.build_report(data, START, hours, pools={"all": ["delhi", "noida", "patna"],
                                                              "ncr": ["delhi", "noida"]})
    rows = {r["id"]: r for r in report["cities"]}
    assert rows["delhi"]["model"]["nmb"] == pytest.approx(-0.5)
    assert rows["noida"]["model"]["nmb"] == pytest.approx(0.0, abs=1e-12)
    assert rows["noida"]["cams"]["nmb"] == pytest.approx(0.1)
    assert rows["patna"]["model"]["n"] == 0 and rows["patna"]["model"]["r"] is None
    assert rows["patna"]["mean_measured"] is None
    assert rows["delhi"]["mean_sim"] == pytest.approx(np.mean(data["delhi"]["sim"]))
    pooled = {p["id"]: p for p in report["pooled"]}
    assert pooled["ncr"]["model"]["n"] == 96
    # pooled NMB is the ratio of sums over all pairs, not a mean of city NMBs
    assert pooled["ncr"]["model"]["nmb"] == pytest.approx(-0.25)
    assert pooled["all"]["model"]["n"] == 96  # patna adds no pairs
    assert pooled["all"]["cities"] == ["delhi", "noida", "patna"]


def test_markdown_states_no_fitting_and_the_numbers():
    hours = 48
    sim, obs = _series(hours, 0.5)
    report = validate.build_report({"delhi": {"sim": sim, "obs": obs, "cams": obs, "stations": 2}},
                                   START, hours, pools={"all": ["delhi"]})
    report.update(validate.provenance([], generated=datetime(2026, 11, 11, tzinfo=UTC)))
    md = validate.render_markdown(report)
    assert "No parameter was fitted to these measurements." in md
    assert "| Delhi |" in md and "-0.50" in md


def test_cams_is_compared_over_the_model_hours():
    hours = 72
    obs = wave(hours)
    sim = obs * 0.5
    sim[:10] = np.nan  # model missing: CAMS must not use these hours either
    cams = obs * 1.2
    cams[30:40] = np.nan  # CAMS gap
    report = validate.build_report({"delhi": {"sim": sim, "obs": obs, "cams": cams,
                                              "stations": 1}}, START, hours,
                                   pools={"all": ["delhi"]})
    row = report["cities"][0]
    assert row["model"]["n"] == 62
    assert row["cams"]["n"] == 52  # hours where sim, obs and CAMS all exist
    assert row["cams_own"]["n"] == 62  # CAMS's own hours: 72 - 10
    assert row["cams"]["nmb"] == pytest.approx(0.2)
    assert row["mean_measured_cams"] == pytest.approx(np.mean(np.r_[obs[10:30], obs[40:]]))
    assert report["pooled"][0]["cams"]["n"] == 52


def test_pooled_rows_carry_per_city_r_statistics():
    hours = 48
    rng = np.random.default_rng(0)
    data = {}
    for cid in ("delhi", "noida", "patna"):
        obs = wave(hours) + rng.normal(0, 10, hours)
        data[cid] = {"sim": obs + rng.normal(0, 20, hours), "obs": obs,
                     "cams": obs + rng.normal(0, 5, hours), "stations": 1}
    report = validate.build_report(data, START, hours, pools={"all": list(data)})
    rs = report["pooled"][0]["r_per_city"]
    per_city = [r["model"]["r"] for r in report["cities"]]
    assert rs["cities"] == 3
    assert rs["model"]["median"] == pytest.approx(np.median(per_city))
    assert rs["model"]["mean"] == pytest.approx(np.mean(per_city))
    assert rs["model"]["min"] == pytest.approx(min(per_city))
    assert rs["model_r_gt_cams_r"] == sum(r["model"]["r"] > r["cams"]["r"]
                                          for r in report["cities"])
    md = validate.render_markdown({**report, **validate.provenance([])})
    assert "includes differences between cities" in md and "median r" in md


def test_measured_gaps_identical_or_not():
    hours = 48
    obs_a, obs_b = wave(hours), wave(hours)
    obs_a[[3, 4]] = np.nan
    obs_b[[3, 4]] = np.nan
    same = validate.measured_gaps({"a": {"obs": obs_a}, "b": {"obs": obs_b}}, START)
    assert same["identical"] and same["common"] == ["2025-11-03T03:00:00+00:00",
                                                     "2025-11-03T04:00:00+00:00"]
    obs_b[10] = np.nan
    diff = validate.measured_gaps({"a": {"obs": obs_a}, "b": {"obs": obs_b}}, START)
    assert not diff["identical"] and len(diff["common"]) == 2 and diff["extra"] == {"b": 1}


class FakeRun:
    run_id = "r1"
    start = datetime(2025, 11, 3, tzinfo=UTC)
    hours = 144

    def __init__(self, forecast_from=None, fires_assumed_from=None):
        self.forecast_from, self.fires_assumed_from = forecast_from, fires_assumed_from


def test_run_offset_checks_the_window():
    run = FakeRun()
    assert validate.run_offset(run, datetime(2025, 11, 3, tzinfo=UTC), 144) == 0
    assert validate.run_offset(run, datetime(2025, 11, 8, tzinfo=UTC), 24) == 120
    with pytest.raises(ValueError, match="outside"):
        validate.run_offset(run, datetime(2025, 11, 2, tzinfo=UTC), 24)
    with pytest.raises(ValueError, match="outside"):
        validate.run_offset(run, datetime(2025, 11, 8, tzinfo=UTC), 25)


@pytest.mark.parametrize("field", ["forecast_from", "fires_assumed_from"])
def test_run_offset_refuses_unobserved_hours(field):
    run = FakeRun(**{field: 100})
    assert validate.run_offset(run, datetime(2025, 11, 3, tzinfo=UTC), 100) == 0
    with pytest.raises(ValueError, match="observed periods only"):
        validate.run_offset(run, datetime(2025, 11, 3, tzinfo=UTC), 101)
