import { makeFrame } from "../../test-utils/frames";
import { PLUME_ROWS } from "./plume";
import { PlumeComposer, playheadPair, sameHourKey, type HourKey } from "./plumeComposer";

const NX = 320, NY = 320;
const GRID = { lat_min: 6, cell: 0.1, nx: NX, ny: NY };

function frameWith(value: number, haze = 1.5) {
  return makeFrame(NX, NY, { a: new Float32Array(NX * NY).fill(value), b: new Float32Array(NX * NY).fill(1) },
    new Float32Array(NX * NY).fill(haze));
}

describe("sameHourKey", () => {
  const frame = frameWith(10);
  const weights = { a: 1, b: 1 };
  const base: HourKey = { hour: 3, build: "b1", frame, weights, baseline: null, mode: "pm25", stale: false };
  it("is true for identical inputs", () => {
    expect(sameHourKey(base, { ...base })).toBe(true);
  });
  it.each([
    ["hour", { hour: 4 }],
    ["build", { build: "b2" }],
    ["frame identity", { frame: frameWith(10) }],
    ["weights identity (even if equal)", { weights: { a: 1, b: 1 } }],
    ["baseline identity", { baseline: { a: 1, b: 1 } }],
    ["mode", { mode: "aqi" as const }],
    ["staleness", { stale: true }],
  ])("changes with %s", (_n, change) => {
    expect(sameHourKey(base, { ...base, ...change })).toBe(false);
  });
  it("is false against null", () => {
    expect(sameHourKey(null, base)).toBe(false);
  });
});

describe("PlumeComposer", () => {
  it("composes an hour once and reuses it while the key holds", () => {
    const c = new PlumeComposer(GRID);
    const frame = frameWith(10);
    const weights = { a: 2, b: 1 };
    const key: HourKey = { hour: 0, build: "b", frame, weights, baseline: null, mode: "pm25", stale: false };
    const first = c.get(key);
    expect(first.value.length).toBe(NX * PLUME_ROWS);
    expect(first.value[0]).toBeCloseTo(21, 2);
    expect(first.haze![0]).toBeCloseTo(1.5, 3);
    expect(c.get({ ...key })).toBe(first);
    expect(c.composeCount).toBe(1);
    const other = c.get({ ...key, weights: { a: 1, b: 1 } });
    expect(other).not.toBe(first);
    expect(other.value[0]).toBeCloseTo(11, 2);
    expect(c.composeCount).toBe(2);
  });

  it("diff mode holds composed minus baseline", () => {
    const c = new PlumeComposer(GRID);
    const frame = frameWith(10);
    const h = c.get({ hour: 0, build: "b", frame, weights: { a: 0.5, b: 1 }, baseline: { a: 1, b: 1 }, mode: "diff", stale: false });
    expect(h.value[0]).toBeCloseTo(-5, 2);
  });

  it("keeps only a few hours", () => {
    const c = new PlumeComposer(GRID);
    const frame = frameWith(10);
    const weights = { a: 1, b: 1 };
    for (let h = 0; h < 10; h++) c.get({ hour: h, build: "b", frame, weights, baseline: null, mode: "pm25", stale: false });
    expect(c.size).toBeLessThanOrEqual(4);
  });
});

describe("playheadPair", () => {
  const have = (hours: number[]) => (h: number) => hours.includes(h);
  it("blends floor and floor+1 when both are loaded", () => {
    expect(playheadPair(3.25, 10, have([3, 4]))).toEqual({ a: 3, b: 4, t: 0.25 });
  });
  it("uses the loaded one when the other is missing (no stall)", () => {
    expect(playheadPair(3.25, 10, have([3]))).toEqual({ a: 3, b: null, t: 0 });
    expect(playheadPair(3.75, 10, have([4]))).toEqual({ a: 4, b: null, t: 0 });
  });
  it("draws nothing when neither is loaded", () => {
    expect(playheadPair(3.5, 10, have([]))).toBeNull();
  });
  it("on a whole hour or the last hour uses that hour alone", () => {
    expect(playheadPair(3, 10, have([3, 4]))).toEqual({ a: 3, b: null, t: 0 });
    expect(playheadPair(9, 10, have([9]))).toEqual({ a: 9, b: null, t: 0 });
  });
});
