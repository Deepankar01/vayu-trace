from datetime import UTC, datetime

import numpy as np
import pytest

from vayu import receptors
from vayu.cities import BY_ID, CITIES, City
from vayu.constants import FIRE_ARRIVAL_UGM3
from vayu.domain import NX, NY, TAGS, cell_index
from vayu.met import MetField, MetRaw
from vayu.receptors import arrival, back_trajectory, breakdown, city_region, city_series

START = datetime(2023, 11, 5, tzinfo=UTC)
LON = np.arange(66.0, 98.1, 1.0)
LAT = np.arange(6.0, 38.1, 1.0)


def make_met(hours=100, speed=0.0, direction=270.0, blh=500.0):
    shape = (hours, 33, 33)
    f = lambda x: np.full(shape, x, dtype=np.float32)  # noqa: E731
    return MetField(MetRaw(START, hours, LON, LAT, {
        "wind_speed_10m": f(speed), "wind_direction_10m": f(direction),
        "wind_speed_100m": f(speed), "wind_direction_100m": f(direction),
        "temperature_2m": f(20.0), "relative_humidity_2m": f(50.0),
        "precipitation": f(0.0), "boundary_layer_height": f(blh),
    }))


def make_met_series(speeds, direction=270.0, blh=500.0):
    """Met whose wind speed at hour index i is speeds[i] everywhere."""
    hours = len(speeds)
    shape = (hours, 33, 33)
    f = lambda x: np.full(shape, x, dtype=np.float32)  # noqa: E731
    sp = np.broadcast_to(np.asarray(speeds, dtype=np.float32)[:, None, None], shape).copy()
    return MetField(MetRaw(START, hours, LON, LAT, {
        "wind_speed_10m": sp, "wind_direction_10m": f(direction),
        "wind_speed_100m": sp, "wind_direction_100m": f(direction),
        "temperature_2m": f(20.0), "relative_humidity_2m": f(50.0),
        "precipitation": f(0.0), "boundary_layer_height": f(blh),
    }))


def rows_by_key(rows):
    return {r.key: r for r in rows}


# --- breakdown ---

def test_local_vs_transported_grouping():
    rows = rows_by_key(breakdown({"vehicles_delhi_ncr": 30.0, "vehicles_punjab": 20.0}, {},
                                 "delhi_ncr", None))
    assert rows["local:vehicles"].kind == "local"
    assert rows["local:vehicles"].label == "Local vehicles"
    t = rows["transported:vehicles:punjab"]
    assert (t.kind, t.label) == ("transported", "Transported vehicles — Punjab")
    assert t.sector == "vehicles"


def test_labels():
    rows = rows_by_key(breakdown(
        {"industry_delhi_ncr": 1.0, "dust_delhi_ncr": 1.0, "residential_delhi_ncr": 1.0,
         "dust_rest_of_india": 1.0, "fire_madhya_pradesh": 1.0, "fire_other": 1.0,
         "user_1": 1.0}, {}, "delhi_ncr", None, labels={"user_1": "My plant"}))
    assert rows["local:industry"].label == "Local industry and power"
    assert rows["local:dust"].label == "Local road and construction dust"
    assert rows["local:residential"].label == "Local residential"
    assert rows["transported:dust:rest_of_india"].label.endswith("— Rest of India")
    assert rows["fire:madhya_pradesh"].label == "Fires (satellite) — Madhya Pradesh"
    assert rows["fire:other"].label == "Fires (satellite) — other states and neighbouring countries"
    assert (rows["user:user_1"].label, rows["user:user_1"].kind) == ("My plant", "user")
    assert breakdown({"user_2": 1.0}, {}, "delhi_ncr", None)[0].label == "Added source"


def test_fire_rows_combine_observed_and_persistence():
    rows = breakdown({"fire_punjab": 10.0, "firefc_punjab": 5.0}, {}, "delhi_ncr", None)
    assert len(rows) == 1
    assert rows[0].key == "fire:punjab" and rows[0].value == 15.0
    assert rows[0].label == "Fires (satellite) — Punjab"


def test_weights_applied():
    rows = rows_by_key(breakdown({"vehicles_delhi_ncr": 10.0, "fire_punjab": 10.0},
                                 {"vehicles_delhi_ncr": 0.5, "fire_punjab": 0.0}, "delhi_ncr", None))
    assert rows["local:vehicles"].value == 5.0
    assert "fire:punjab" not in rows  # exactly 0 omitted
    assert rows["local:vehicles"].share == 1.0


