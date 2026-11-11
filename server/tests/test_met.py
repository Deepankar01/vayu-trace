import warnings
from datetime import UTC, datetime

import numpy as np
import pytest

from vayu import met
from vayu.constants import BLH_MAX_M, BLH_MIN_M

START = datetime(2023, 11, 5, tzinfo=UTC)
LON = np.arange(66.0, 98.1, 1.0)
LAT = np.arange(6.0, 38.1, 1.0)


def make_raw(hours=4, **fields):
    shape = (hours, 33, 33)
    base = {
        "wind_speed_10m": np.zeros(shape), "wind_direction_10m": np.full(shape, 270.0),
        "wind_speed_100m": np.zeros(shape), "wind_direction_100m": np.full(shape, 270.0),
        "temperature_2m": np.full(shape, 20.0), "relative_humidity_2m": np.full(shape, 50.0),
        "precipitation": np.zeros(shape), "boundary_layer_height": np.full(shape, 500.0),
    }
    base.update({k: np.asarray(v, dtype=float) for k, v in fields.items()})
    return met.MetRaw(START, hours, LON, LAT, {k: v.astype(np.float32) for k, v in base.items()})


def test_wind_components():
    u, v = met.wind_uv(met.kmh_to_ms(10.0), 270.0)  # westerly: blows toward the east
    assert u == pytest.approx(2.78, abs=0.01)
    assert v == pytest.approx(0.0, abs=1e-9)
    u, v = met.wind_uv(5.0, 180.0)  # southerly: blows toward the north
    assert (u, v) == (pytest.approx(0.0, abs=1e-9), pytest.approx(5.0))


def test_blend():
    raw = make_raw(wind_speed_100m=np.full((4, 33, 33), 10.0))
    s = met.MetField(raw).sample(77.0, 28.0, 0.0)
    assert s.u == pytest.approx(7.0)
    assert s.v == pytest.approx(0.0, abs=1e-6)


def test_bilinear_midpoint():
    temp = np.zeros((4, 33, 33))
    temp[:, 22, 11] = 0.0   # lat 28, lon 77
    temp[:, 22, 12] = 10.0  # lon 78
    temp[:, 23, 11] = 20.0  # lat 29
    temp[:, 23, 12] = 30.0
    s = met.MetField(make_raw(temperature_2m=temp)).sample(77.5, 28.5, 0.0)
    assert s.temp_c == pytest.approx(15.0)
    far = met.MetField(make_raw(temperature_2m=temp)).sample(np.array([77.0, 78.0]), np.array([28.0, 29.0]), 0.0)
    assert far.temp_c == pytest.approx([0.0, 30.0])


def test_time_interpolation_half_hour():
    temp = np.zeros((4, 33, 33))
    temp[1], temp[2] = 10.0, 20.0
    f = met.MetField(make_raw(temperature_2m=temp))
    assert f.sample(80.0, 20.0, 1.5).temp_c == pytest.approx(15.0)
    assert f.sample(np.array([80.0, 81.0]), 20.0, np.array([1.0, 2.0])).temp_c == pytest.approx([10.0, 20.0])
    assert f.sample(80.0, 20.0, 99.0).temp_c == pytest.approx(0.0)  # clamped to last hour


def test_positions_clamped_to_lattice():
    temp = np.zeros((2, 33, 33))
    temp[:, 0, 0] = 7.0
    s = met.MetField(make_raw(2, temperature_2m=temp)).sample(10.0, -5.0, 0.0)
    assert s.temp_c == pytest.approx(7.0)


def test_units_and_shapes():
    f = met.MetField(make_raw(relative_humidity_2m=np.full((4, 33, 33), 80.0),
                              precipitation=np.full((4, 33, 33), 2.5)))
    s = f.sample(np.full((2, 3), 80.0), np.full((2, 3), 20.0), 0.0)
    assert s.rh.shape == (2, 3)
    assert s.rh == pytest.approx(0.8)
    assert s.precip_mm_h == pytest.approx(2.5)
    g = f.grid(1)
    assert set(g) == {"u", "v", "blh", "rh", "temp_c", "precip_mm_h"}
    assert all(a.shape == (33, 33) for a in g.values())


def test_blh_clamped():
    assert list(met.clamp_blh(np.array([50.0, 9000.0, 800.0]))) == [BLH_MIN_M, BLH_MAX_M, 800.0]
    # raw field values outside the limits are clamped on the way into the field
    raw = make_raw(boundary_layer_height=np.where(np.arange(4)[:, None, None] == 0, 50.0, 9000.0)
                   * np.ones((4, 33, 33)))
    f = met.MetField(raw)
    assert f.sample(80.0, 20.0, 0.0).blh == BLH_MIN_M and f.sample(80.0, 20.0, 2.0).blh == BLH_MAX_M
    # the estimate itself never leaves the limits
    assert met.estimate_blh(14.5, 60.0, 500.0) == BLH_MAX_M
    assert met.estimate_blh(3.0, -40.0, 0.0) >= BLH_MIN_M
    assert met.estimate_blh(14.5, 40.0, 50.0) == BLH_MAX_M
    assert met.estimate_blh(3.0, 20.0, 0.0) == pytest.approx(150.0)


def test_blh_diurnal_shape():
    night = met.estimate_blh(2.0, 25.0, 2.0)
    afternoon = met.estimate_blh(14.5, 25.0, 2.0)
    windy_night = met.estimate_blh(2.0, 25.0, 8.0)
    hot_afternoon = met.estimate_blh(14.5, 35.0, 2.0)
    assert afternoon > night and windy_night > night and hot_afternoon > afternoon


