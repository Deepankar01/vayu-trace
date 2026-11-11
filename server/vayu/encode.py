"""Binary frame format for one output hour, read by the browser.

Little-endian. Header: magic `VAYU`, uint16 version (1), uint16 n_tags, uint16 nx, uint16 ny.
Then per tag: uint8 id length, id bytes (ASCII), float32 scale, nx*ny uint16 codes row-major
from the south-west corner (row 0 is the southern-most). Value = code x scale; code 65535 is
reserved for NaN (missing), and the scale maps the tag's maximum to 65534, so the quantisation
error is at most max / (2 x 65534).

A tag that is zero everywhere is omitted (the browser treats absent tags as zero), except the
pseudo-tag `__haze` (the hygroscopic growth factor), which is always present and always last.
"""
import struct

import numpy as np

MAGIC = b"VAYU"
VERSION = 1
HAZE = "__haze"
NAN_CODE = 65535
MAX_CODE = 65534
_HEADER = struct.Struct("<4sHHHH")


def _encode_tag(tag: str, a: np.ndarray) -> bytes:
    finite = np.isfinite(a)
    if not np.isnan(a[~finite]).all():
        raise ValueError(f"{tag}: infinite values")
    if (a[finite] < 0).any():
        raise ValueError(f"{tag}: negative values")
    top = float(a[finite].max()) if finite.any() else 0.0
    scale = np.float32(top / MAX_CODE)
    codes = np.full(a.shape, NAN_CODE, dtype="<u2")
    if scale > 0:
        codes[finite] = np.minimum(np.rint(a[finite] / np.float64(scale)), MAX_CODE)
    else:
        codes[finite] = 0
    name = tag.encode("ascii")
    if not 0 < len(name) < 256:
        raise ValueError(f"tag id {tag!r} must be 1..255 ASCII bytes")
    return struct.pack("<B", len(name)) + name + struct.pack("<f", scale) + codes.tobytes()


def encode_frame(fields_at_hour: dict[str, np.ndarray]) -> bytes:
    """Encode (ny, nx) fields; must include `__haze`. All-zero tags other than `__haze` are
    dropped; `__haze` is written last."""
    if HAZE not in fields_at_hour:
        raise ValueError(f"a frame must include {HAZE}")
    arrays = {t: np.asarray(a, dtype=np.float64) for t, a in fields_at_hour.items()}
    shape = arrays[HAZE].shape
    if len(shape) != 2 or any(a.shape != shape for a in arrays.values()):
        raise ValueError("all fields must share one 2-D shape")
    order = [t for t in arrays if t != HAZE and np.any(arrays[t] != 0)] + [HAZE]
    ny, nx = shape
    parts = [_HEADER.pack(MAGIC, VERSION, len(order), nx, ny)]
    parts += [_encode_tag(t, arrays[t]) for t in order]
    return b"".join(parts)


def decode_frame(b: bytes) -> dict[str, np.ndarray]:
    """Inverse of `encode_frame`: float32 (ny, nx) per tag present, NaN for code 65535."""
    if len(b) < _HEADER.size:
        raise ValueError("frame too short")
    magic, version, n_tags, nx, ny = _HEADER.unpack_from(b)
    if magic != MAGIC or version != VERSION:
        raise ValueError("not a version-1 VAYU frame")
    pos, out = _HEADER.size, {}
    for _ in range(n_tags):
        n = b[pos]
        tag = b[pos + 1:pos + 1 + n].decode("ascii")
        (scale,) = struct.unpack_from("<f", b, pos + 1 + n)
        pos += 1 + n + 4
        codes = np.frombuffer(b, dtype="<u2", count=nx * ny, offset=pos).reshape(ny, nx)
        pos += 2 * nx * ny
        values = (codes * np.float32(scale)).astype(np.float32)
        values[codes == NAN_CODE] = np.nan
        out[tag] = values
    if pos != len(b):
        raise ValueError("trailing bytes after the last tag")
    return out