def test_nan_tag_skipped_and_all_nan_empty():
    rows = breakdown({"vehicles_delhi_ncr": 10.0, "dust_delhi_ncr": float("nan")}, {},
                     "delhi_ncr", None)
    assert [r.key for r in rows] == ["local:vehicles"]
    assert breakdown({"vehicles_delhi_ncr": float("nan")}, {}, "delhi_ncr", 50.0) == []


def test_unexplained_row_when_measured_higher():
    rows = breakdown({"vehicles_delhi_ncr": 100.0}, {}, "delhi_ncr", 160.0)
    u = rows[-1]
    assert u.key == "unexplained" and u.label == "Not explained by model"
    assert u.value == 60.0 and u.share == pytest.approx(0.375) and not u.minor
    assert u.color == "#5b6475" and u.kind == "unexplained" and u.sector is None
    assert rows[0].share == pytest.approx(0.625)


def test_unexplained_never_minor():
    rows = breakdown({"vehicles_delhi_ncr": 100.0}, {}, "delhi_ncr", 101.0)
    assert rows[-1].share < 0.05 and rows[-1].minor is False
    assert rows[0].minor is False


def test_no_unexplained_row_when_measured_missing():
    for m in (None, float("nan")):
        rows = breakdown({"vehicles_delhi_ncr": 100.0}, {}, "delhi_ncr", m)
        assert [r.kind for r in rows] == ["local"] and rows[0].share == 1.0


def test_no_unexplained_row_when_sim_exceeds_measured():
    rows = breakdown({"vehicles_delhi_ncr": 100.0, "dust_delhi_ncr": 100.0}, {}, "delhi_ncr", 80.0)
    assert all(r.kind != "unexplained" for r in rows)
    assert sum(r.share for r in rows) == pytest.approx(1.0)  # denominator is the simulation


def test_all_zero_has_no_nan():
    rows = breakdown({"vehicles_delhi_ncr": 0.0, "dust_punjab": 0.0}, {}, "delhi_ncr", None)
    assert rows == []
    rows = breakdown({"vehicles_delhi_ncr": 0.0}, {}, "delhi_ncr", 0.0)
    assert rows == []
    rows = breakdown({"vehicles_delhi_ncr": 0.0}, {}, "delhi_ncr", 10.0)  # only unexplained
    assert [(r.key, r.share) for r in rows] == [("unexplained", 1.0)]
    # a nonzero value with a zero denominator cannot occur; zero-valued rows are omitted, so
    # shares are never NaN
    for r in breakdown({"vehicles_delhi_ncr": 3.0}, {"vehicles_delhi_ncr": 0.0}, "delhi_ncr", None):
        assert r.share is None or not np.isnan(r.share)


def test_minor_flag_at_threshold():
    rows = rows_by_key(breakdown({"vehicles_delhi_ncr": 95.1, "dust_delhi_ncr": 4.9,
                                  "residential_delhi_ncr": 0.0}, {}, "delhi_ncr", None))
    assert rows["local:dust"].share == pytest.approx(0.049) and rows["local:dust"].minor
    rows = rows_by_key(breakdown({"vehicles_delhi_ncr": 95.0, "dust_delhi_ncr": 5.0}, {},
                                 "delhi_ncr", None))
    assert rows["local:dust"].share == 0.05 and not rows["local:dust"].minor


def test_denominator_measured_below_simulated_uses_simulated():
    rows = breakdown({"vehicles_delhi_ncr": 50.0, "dust_delhi_ncr": 50.0}, {}, "delhi_ncr", 10.0)
    assert [r.share for r in rows] == [0.5, 0.5]


def test_ordering():
    rows = breakdown({
        "user_1": 99.0, "vehicles_punjab": 7.0, "dust_punjab": 9.0, "vehicles_delhi_ncr": 1.0,
        "dust_delhi_ncr": 2.0, "fire_punjab": 3.0, "fire_haryana": 4.0,
    }, {}, "delhi_ncr", 500.0)
    assert [r.key for r in rows] == [
        "fire:haryana", "fire:punjab", "local:dust", "local:vehicles",
        "transported:dust:punjab", "transported:vehicles:punjab", "user:user_1", "unexplained",
    ]


