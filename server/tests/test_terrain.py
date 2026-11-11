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
    assert terrain.elevation() is first
    terrain._memo = None
    np.testing.assert_array_equal(terrain.elevation(), first)  # from the .npy
    assert route.call_count == len(terrain.tiles_needed())
