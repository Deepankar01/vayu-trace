import pytest

from vayu import config


@pytest.fixture(autouse=True)
def isolated_env(tmp_path, monkeypatch):
    """Fake keys and a throwaway data dir so tests never touch real keys or caches."""
    monkeypatch.setenv("FIRMS_MAP_KEY", "TESTKEY")
    monkeypatch.setenv("OPENAQ_API_KEY", "TESTKEY")
    monkeypatch.setenv("DATA_GOV_IN_API_KEY", "TESTKEY")
    monkeypatch.setattr(config, "data_dir", lambda: tmp_path)
