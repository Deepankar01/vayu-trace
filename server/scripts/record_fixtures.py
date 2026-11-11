"""Record upstream responses as test fixtures. Usage: record_fixtures.py firms|openmeteo

The API key is read from the environment/.env and never written to disk.
"""
import sys
from pathlib import Path

import httpx

from vayu import config

FIXTURES = Path(__file__).resolve().parents[1] / "tests" / "fixtures"


def record_firms() -> None:
    key = config.firms_map_key()
    out = FIXTURES / "firms"
    out.mkdir(parents=True, exist_ok=True)
    base = "https://firms.modaps.eosdis.nasa.gov/api"
    targets = {
        "availability.csv": f"{base}/data_availability/csv/{key}/all",
        "punjab_snpp_sp_2023-11-05.csv": f"{base}/area/csv/{key}/VIIRS_SNPP_SP/73,28,78,33/1/2023-11-05",
    }
    for name, url in targets.items():
        resp = httpx.get(url, timeout=120)
        resp.raise_for_status()
        body = resp.text
        if key in body or body.startswith("Invalid"):
            raise SystemExit(f"{name}: unusable response, not saved")
        (out / name).write_text(body)
        print(f"saved {name} ({len(body)} bytes)")


def record_openmeteo() -> None:
    """Three lattice points (Delhi, Ludhiana, Patna): one archive day, one forecast span, CAMS."""
    out = FIXTURES / "openmeteo"
    out.mkdir(parents=True, exist_ok=True)
    hourly = ("wind_speed_10m,wind_direction_10m,wind_speed_100m,wind_direction_100m,"
              "temperature_2m,relative_humidity_2m,precipitation,boundary_layer_height")
    common = {"wind_speed_unit": "ms", "timezone": "GMT"}
    points = {"latitude": "28,31,25", "longitude": "77,76,85"}
    targets = {
        "archive_2023-11-05.json": (
            "https://archive-api.open-meteo.com/v1/archive",
            {**points, **common, "hourly": hourly,
             "start_date": "2023-11-05", "end_date": "2023-11-05"}),
        "forecast.json": (
            "https://api.open-meteo.com/v1/forecast",
            {**points, **common, "hourly": hourly, "past_days": 1, "forecast_days": 2}),
        "cams_2023-11-05.json": (
            "https://air-quality-api.open-meteo.com/v1/air-quality",
            {"latitude": 28, "longitude": 77, "timezone": "GMT", "hourly": "pm2_5",
             "start_date": "2023-11-05", "end_date": "2023-11-05"}),
    }
    for name, (url, params) in targets.items():
        resp = httpx.get(url, params=params, timeout=120)
        resp.raise_for_status()
        (out / name).write_bytes(resp.content)
        print(f"saved {name} ({len(resp.content)} bytes)")


if __name__ == "__main__":
    if sys.argv[1:] == ["firms"]:
        record_firms()
    elif sys.argv[1:] == ["openmeteo"]:
        record_openmeteo()
    else:
        raise SystemExit("usage: record_fixtures.py firms|openmeteo")
