import numpy as np
import pytest

from vayu.aqi import aqi_category, pm25_to_aqi


@pytest.mark.parametrize(
    "pm,aqi",
    [(0, 0), (30, 50), (60, 100), (90, 200), (120, 300), (250, 400), (380, 500), (1000, 500), (45, 75)],
)
def test_breakpoints(pm, aqi):
    assert round(pm25_to_aqi(pm)) == aqi


def test_nan_passes_through():
    assert np.isnan(pm25_to_aqi(float("nan")))


def test_array_in_array_out():
    out = pm25_to_aqi(np.array([0.0, 45.0, np.nan, 1000.0]))
    assert isinstance(out, np.ndarray)
    assert out[:2].tolist() == [0.0, 75.0] and np.isnan(out[2]) and out[3] == 500.0


def test_scalar_in_float_out():
    assert isinstance(pm25_to_aqi(45.0), float)


def test_above_250_formula():
    assert pm25_to_aqi(315.0) == pytest.approx(400 + 65 * 100 / 130)


@pytest.mark.parametrize(
    "aqi,cat",
    [(0, "Good"), (50, "Good"), (51, "Satisfactory"), (100, "Satisfactory"), (150, "Moderate"),
     (250, "Poor"), (350, "Very Poor"), (401, "Severe"), (500, "Severe")],
)
def test_category(aqi, cat):
    assert aqi_category(aqi) == cat


@pytest.mark.parametrize(
    "pm,aqi",
    [(0, 0), (50, 50), (100, 100), (250, 200), (350, 300), (430, 400), (510, 500), (2000, 500),
     (175, 150)],
)
def test_pm10_breakpoints(pm, aqi):
    from vayu.aqi import pm10_to_aqi
    assert round(pm10_to_aqi(pm)) == aqi


def test_pm10_nan_and_array():
    from vayu.aqi import pm10_to_aqi
    out = pm10_to_aqi(np.array([75.0, np.nan]))
    assert out[0] == 75.0 and np.isnan(out[1])