def test_colors_are_tag_colors():
    tag = next(t for t in TAGS if t.id == "dust_punjab")
    rows = breakdown({"dust_punjab": 1.0, "fire_punjab": 1.0}, {}, "delhi_ncr", None)
    assert {r.key: r.color for r in rows}["transported:dust:punjab"] == tag.color


def test_city_region():
    assert city_region(BY_ID["delhi"]) == "delhi_ncr"
    assert city_region(BY_ID["ludhiana"]) == "punjab"
    assert city_region(BY_ID["patna"]) == "bihar"
    assert city_region(BY_ID["mumbai"]) == "rest_of_india"


# --- arrival ---

def test_arrival_present():
    s = np.zeros(24)
    s[5] = FIRE_ARRIVAL_UGM3
    assert arrival(s, 5, 7.5) == {"kind": "present", "age_h": 7.5}
    assert arrival(s, 5, None) == {"kind": "present", "age_h": None}


def test_arrival_future():
    s = np.zeros(24)
    s[14:] = 40.0
    assert arrival(s, 5, None) == {"kind": "arrives", "in_h": 9}


def test_arrival_none_and_nan_below_threshold():
    s = np.full(24, 1.0)
    s[3] = np.nan
    assert arrival(s, 3, None) == {"kind": "none"}
    s[8] = np.nan
    s[9] = 20.0
    assert arrival(s, 3, None) == {"kind": "arrives", "in_h": 6}
    assert arrival(np.full(5, 100.0), 4, 3.0)["kind"] == "present"
    assert arrival(np.full(5, 100.0), 3, 3.0)["kind"] == "present"


# --- city_series ---

class FakeRun:
    def __init__(self, hours=3, tags=("vehicles_delhi_ncr", "fire_punjab", "firefc_punjab")):
        self.hours, self.tags, self.start = hours, list(tags), START
        self.reads = []
        self.grids = {}
        self.age = np.full((NY, NX), np.nan, dtype=np.float32)

    def frame(self, h):
        self.reads.append(h)
        return {t: self.grids.get(t, np.zeros((NY, NX), np.float32)).copy() + h for t in self.tags}

    def fire_age_h(self, h):
        return self.age.copy()


def test_3x3_mean_ignores_nan_cells():
    c = BY_ID["delhi"]
    ix, iy = (int(a) for a in cell_index(c.lon, c.lat))
    run = FakeRun(hours=1)
    g = np.full((NY, NX), 10.0, np.float32)
    g[iy, ix] = np.nan
    g[iy + 1, ix + 1] = 100.0
    g[iy + 5, ix] = 1e6  # outside the block
    run.grids["vehicles_delhi_ncr"] = g
    out = city_series(run, make_met(), 0.0)
    assert out["delhi"].by_tag["vehicles_delhi_ncr"][0] == pytest.approx((7 * 10 + 100) / 8)
    g[:] = np.nan
    assert np.isnan(city_series(run, make_met(), 0.0)["delhi"].by_tag["vehicles_delhi_ncr"][0])


def test_fire_age_weighted_by_fire_and_reads_once():
    c = BY_ID["delhi"]
    ix, iy = (int(a) for a in cell_index(c.lon, c.lat))
    run = FakeRun(hours=2)
    f = np.zeros((NY, NX), np.float32)
    f[iy, ix], f[iy, ix + 1] = 3.0, 1.0
    run.grids["fire_punjab"] = f
    run.age[iy, ix], run.age[iy, ix + 1] = 10.0, 30.0
    out = city_series(run, make_met(), 0.0)
    # frame adds h to every cell of every tag, so weights at hour 1 are (3+2*... ) -- check hour 0
    assert out["delhi"].fire_age_h[0] == pytest.approx((3 * 10 + 1 * 30) / 4)
    assert run.reads == [0, 1]
    assert np.isnan(out["mumbai"].fire_age_h[0])  # no fire age in the block


def test_fire_age_nan_when_no_fire():
    run = FakeRun(hours=1)
    run.age[:] = 12.0
    assert np.isnan(city_series(run, make_met(), 0.0)["delhi"].fire_age_h[0])


def test_met_series_and_offset():
    run = FakeRun(hours=2)
    out = city_series(run, make_met(speed=5.0, direction=270.0, blh=700.0), 48.0)
    m = out["delhi"].met
    assert m["wind_ms"] == pytest.approx([5.0, 5.0])
    assert m["wind_dir_deg"] == pytest.approx([270.0, 270.0])
    assert m["rh"] == pytest.approx([0.5, 0.5]) and m["blh_m"] == pytest.approx([700.0, 700.0])
    assert set(m) == {"wind_ms", "wind_dir_deg", "rh", "temp_c", "blh_m"}


