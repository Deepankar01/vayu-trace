import pytest

from vayu import config


def test_missing_key_raises_clear_error(monkeypatch):
    monkeypatch.delenv("OPENAQ_API_KEY")
    monkeypatch.setattr(config, "_read_dotenv", dict)
    with pytest.raises(RuntimeError, match="OPENAQ_API_KEY is not set"):
        config.openaq_api_key()


def test_env_wins_then_dotenv(monkeypatch):
    monkeypatch.setattr(config, "_read_dotenv", lambda: {"FIRMS_MAP_KEY": "file", "DATA_GOV_IN_API_KEY": "file"})
    assert config.firms_map_key() == "TESTKEY"
    monkeypatch.delenv("DATA_GOV_IN_API_KEY")
    assert config.data_gov_in_api_key() == "file"
