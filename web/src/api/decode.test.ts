import { describe, expect, it } from "vitest";
import { frameBytes } from "../test-utils/frames";
import { decodeFrame, NAN_CODE } from "./decode";
import frameCase from "../lib/__fixtures__/frame-case.json";

describe("decodeFrame", () => {
  it("round-trips a hand-built buffer", () => {
    const buf = frameBytes(3, 2, {
      vehicles_delhi_ncr: { scale: 0.5, codes: [0, 2, 4, 6, 8, 65534] },
      user_1: { scale: 0.25, codes: [1, 1, 1, NAN_CODE, 1, 1] },
      __haze: { scale: 0.01, codes: [100, 100, 100, 100, 150, 100] },
    });
    const f = decodeFrame(buf);
    expect([f.nx, f.ny]).toEqual([3, 2]);
    expect([...f.tags.keys()]).toEqual(["vehicles_delhi_ncr", "user_1", "__haze"]);
    const v = f.tags.get("vehicles_delhi_ncr")!;
    expect(v.scale).toBe(0.5);
    expect([...v.data]).toEqual([0, 2, 4, 6, 8, 65534]);
    expect(f.tags.get("user_1")!.data[3]).toBe(NAN_CODE);
    expect(f.tags.get("__haze")!.data).toBeInstanceOf(Uint16Array);
  });

  it("decodes a frame encoded by the Python server (odd byte offsets, NaN cells)", () => {
    const bytes = Uint8Array.from(atob(frameCase.base64), (c) => c.charCodeAt(0));
    const f = decodeFrame(bytes.buffer);
    expect([f.nx, f.ny]).toEqual([frameCase.nx, frameCase.ny]);
    expect([...f.tags.keys()].sort()).toEqual(Object.keys(frameCase.tags).sort());
    for (const [id, expected] of Object.entries(frameCase.tags)) {
      const { data, scale } = f.tags.get(id)!;
      (expected as (number | string)[]).forEach((e, i) => {
        if (e === "NaN") expect(data[i]).toBe(NAN_CODE);
        else expect(data[i] * scale).toBeCloseTo(e as number, 4);
      });
    }
    expect(f.tags.has("dust_punjab")).toBe(false); // all-zero tags are omitted by the server
  });

  it("reads tags whose scale and codes sit at even and odd byte offsets", () => {
    // id lengths 2 and 3 and 4: the code blocks start at alternating parities
    const buf = frameBytes(2, 1, {
      ab: { scale: 2, codes: [1, 65534] },
      abc: { scale: 0.5, codes: [300, 7] },
      abcd: { scale: 0.25, codes: [1000, 65535] },
    });
    const f = decodeFrame(buf);
    expect([...f.tags.get("ab")!.data]).toEqual([1, 65534]);
    expect([...f.tags.get("abc")!.data]).toEqual([300, 7]);
    expect(f.tags.get("abc")!.scale).toBe(0.5);
    expect([...f.tags.get("abcd")!.data]).toEqual([1000, 65535]);
    expect(f.tags.get("abcd")!.scale).toBe(0.25);
  });

  it("rejects bad input", () => {
    const ok = frameBytes(1, 1, { a: { scale: 1, codes: [1] } });
    expect(() => decodeFrame(new ArrayBuffer(4))).toThrow(/too short/);
    const badMagic = ok.slice(0);
    new Uint8Array(badMagic)[0] = 0x58;
    expect(() => decodeFrame(badMagic)).toThrow(/not a VAYU frame/);
    const badVersion = ok.slice(0);
    new DataView(badVersion).setUint16(4, 2, true);
    expect(() => decodeFrame(badVersion)).toThrow(/version 2/);
    expect(() => decodeFrame(ok.slice(0, ok.byteLength - 1))).toThrow(/truncated/);
    expect(() => decodeFrame(frameBytes(1, 1, { a: { scale: 1, codes: [1] } }, { trailing: 2 }))).toThrow(/trailing/);
  });
});