@pytest.mark.parametrize("u,v,expected", [(1, 0, 270), (-1, 0, 90), (0, 1, 180), (0, -1, 0)])
def test_wind_dir_cardinal(u, v, expected):
    assert receptors.wind_dir_from_deg(u, v) == pytest.approx(expected)


def test_wind_dir_in_range():
    d = receptors.wind_dir_from_deg(np.array([1.0, -1.0]), np.array([-1e-12, 1e-12]))
    assert ((d >= 0) & (d < 360)).all()


def test_series_covers_all_cities():
    out = city_series(FakeRun(hours=1), make_met(), 0.0)
    assert set(out) == {c.id for c in CITIES}


# --- back-trajectory ---

def test_back_trajectory_uniform_wind():
    pts = back_trajectory(make_met(speed=5.0, direction=270.0), np.zeros((NY, NX)), 80.0, 25.0,
                          hour=20, hours_back=10, met_offset_h=0.0)
    assert len(pts) == 11 and pts[0] == (80.0, 25.0)
    lon, lat = pts[-1]
    km = np.radians(80.0 - lon) * 6371.0 * np.cos(np.radians(25.0))
    assert km == pytest.approx(180.0, rel=0.01)
    assert lat == pytest.approx(25.0)


def test_back_trajectory_stops_at_domain_edge():
    pts = back_trajectory(make_met(speed=10.0, direction=270.0), np.zeros((NY, NX)), 66.5, 25.0,
                          hour=20, hours_back=10)
    assert 1 < len(pts) < 11 and pts[-1][0] >= 66.0


def test_back_trajectory_stops_when_met_exhausted():
    pts = back_trajectory(make_met(hours=100, speed=1.0), np.zeros((NY, NX)), 80.0, 25.0,
                          hour=2, hours_back=10, met_offset_h=0.0)
    assert len(pts) == 3  # t = 2.5 h back to 0.5 h; the next step would pass time 0


def test_back_trajectory_stops_at_nan_met():
    met = make_met(speed=2.0)
    met._data[:, :10] = np.nan
    pts = back_trajectory(met, np.zeros((NY, NX)), 80.0, 25.0, hour=20, hours_back=30)
    assert len(pts) == 11


def test_back_trajectory_stops_at_terrain_wall():
    elev = np.zeros((NY, NX))
    wx = int(cell_index(79.0, 25.0)[0][()])
    elev[:, wx - 2: wx + 3] = 3000.0  # a wide wall west of 79 E; blh 500 cannot clear it
    pts = back_trajectory(make_met(speed=5.0, direction=270.0), elev, 80.0, 25.0, hour=20,
                          hours_back=20)
    assert len(pts) == 21 and min(p[0] for p in pts) > 79.0
    assert pts[-1][1] == pytest.approx(25.0)


def test_back_trajectory_slides_along_wall():
    elev = np.zeros((NY, NX))
    wx = int(cell_index(79.0, 25.0)[0][()])
    elev[:, wx - 2: wx + 3] = 3000.0
    pts = back_trajectory(make_met(speed=5.0, direction=225.0), elev, 80.0, 25.0, hour=20,
                          hours_back=6)
    assert pts[-1][0] > 79.0 and pts[-1][1] < 25.0  # blocked in x, free to move south


# --- review fixes ---

def test_breakdown_sum_is_sorted_left_to_right_and_order_independent():
    vals = {"vehicles_punjab": 0.1, "dust_delhi_ncr": 0.2, "vehicles_delhi_ncr": 0.3,
            "fire_punjab": 0.7, "firefc_punjab": 0.1, "user_1": 0.6}
    expected = 0.0
    for t in sorted(vals):
        expected += vals[t]
    rows = breakdown(vals, {}, "delhi_ncr", 10.0)
    assert rows[-1].key == "unexplained" and rows[-1].value == 10.0 - expected
    shuffled = dict(reversed(list(vals.items())))
    assert breakdown(shuffled, {}, "delhi_ncr", 10.0) == rows
    assert breakdown(shuffled, {}, "delhi_ncr", None) == breakdown(vals, {}, "delhi_ncr", None)


