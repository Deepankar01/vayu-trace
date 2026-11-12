"""CPCB PM2.5-based Air Quality Index (24-hour averaging)."""
import numpy as np

# CPCB National AQI (2014) PM2.5 24-hour breakpoints, linear inside each band.
# Bands: 0-30 -> 0-50, 30-60 -> 51-100, 60-90 -> 101-200, 90-120 -> 201-300,
# 120-250 -> 301-400, 250+ -> 401-500 (formula 400 + (pm - 250) * 100 / 130, capped at 500).
_PM_NODES = np.array([0.0, 30.0, 60.0, 90.0, 120.0, 250.0, 380.0])
_AQI_NODES = np.array([0.0, 50.0, 100.0, 200.0, 300.0, 400.0, 500.0])

# CPCB National AQI (2014) PM10 24-hour breakpoints: 0-50 -> 0-50, 50-100 -> 51-100,
# 100-250 -> 101-200, 250-350 -> 201-300, 350-430 -> 301-400, 430+ -> 401-500 (formula
# 400 + (pm - 430) * 100 / 80, capped at 500).
_PM10_NODES = np.array([0.0, 50.0, 100.0, 250.0, 350.0, 430.0, 510.0])

_CATEGORIES = ((50, "Good"), (100, "Satisfactory"), (200, "Moderate"), (300, "Poor"), (400, "Very Poor"))


def pm25_to_aqi(pm25_24h: np.ndarray | float) -> np.ndarray | float:
    """PM2.5 24 h mean (ug/m3) to PM2.5-based AQI. NaN passes through; capped at 500."""
    out = np.interp(np.asarray(pm25_24h, dtype=float), _PM_NODES, _AQI_NODES)
    return float(out) if out.ndim == 0 else out


def pm10_to_aqi(pm10_24h: np.ndarray | float) -> np.ndarray | float:
    """PM10 24 h mean (ug/m3) to PM10-based AQI. NaN passes through; capped at 500."""
    out = np.interp(np.asarray(pm10_24h, dtype=float), _PM10_NODES, _AQI_NODES)
    return float(out) if out.ndim == 0 else out


def aqi_category(aqi: float) -> str:
    """CPCB category name for an AQI value."""
    if np.isnan(aqi):
        raise ValueError("AQI is missing (NaN); it has no category")
    for upper, name in _CATEGORIES:
        if aqi <= upper:
            return name
    return "Severe"
