import io
from pathlib import Path

import httpx
import numpy as np
import pytest
import respx
from PIL import Image

from vayu import terrain
from vayu.domain import NX, NY, cell_index
from vayu.errors import UpstreamError

FIXTURES = Path(__file__).parent / "fixtures" / "terrain"


@pytest.fixture(scope="module")
def grid():
    tiles = {}
    for path in FIXTURES.glob("6_*_*.png"):
        _, x, y = path.stem.split("_")
        tiles[(int(x), int(y))] = path.read_bytes()
    return terrain.grid_from_tiles(tiles)


def value_at(grid, lon, lat):
    col, row = cell_index(lon, lat)
    return float(grid[row, col])


def test_decode_terrarium():
    rgb = np.array([[[128, 0, 0], [129, 44, 128]], [[127, 255, 0], [128, 100, 64]]], dtype=np.uint8)
    buf = io.BytesIO()
    Image.fromarray(rgb, "RGB").save(buf, format="PNG")
    out = terrain.decode_terrarium(buf.getvalue())
    assert out.dtype == np.float32
    np.testing.assert_allclose(out, [[0.0, 300.5], [-1.0, 100.25]])


def test_grid_shape_and_missing_tiles_are_nan(grid):
    assert grid.shape == (NY, NX) and grid.dtype == np.float32
    assert np.isnan(grid[0, 0])  # no tile covers the south-west corner
    assert np.isfinite(value_at(grid, 77.2, 28.6))


def test_delhi_low(grid):
    assert 150 <= value_at(grid, 77.2, 28.6) <= 300


def test_plains_south_of_himalayan_front(grid):
    assert value_at(grid, 80.0, 27.0) < 400


def test_himalaya_high(grid):
    assert value_at(grid, 79.0, 31.0) > 3000


def test_sea_is_zero_or_below(grid):
    assert value_at(grid, 68.0, 12.0) <= 0


def test_tiles_needed_cover_domain():
    tiles = terrain.tiles_needed()
    assert (45, 26) in tiles and (46, 26) in tiles and (44, 29) in tiles
    assert {x for x, _ in tiles} == set(range(43, 50))


@pytest.fixture(autouse=True)
def fresh_memo(monkeypatch):
    monkeypatch.setattr(terrain, "_memo", None)


@respx.mock
def test_failed_tile_raises_upstream_error():
    respx.get(url__regex=r".*/terrarium/6/.*").mock(return_value=httpx.Response(503))
    with pytest.raises(UpstreamError) as err:
        terrain.elevation()
    assert err.value.service == "terrain"


@respx.mock
def test_elevation_fetches_every_tile_once_then_serves_from_cache(tmp_path):
    png = (FIXTURES / "6_45_26.png").read_bytes()
    route = respx.get(url__regex=r".*/terrarium/6/.*").mock(
        return_value=httpx.Response(200, content=png))
    first = terrain.elevation()
    assert route.call_count == len(terrain.tiles_needed())
    assert (tmp_path / "cache" / "terrain.npy").is_file()
    assert (tmp_path / "cache" / "terrain.key.json").read_text() == terrain.grid_key()
    assert terrain.elevation() is first
    terrain._memo = None
    np.testing.assert_array_equal(terrain.elevation(), first)  # from the .npy
    assert route.call_count == len(terrain.tiles_needed())


def _mock_all_tiles():
    png = (FIXTURES / "6_45_26.png").read_bytes()
    return respx.get(url__regex=r".*/terrarium/6/.*").mock(
        return_value=httpx.Response(200, content=png))


def test_elevation_is_read_only():
    with respx.mock:
        _mock_all_tiles()
        grid = terrain.elevation()
    with pytest.raises(ValueError):
        grid[0, 0] = 1.0


@pytest.mark.parametrize("make_bad", [
    lambda path: path.write_bytes(b"\x93NUMPY\x01\x00truncated"),
    lambda path: np.save(path, np.zeros((5, 5), dtype=np.float32)),
    lambda path: np.save(path, np.full((terrain.NY, terrain.NX), np.nan, dtype=np.float32)),
])
def test_bad_persisted_grid_is_rebuilt(tmp_path, make_bad):
    path = tmp_path / "cache" / "terrain.npy"
    path.parent.mkdir(parents=True)
    with open(path, "wb"):
        pass
    make_bad(path)
    with respx.mock:
        route = _mock_all_tiles()
        grid = terrain.elevation()
    assert route.call_count == len(terrain.tiles_needed())
    assert grid.shape == (terrain.NY, terrain.NX) and not np.isnan(grid).any()
    assert np.load(path).shape == (terrain.NY, terrain.NX)


def test_persisted_grid_with_another_key_is_rebuilt(tmp_path):
    with respx.mock:
        _mock_all_tiles()
        terrain.elevation()
    (tmp_path / "cache" / "terrain.key.json").write_text('{"zoom": 5}')
    terrain._memo = None
    with respx.mock:
        route = _mock_all_tiles()
        terrain.elevation()
    assert route.call_count == 0  # tiles come from the tile cache, the grid is rebuilt
    assert (tmp_path / "cache" / "terrain.key.json").read_text() == terrain.grid_key()


@pytest.mark.parametrize("body", [b"<html>captive portal</html>", b"\x89PNG\r\n\x1a\ntruncated"])
def test_garbage_tile_body_raises_and_is_not_cached(body):
    with respx.mock:
        route = respx.get(url__regex=r".*/terrarium/6/.*").mock(
            return_value=httpx.Response(200, content=body))
        for attempt in (1, 2):
            with pytest.raises(UpstreamError) as err:
                terrain.elevation()
            assert err.value.service == "terrain"
            assert route.call_count == attempt  # nothing cached, so the second call refetches


def test_wrong_size_tile_rejected():
    buf = io.BytesIO()
    Image.new("RGB", (2, 2)).save(buf, format="PNG")
    with respx.mock:
        respx.get(url__regex=r".*/terrarium/6/.*").mock(
            return_value=httpx.Response(200, content=buf.getvalue()))
        with pytest.raises(UpstreamError):
            terrain.elevation()
