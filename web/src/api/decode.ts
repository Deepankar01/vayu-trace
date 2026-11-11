/**
 * Decoder for the binary frame format of server/vayu/encode.py.
 *
 * Layout, little-endian: magic "VAYU", uint16 version (1), uint16 n_tags, uint16 nx, uint16 ny;
 * then per tag uint8 id_len, id bytes, float32 scale, nx*ny uint16 codes row-major from the
 * SOUTH-WEST corner (row 0 is the southern-most).
 *
 * Representation (a deliberate choice): a tag is kept as its raw `Uint16Array` plus `scale`,
 * which is 4x smaller than a Float32Array. The code 65535 is the NaN sentinel (missing data);
 * the value is `code * scale`. `composeField` handles the sentinel. All-zero tags are omitted by
 * the server, so an absent tag means zero everywhere. `__haze` is always present.
 *
 * The typed arrays assume a little-endian host (every browser platform).
 */

export const NAN_CODE = 65535;
export const HAZE = "__haze";

export interface FrameTag {
  scale: number;
  data: Uint16Array;
}

export interface Frame {
  tags: Map<string, FrameTag>;
  nx: number;
  ny: number;
}

const MAGIC = [0x56, 0x41, 0x59, 0x55]; // "VAYU"
const HEADER_BYTES = 12;
const utf8 = new TextDecoder("utf-8", { fatal: true });

export function decodeFrame(buf: ArrayBuffer): Frame {
  if (buf.byteLength < HEADER_BYTES) throw new Error("frame too short");
  const view = new DataView(buf);
  const bytes = new Uint8Array(buf);
  if (MAGIC.some((b, i) => bytes[i] !== b)) throw new Error("not a VAYU frame");
  const version = view.getUint16(4, true);
  if (version !== 1) throw new Error(`unsupported frame version ${version}`);
  const nTags = view.getUint16(6, true);
  const nx = view.getUint16(8, true);
  const ny = view.getUint16(10, true);
  const cells = nx * ny;

  const tags = new Map<string, FrameTag>();
  let pos = HEADER_BYTES;
  for (let k = 0; k < nTags; k++) {
    if (pos >= buf.byteLength) throw new Error("frame truncated");
    const idLen = view.getUint8(pos);
    const end = pos + 1 + idLen + 4 + 2 * cells;
    if (end > buf.byteLength) throw new Error("frame truncated");
    const id = utf8.decode(bytes.subarray(pos + 1, pos + 1 + idLen));
    const scale = view.getFloat32(pos + 1 + idLen, true);
    const start = pos + 1 + idLen + 4;
    // slice() copies: the code block is not 2-byte aligned in general
    tags.set(id, { scale, data: new Uint16Array(buf.slice(start, end)) });
    pos = end;
  }
  if (pos !== buf.byteLength) throw new Error("trailing bytes after the last tag");
  return { tags, nx, ny };
}
