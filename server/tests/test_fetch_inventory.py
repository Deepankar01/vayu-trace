"""scripts/fetch_inventory.py: digests, atomic writes, --if-missing (no network)."""
import hashlib
import importlib.util
import io
import re
import zipfile
from pathlib import Path

import httpx
import pytest
import respx

from vayu import config
from vayu.emissions import inventory

SERVER = Path(__file__).resolve().parents[1]
_spec = importlib.util.spec_from_file_location("fetch_inventory",
                                               SERVER / "scripts" / "fetch_inventory.py")
fi = importlib.util.module_from_spec(_spec)
_spec.loader.exec_module(fi)


def test_manifest_matches_data_notes_and_covers_every_code():
    notes = (SERVER.parent / "docs" / "data-notes.md").read_text()
    table = dict(re.findall(r"^  \| (\w+) \| `([0-9a-f]{64})` \|$", notes, re.MULTILINE))
    assert table == fi.SHA256
    assert set(fi._codes()) == set(fi.SHA256)


def _zip(name: str, data: bytes) -> bytes:
    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w") as zf:
        zf.writestr(name, data)
    return buf.getvalue()


def test_bad_digest_is_not_accepted_or_saved(monkeypatch):
    folder = config.data_dir() / "inventory"
    folder.mkdir(parents=True)
    name = inventory._file_name("TRO")
    (folder / name).write_bytes(b"corrupt")
    monkeypatch.setattr(fi, "SHA256", {**fi.SHA256, "TRO": hashlib.sha256(b"good").hexdigest()})
    assert name in fi.missing_files()  # --if-missing would not skip it
    with respx.mock:
        respx.get(inventory.zip_url("TRO")).mock(
            return_value=httpx.Response(200, content=_zip(name, b"tampered")))
        with pytest.raises(SystemExit, match="does not match"):
            fi.fetch("TRO", folder)
    assert (folder / name).read_bytes() == b"corrupt"
    assert not list(folder.glob("*.tmp"))


def test_good_download_replaces_bad_file(monkeypatch):
    folder = config.data_dir() / "inventory"
    folder.mkdir(parents=True)
    name = inventory._file_name("TRO")
    (folder / name).write_bytes(b"corrupt")
    monkeypatch.setattr(fi, "SHA256", {**fi.SHA256, "TRO": hashlib.sha256(b"good").hexdigest()})
    with respx.mock:
        respx.get(inventory.zip_url("TRO")).mock(
            return_value=httpx.Response(200, content=_zip(name, b"good")))
        fi.fetch("TRO", folder)
    assert (folder / name).read_bytes() == b"good"
    assert name not in fi.missing_files()
    assert not list(folder.glob("*.tmp"))


def test_http_error_message_has_no_url():
    folder = config.data_dir() / "inventory"
    folder.mkdir(parents=True)
    with respx.mock:
        respx.get(inventory.zip_url("TRO")).mock(return_value=httpx.Response(404))
        with pytest.raises(SystemExit) as err:
            fi.fetch("TRO", folder)
    assert str(err.value) == "TRO: download failed with HTTP 404"
