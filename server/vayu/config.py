"""Settings: process environment first, then the repo-root .env file."""
import os
from pathlib import Path

from vayu.errors import SetupError

_REPO_ROOT = Path(__file__).resolve().parents[2]
_SERVER_ROOT = Path(__file__).resolve().parents[1]


def _read_dotenv() -> dict[str, str]:
    path = _REPO_ROOT / ".env"
    if not path.is_file():
        return {}
    out: dict[str, str] = {}
    for line in path.read_text().splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        name, _, value = line.partition("=")
        out[name.strip().removeprefix("export ").strip()] = value.strip().strip("'\"")
    return out


def _get(name: str) -> str:
    value = os.environ.get(name) or _read_dotenv().get(name)
    if not value:
        raise SetupError(f"{name} is not set. Add it to .env at the repository root.")
    return value


def firms_map_key() -> str:
    return _get("FIRMS_MAP_KEY")


def openaq_api_key() -> str:
    return _get("OPENAQ_API_KEY")


def data_gov_in_api_key() -> str:
    return _get("DATA_GOV_IN_API_KEY")


def data_dir() -> Path:
    """`server/data`, created on demand."""
    path = _SERVER_ROOT / "data"
    path.mkdir(parents=True, exist_ok=True)
    return path
