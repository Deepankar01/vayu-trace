/** Test helpers: build frame bytes / Frame objects by hand (mirror of server/vayu/encode.py). */
import { decodeFrame, NAN_CODE, type Frame } from "../api/decode";

export interface RawTag {
  scale: number;
  codes: ArrayLike<number>;
}

/** Hand-built frame bytes; `codes` are uint16 values (65535 = missing). */
export function frameBytes(nx: number, ny: number, tags: Record<string, RawTag>, opts: { trailing?: number } = {}): ArrayBuffer {
  const enc = new TextEncoder();
  const entries = Object.entries(tags);
  let size = 12 + (opts.trailing ?? 0);
  for (const [id, t] of entries) size += 1 + enc.encode(id).length + 4 + 2 * t.codes.length;
  const buf = new ArrayBuffer(size);
  const view = new DataView(buf);
  [0x56, 0x41, 0x59, 0x55].forEach((b, i) => view.setUint8(i, b));
  view.setUint16(4, 1, true);
  view.setUint16(6, entries.length, true);
  view.setUint16(8, nx, true);
  view.setUint16(10, ny, true);
  let pos = 12;
  for (const [id, t] of entries) {
    const name = enc.encode(id);
    view.setUint8(pos, name.length);
    new Uint8Array(buf, pos + 1, name.length).set(name);
    view.setFloat32(pos + 1 + name.length, t.scale, true);
    pos += 1 + name.length + 4;
    for (let i = 0; i < t.codes.length; i++, pos += 2) view.setUint16(pos, t.codes[i], true);
  }
  return buf;
}

/** A Frame whose tags are given as real values (NaN = missing), quantised like the server does. */
export function makeFrame(nx: number, ny: number, fields: Record<string, ArrayLike<number>>, haze?: ArrayLike<number>): Frame {
  const raw: Record<string, RawTag> = {};
  const all = { ...fields, ...(haze ? { __haze: haze } : {}) };
  for (const [id, values] of Object.entries(all)) {
    let top = 0;
    for (let i = 0; i < values.length; i++) if (Number.isFinite(values[i])) top = Math.max(top, values[i]);
    const scale = Math.fround(top / 65534) || 1;
    raw[id] = {
      scale,
      codes: Array.from({ length: values.length }, (_, i) =>
        Number.isNaN(values[i]) ? NAN_CODE : Math.round(values[i] / scale)),
    };
  }
  return decodeFrame(frameBytes(nx, ny, raw));
}