def test_null_blh_uses_estimate_and_flags():
    clean = met.MetField(make_raw())
    assert clean.blh_estimated is False
    blh = np.full((4, 33, 33), 500.0)
    blh[:, 5, 5] = np.nan  # lat 11, lon 71
    f = met.MetField(make_raw(boundary_layer_height=blh))
    assert f.blh_estimated is True
    s = f.sample(71.0, 11.0, 0.0)  # 00 UTC at lon 71 is ~04:44 local: night, 20 C, calm
    assert s.blh == pytest.approx(150.0)
    assert f.sample(72.0, 11.0, 0.0).blh == pytest.approx(500.0)


def nan_raw(lat_i, lon_j, hour=None, var="temperature_2m"):
    arr = np.full((4, 33, 33), 5.0)
    arr[:, lat_i, lon_j] = np.nan if hour is None else 5.0
    if hour is not None:
        arr[hour, lat_i, lon_j] = np.nan
    return make_raw(**{var: arr})


def test_zero_weight_nan_neighbour_does_not_poison():
    # (a) exact grid point (lon 77, lat 28 = lon_j 11, lat_i 22): NaN in the +x, +y, diagonal cells
    for lat_i, lon_j in ((22, 12), (23, 11), (23, 12)):
        f = met.MetField(nan_raw(lat_i, lon_j))
        assert f.sample(77.0, 28.0, 0.0).temp_c == pytest.approx(5.0)
    # (b) lattice edge: position beyond the east edge clamps to lon_j 32; NaN at the unused lon_j 31
    f = met.MetField(nan_raw(10, 31))
    assert f.sample(120.0, 16.0, 0.0).temp_c == pytest.approx(5.0)
    # (c) integer hour: NaN only in hour 2 while sampling exactly hour 1 (and the last hour)
    f = met.MetField(nan_raw(10, 10, hour=2))
    assert f.sample(76.0, 16.0, 1.0).temp_c == pytest.approx(5.0)
    f = met.MetField(nan_raw(10, 10, hour=2))
    assert f.sample(76.0, 16.0, 3.0).temp_c == pytest.approx(5.0)


def test_positive_weight_nan_still_propagates():
    f = met.MetField(nan_raw(22, 12))  # NaN at lon 78, lat 28
    assert np.isnan(f.sample(77.5, 28.0, 0.0).temp_c)
    assert np.isnan(f.sample(78.0, 28.0, 0.0).temp_c)
    assert np.isfinite(f.sample(77.5, 28.0, 0.0).u)  # other variables unaffected
    f = met.MetField(nan_raw(10, 10, hour=2))
    assert np.isnan(f.sample(76.0, 16.0, 1.5).temp_c)


def test_nan_inputs_give_nan_without_warnings():
    f = met.MetField(make_raw())
    with warnings.catch_warnings():
        warnings.simplefilter("error")
        s = f.sample(np.array([np.nan, 77.0, 77.0, 77.0]), np.array([28.0, np.nan, 28.0, 28.0]),
                     np.array([0.0, 0.0, np.nan, 1.0]))
    for name in ("u", "v", "blh", "rh", "temp_c", "precip_mm_h"):
        arr = getattr(s, name)
        assert np.isnan(arr[:3]).all() and np.isfinite(arr[3]), name


@pytest.mark.parametrize("t", [0.0, 1.0, 1.25, 2.5, 3.0, 7.0, -2.0])
def test_scalar_time_fast_path_matches_general_path(t):
    rng = np.random.default_rng(3)
    shape = (4, 33, 33)
    fields = {
        "wind_speed_10m": rng.uniform(0, 10, shape), "wind_direction_10m": rng.uniform(0, 360, shape),
        "wind_speed_100m": rng.uniform(0, 15, shape),
        "wind_direction_100m": rng.uniform(0, 360, shape),
        "temperature_2m": rng.uniform(-5, 35, shape),
        "relative_humidity_2m": rng.uniform(5, 100, shape),
        "precipitation": rng.uniform(0, 3, shape),
        "boundary_layer_height": rng.uniform(50, 3000, shape),
    }
    for name in ("temperature_2m", "precipitation", "wind_speed_10m"):
        arr = fields[name]
        arr[rng.random(shape) < 0.05] = np.nan
    arr = fields["temperature_2m"]
    arr[1, 22, 11] = arr[2, 22, 12] = np.nan  # around lon 77-78, lat 28
    f = met.MetField(make_raw(**fields))
    n = 4000
    lon = rng.uniform(60, 104, n)
    lat = rng.uniform(0, 44, n)
    lon[:500] = np.round(lon[:500])  # on lattice lines
    lat[250:750] = np.round(lat[250:750])
    lon[750:800], lat[750:800] = 77.0, 28.0  # exactly on a lattice point next to NaN cells
    lon[800:820] = np.nan
    lat[820:840] = np.nan
    lon[840:860], lat[840:860] = 98.0, 38.0  # NE corner
    fast = f.sample(lon, lat, t)
    general = f.sample(lon, lat, np.full(n, t))
    for name in ("u", "v", "blh", "rh", "temp_c", "precip_mm_h"):
        a, b = getattr(fast, name), getattr(general, name)
        np.testing.assert_array_equal(np.isnan(a), np.isnan(b), err_msg=name)
        np.testing.assert_allclose(a, b, rtol=1e-6, atol=1e-9, equal_nan=True, err_msg=name)
    assert np.isnan(fast.temp_c).any() and np.isfinite(fast.temp_c).any()
    assert np.isnan(fast.u[800:840]).all()


def test_scalar_time_fast_path_scalar_inputs():
    f = met.MetField(make_raw())
    s = f.sample(77.3, 28.6, 1.5)
    assert np.ndim(s.u) == 0 and s.blh == pytest.approx(500.0)
