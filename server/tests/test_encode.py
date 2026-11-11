import struct

import numpy as np
import pytest

from vayu.encode import HAZE, MAGIC, NAN_CODE, VERSION, decode_frame, encode_frame


def fields(rng, ny=5, nx=7):
    return {
        "vehicles_delhi_ncr": (rng.random((ny, nx)) * 300).astype(np.float32),
        "fire_punjab": (rng.random((ny, nx)) ** 4 * 2.5).astype(np.float32),
        HAZE: (1 + rng.random((ny, nx))).astype(np.float32),
    }


def test_header_layout():
    b = encode_frame(fields(np.random.default_rng(0)))
    magic, version, n_tags, nx, ny = struct.unpack_from("<4sHHHH", b)
    assert (magic, version, n_tags, nx, ny) == (MAGIC, VERSION, 3, 7, 5)
    assert b[12] == len("vehicles_delhi_ncr")


def test_roundtrip_within_quantisation():
    f = fields(np.random.default_rng(1))
    out = decode_frame(encode_frame(f))
    assert list(out) == list(f)
    for tag, a in f.items():
        assert out[tag].shape == a.shape and out[tag].dtype == np.float32
        assert np.max(np.abs(out[tag] - a)) < a.max() / 65535


def test_row_major_from_south_west():
    a = np.arange(12, dtype=np.float32).reshape(3, 4)  # row 0 = southern-most
    b = encode_frame({"t": a, HAZE: np.ones((3, 4), np.float32)})
    off = 12 + 1 + 1 + 4
    codes = np.frombuffer(b, dtype="<u2", count=12, offset=off)
    scale = struct.unpack_from("<f", b, 12 + 1 + 1)[0]
    assert np.allclose(codes * scale, a.ravel(), atol=a.max() / 65534)
    assert codes[-1] == 65534  # max maps to 65534, 65535 is reserved for NaN


def test_all_zero_tag_roundtrips():
    z = np.zeros((4, 4), np.float32)
    out = decode_frame(encode_frame({"industry_bihar": z, "t": z + 1, HAZE: z}))
    assert "industry_bihar" not in out  # omitted: the browser treats absent tags as zero
    assert np.array_equal(out[HAZE], z)  # __haze is always present, even all zero
    assert np.allclose(out["t"], 1.0)


def test_haze_is_last():
    z = np.ones((2, 2), np.float32)
    assert list(decode_frame(encode_frame({HAZE: z, "b": z, "a": z}))) == ["b", "a", HAZE]


def test_nan_roundtrips_as_nan():
    a = np.array([[1.0, np.nan], [np.nan, 4.0]], np.float32)
    b = encode_frame({"t": a, HAZE: a})
    codes = np.frombuffer(b, dtype="<u2", count=4, offset=12 + 1 + 1 + 4)
    assert codes[1] == NAN_CODE and codes[2] == NAN_CODE
    out = decode_frame(b)
    for tag in ("t", HAZE):
        assert np.isnan(out[tag][0, 1]) and np.isnan(out[tag][1, 0])
        assert np.isclose(out[tag][1, 1], 4.0)


def test_zero_and_nan_tag_kept():
    a = np.array([[0.0, np.nan]], np.float32)
    out = decode_frame(encode_frame({"t": a, HAZE: a}))
    assert out["t"][0, 0] == 0 and np.isnan(out["t"][0, 1])


def test_rejects_bad_input():
    z = np.ones((2, 2), np.float32)
    with pytest.raises(ValueError):
        encode_frame({"t": -z, HAZE: z})
    with pytest.raises(ValueError):
        encode_frame({"t": z, HAZE: np.ones((3, 2), np.float32)})
    with pytest.raises(ValueError):
        encode_frame({"t": z})  # no haze
    with pytest.raises(ValueError):
        decode_frame(b"NOPE" + bytes(8))
