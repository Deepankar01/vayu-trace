"""Record upstream responses as test fixtures. Usage: record_fixtures.py firms

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


if __name__ == "__main__":
    if sys.argv[1:] == ["firms"]:
        record_firms()
    else:
        raise SystemExit("usage: record_fixtures.py firms")
