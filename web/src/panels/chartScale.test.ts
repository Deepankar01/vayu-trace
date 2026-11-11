import { describe, expect, it } from "vitest";
import { hourFromX, istDayStarts, linear, pathD, runs, seriesMax, yTicks } from "./chartScale";

describe("linear", () => {
  it("maps domain to range", () => {
    const s = linear(0, 10, 0, 100);
    expect(s(0)).toBe(0);
    expect(s(5)).toBe(50);
    expect(s(10)).toBe(100);
  });
  it("supports an inverted range (SVG y)", () => expect(linear(0, 100, 80, 0)(25)).toBe(60));
  it("a zero-width domain maps to the range start", () => expect(linear(3, 3, 7, 9)(3)).toBe(7));
});

describe("yTicks", () => {
  it("gives 2 or 3 round ticks above zero and a domain top covering the data", () => {
    expect(yTicks(290)).toEqual({ ticks: [100, 200, 300], top: 319 });
    expect(yTicks(50).ticks).toEqual([20, 40]);
    expect(yTicks(910).ticks).toEqual([500, 1000]);
    for (const m of [3, 17, 55, 120, 260, 433, 777, 1500]) {
      const { ticks, top } = yTicks(m);
      expect(ticks.length).toBeGreaterThanOrEqual(1);
      expect(ticks.length).toBeLessThanOrEqual(3);
      expect(top).toBeGreaterThanOrEqual(m);
      expect(ticks[ticks.length - 1]).toBeLessThanOrEqual(top + 1e-9);
    }
  });
  it("has a sensible default for empty data", () => expect(yTicks(0).ticks.length).toBeGreaterThan(0));
});

describe("seriesMax", () => {
  it("ignores null and NaN", () => expect(seriesMax([[1, null, 5], null, [NaN, 3]])).toBe(5));
  it("is 0 with nothing", () => expect(seriesMax([null, [null]])).toBe(0));
});

describe("runs", () => {
  it("splits at missing values, within [from, to]", () => {
    expect(runs([1, 2, null, 4, 5, 6], 0, 5)).toEqual([[[0, 1], [1, 2]], [[3, 4], [4, 5], [5, 6]]]);
    expect(runs([1, 2, null, 4, 5, 6], 1, 4)).toEqual([[[1, 2]], [[3, 4], [4, 5]]]);
  });
  it("is empty for all-missing", () => expect(runs([null, null], 0, 1)).toEqual([]));
});

describe("pathD", () => {
  it("draws M then L in screen space", () => {
    expect(pathD([[0, 0], [1, 10]], (i) => i * 10, (v) => 100 - v)).toBe("M0,100L10,90");
  });
});

describe("hourFromX", () => {
  it("snaps to the nearest hour and clamps", () => {
    expect(hourFromX(0, 200, 101)).toBe(0);
    expect(hourFromX(101, 200, 101)).toBe(51);
    expect(hourFromX(-5, 200, 101)).toBe(0);
    expect(hourFromX(500, 200, 101)).toBe(100);
  });
});

describe("istDayStarts", () => {
  it("places IST midnights half-way between UTC hour indices", () => {
    const hours = Array.from({ length: 48 }, (_, h) => new Date(Date.UTC(2025, 10, 7, h)).toISOString());
    expect(istDayStarts(hours)).toEqual([
      { pos: 18.5, label: "08 Nov" },
      { pos: 42.5, label: "09 Nov" },
    ]);
  });
  it("is empty for no hours", () => expect(istDayStarts([])).toEqual([]));
});
