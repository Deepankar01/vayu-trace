"""The web's TypeScript ports replay fixtures generated from the Python reference. Regenerate
them and compare with the committed copies, so the two cannot drift apart silently."""
import json
import shutil
import subprocess
import sys
from pathlib import Path

import pytest

WEB = Path(__file__).resolve().parents[2] / "web"
SCRIPT = WEB / "scripts" / "gen_fixtures.py"
COMMITTED = WEB / "src" / "lib" / "__fixtures__"
FILES = ("breakdown-cases.json", "aqi-cases.json", "frame-case.json")


@pytest.mark.skipif(not SCRIPT.is_file(), reason="web/ is absent (server-only checkout)")
def test_committed_web_fixtures_match_the_python_reference(tmp_path):
    # the script writes beside itself (../src/lib/__fixtures__), so run a copy in a temp tree
    (tmp_path / "scripts").mkdir()
    out = tmp_path / "src" / "lib" / "__fixtures__"
    out.mkdir(parents=True)
    shutil.copy(SCRIPT, tmp_path / "scripts" / SCRIPT.name)
    subprocess.run([sys.executable, str(tmp_path / "scripts" / SCRIPT.name)], check=True,
                   cwd=Path(__file__).resolve().parents[1], capture_output=True, timeout=120)
    for name in FILES:
        fresh = json.loads((out / name).read_text())
        committed = json.loads((COMMITTED / name).read_text())
        assert fresh == committed, f"{name} differs: re-run web/scripts/gen_fixtures.py"
