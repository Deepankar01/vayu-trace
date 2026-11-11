import { describe, expect, it } from "vitest";
import aqiCases from "./__fixtures__/aqi-cases.json";
import { pm25ToAqi, rolling24h } from "./aqi";

describe("pm25ToAqi", () => {
  it("matches the CPCB breakpoint table", () => {
    const table: [number, number][] = [[0, 0], [30, 50], [60, 100], [90, 200], [120, 300], [250, 400], [380, 500]];
    for (const [pm, aqi] of table) expect(pm25ToAqi(pm)).toBeCloseTo(aqi, 10);
    expect(pm25ToAqi(45)).toBeCloseTo(75, 10); // linear inside a band
  });

  it("clamps at both ends and passes NaN through", () => {
    expect(pm25ToAqi(-3)).toBe(0);
    expect(pm25ToAqi(1000)).toBe(500);
    expect(pm25ToAqi(Infinity)).toBe(500);
    expect(pm25ToAqi(NaN)).toBeNaN();
  });

  it("replays the Python reference values", () => {
    for (const c of aqiCases.cases) {
      const pm = c.pm25 === "Infinity" ? Infinity : c.pm25 === "-Infinity" ? -Infinity : (c.pm25 as number);
      const got = pm25ToAqi(pm);
      if (c.aqi === "NaN") expect(got).toBeNaN();
      else expect(Math.abs(got - (c.aqi as number))).toBeLessThanOrEqual(1e-9 * Math.max(1, Math.abs(c.aqi as number)));
    }
  });
});

describe("rolling24h", () => {
  const ramp = Array.from({ length: 48 }, (_, i) => i);

  it("averages the 24 hours ending at i, inclusive", () => {
    expect(rolling24h(ramp, 30)).toBe((7 + 30) / 2); // hours 7..30
    expect(rolling24h(ramp, 23)).toBe(11.5); // hours 0..23
  });

  it("clips at the start and needs 16 values", () => {
    expect(rolling24h(ramp, 14)).toBeNull(); // 15 values
    expect(rolling24h(ramp, 15)).toBe(7.5); // 16 values: 0..15
  });

  it("ignores nulls and returns null when too few remain", () => {
    const s: (number | null)[] = Array.from({ length: 24 }, () => 10);
    for (let i = 0; i < 8; i++) s[i] = null; // 16 left
    expect(rolling24h(s, 23)).toBe(10);
    s[8] = null; // 15 left
    expect(rolling24h(s, 23)).toBeNull();
  });
});