def test_breakdown_unknown_tag_and_extra_weights():
    with pytest.raises(ValueError, match="unknown source tag 'bogus_tag'.*predates"):
        breakdown({"bogus_tag": 1.0}, {}, "delhi_ncr", None)
    rows = breakdown({"vehicles_delhi_ncr": 2.0}, {"dust_punjab": 9.0}, "delhi_ncr", None)
    assert [r.value for r in rows] == [2.0]


def test_city_series_user_tag_ok_and_unknown_tag_raises():
    run = FakeRun(hours=1, tags=("vehicles_delhi_ncr", "user_1"))
    assert "user_1" in city_series(run, make_met(), 0.0)["delhi"].by_tag
    run = FakeRun(hours=1, tags=("vehicles_delhi_ncr", "old_tag"))
    with pytest.raises(ValueError, match="unknown source tag 'old_tag'"):
        city_series(run, make_met(), 0.0)


def test_calm_wind_has_nan_direction():
    out = city_series(FakeRun(hours=2), make_met(speed=0.0), 0.0)["delhi"].met
    assert np.isnan(out["wind_dir_deg"]).all() and (out["wind_ms"] == 0).all()
    assert np.isnan(receptors.wind_dir_from_deg(0.05, 0.0))
    assert receptors.wind_dir_from_deg(0.2, 0.0) == pytest.approx(270.0)


def test_arrival_nan_age_none_and_hour_range_and_earlier_crossing():
    s = np.zeros(10)
    s[5] = 30.0
    assert arrival(s, 5, float("nan")) == {"kind": "present", "age_h": None}
    for bad in (-1, 10, 11):
        with pytest.raises(IndexError, match="outside 0..9"):
            arrival(s, bad, None)
    s = np.zeros(10)
    s[2] = 40.0
    assert arrival(s, 5, None) == {"kind": "none"}


def test_city_series_met_samples_ramping_wind_with_offset():
    speeds = np.arange(100) * 0.5  # linear in time: wind(t) = 0.5 * t
    out = city_series(FakeRun(hours=3), make_met_series(speeds), 3.0)["delhi"].met
    assert out["wind_ms"] == pytest.approx([0.5 * 3.5, 0.5 * 4.5, 0.5 * 5.5])
    assert out["wind_dir_deg"] == pytest.approx([270.0] * 3)


@pytest.mark.parametrize("corner", [(0, 0), (NX - 1, NY - 1)])
def test_block_edge_has_four_cells(corner):
    ix, iy = corner
    city = City("edge", "Edge", 6.0 + 0.1 * (iy + 0.5), 66.0 + 0.1 * (ix + 0.5))
    flat, ok = receptors._blocks([city])
    assert ok.sum() == 4
    cells = {(int(f) % NX, int(f) // NX) for f in flat[0][ok[0]]}
    sx = (0, 1) if ix == 0 else (NX - 2, NX - 1)
    sy = (0, 1) if iy == 0 else (NY - 2, NY - 1)
    assert cells == {(x, y) for x in sx for y in sy}


def test_back_trajectory_time_varying_wind_and_offset():
    # wind 5 m/s up to met hour 55, falling linearly to 0 at hour 56 and 0 after
    speeds = np.where(np.arange(100) <= 55, 5.0, 0.0)
    met = make_met_series(speeds)
    # city time = 48.5 + 7 + 0.5 = 56.0 in met hours; going backward the wind rises
    pts = back_trajectory(met, np.zeros((NY, NX)), 80.0, 25.0, hour=7, hours_back=10,
                          met_offset_h=48.5)
    steps = np.arange(60)  # 6 steps/hour * 10 h
    t = 56.0 - steps / 6.0
    metres = (5.0 * np.clip(56.0 - t, 0, 1) * 600.0).sum()
    expected_lon = 80.0 - np.degrees(metres / (6371008.8 * np.cos(np.radians(25.0))))
    assert pts[-1][0] == pytest.approx(expected_lon, abs=1e-6) and pts[-1][1] == pytest.approx(25.0)
    # dropping the offset would sample constant 5 m/s: a clearly different end point
    assert abs(pts[-1][0] - (80.0 - np.degrees(5.0 * 36000 / (6371008.8 * np.cos(np.radians(25.0)))))) > 0.1
    # hour outside the met range: just the city
    assert back_trajectory(met, np.zeros((NY, NX)), 80.0, 25.0, hour=60, hours_back=5,
                           met_offset_h=48.5) == [(80.0, 25.0)]
