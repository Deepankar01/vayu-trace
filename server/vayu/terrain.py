"""Terrain elevation on the model grid, from zoom-6 Terrarium tiles (Web Mercator XYZ).

Each 0.1 degree cell is the mean of the tile pixels whose centres fall inside it. Cells with no
tile pixels are NaN. Sea cells keep Terrarium's bathymetry (negative values).
"""
import io
import math
import os

import httpx
import numpy as np
from PIL import Image

from vayu import config
from vayu.cache import cached_bytes
from vayu.domain import CELL, LAT_MAX, LAT_MIN, LON_MAX, LON_MIN, NX, NY
from vayu.errors import UpstreamError

ZOOM = 6
TILE_PX = 256
TILE_URL = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"

_memo: np.ndarray | None = None


def decode_terrarium(png: bytes) -> np.ndarray:
    """(256, 256) float32 metres from a Terrarium PNG: R*256 + G + B/256 - 32768."""
    rgb = np.asarray(Image.open(io.BytesIO(png)).convert("RGB"), dtype=np.float64)
    return (rgb[..., 0] * 256 + rgb[..., 1] + rgb[..., 2] / 256 - 32768).astype(np.float32)


def _tile_x(lon: float) -> int:
    return int((lon + 180.0) / 360.0 * 2**ZOOM)


def _tile_y(lat: float) -> int:
    n = 2**ZOOM
    return int((1 - math.asinh(math.tan(math.radians(lat))) / math.pi) / 2 * n)


def tiles_needed() -> list[tuple[int, int]]:
    """(x, y) of every zoom-6 tile touching the model domain."""
    xs = range(_tile_x(LON_MIN), _tile_x(LON_MAX) + 1)
    ys = range(_tile_y(LAT_MAX), _tile_y(LAT_MIN) + 1)
    return [(x, y) for y in ys for x in xs]


def _pixel_centres(x: int, y: int) -> tuple[np.ndarray, np.ndarray]:
    """Longitude (256,) and latitude (256,) of a tile's pixel centres."""
    size = TILE_PX * 2**ZOOM
    px = x * TILE_PX + np.arange(TILE_PX) + 0.5
    py = y * TILE_PX + np.arange(TILE_PX) + 0.5
    lon = px / size * 360.0 - 180.0
    lat = np.degrees(np.arctan(np.sinh(np.pi * (1 - 2 * py / size))))
    return lon, lat


def grid_from_tiles(tiles: dict[tuple[int, int], bytes]) -> np.ndarray:
    """(NY, NX) float32 metres, row 0 at the south edge, column 0 at the west edge."""
    total = np.zeros(NY * NX)
    count = np.zeros(NY * NX)
    for (x, y), png in tiles.items():
        lon, lat = _pixel_centres(x, y)
        col = np.floor((lon - LON_MIN) / CELL).astype(int)
        row = np.floor((lat - LAT_MIN) / CELL).astype(int)
        col_ok = (col >= 0) & (col < NX)
        row_ok = (row >= 0) & (row < NY)
        valid = row_ok[:, None] & col_ok[None, :]
        flat = (row[:, None] * NX + col[None, :])[valid]
        values = decode_terrarium(png)[valid].astype(np.float64)
        total += np.bincount(flat, weights=values, minlength=NY * NX)
        count += np.bincount(flat, minlength=NY * NX)
    out = np.full(NY * NX, np.nan)
    np.divide(total, count, out=out, where=count > 0)
    return out.reshape(NY, NX).astype(np.float32)


def _validated_tile(png: bytes, x: int, y: int) -> bytes:
    """`png` unchanged if it decodes to a 256x256 image, else UpstreamError."""
    try:
        with Image.open(io.BytesIO(png)) as img:
            img.load()
            size = img.size
            img.convert("RGB")
    except Exception as exc:
        raise UpstreamError("terrain", f"tile {ZOOM}/{x}/{y} is not a valid image: {exc}") from exc
    if size != (TILE_PX, TILE_PX):
        raise UpstreamError("terrain", f"tile {ZOOM}/{x}/{y} has size {size}, expected 256x256")
    return png


def _fetch_tile(client: httpx.Client, x: int, y: int) -> bytes:
    url = TILE_URL.format(z=ZOOM, x=x, y=y)
    try:
        resp = client.get(url)
    except httpx.HTTPError as exc:
        raise UpstreamError("terrain", f"tile {ZOOM}/{x}/{y} failed: {exc}") from exc
    if resp.status_code != 200:
        raise UpstreamError("terrain", f"tile {ZOOM}/{x}/{y} returned HTTP {resp.status_code}")
    return _validated_tile(resp.content, x, y)


def _load_grid(path) -> np.ndarray | None:
    """The persisted grid, or None if missing, unreadable or incomplete."""
    if not path.is_file():
        return None
    try:
        grid = np.load(path, allow_pickle=False)
    except Exception:  # noqa: BLE001 - any unreadable file means rebuild
        return None
    if grid.shape != (NY, NX) or grid.dtype != np.float32 or np.isnan(grid).any():
        return None
    return grid


def elevation() -> np.ndarray:
    """Terrain elevation (NY, NX) float32 metres, read-only; memoised and cached on disk."""
    global _memo
    if _memo is not None:
        return _memo
    path = config.data_dir() / "cache" / "terrain.npy"
    grid = _load_grid(path)
    if grid is None:
        with httpx.Client(timeout=60) as client:
            tiles = {
                (x, y): cached_bytes(
                    "terrain", f"terrarium/{ZOOM}/{x}/{y}",
                    lambda x=x, y=y: _fetch_tile(client, x, y),
                )
                for x, y in tiles_needed()
            }
        grid = grid_from_tiles(tiles)
        if np.isnan(grid).any():
            raise UpstreamError("terrain", "tiles do not cover the whole model domain")
        path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
        with open(tmp, "wb") as f:
            np.save(f, grid)
        os.replace(tmp, path)
    grid.setflags(write=False)
    _memo = grid
    return grid
