import { describe, expect, it } from "vitest";
import aqiCases from "./__fixtures__/aqi-cases.json";
import { pm10ToAqi, pm25ToAqi, rolling24h } from "./aqi";

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
      else expect(got).toBe(c.aqi as number); // same double operations as numpy.interp: identical
    }
  });
});

describe("pm10ToAqi", () => {
  it("matches the CPCB PM10 breakpoint table, linear inside a band", () => {
    const table: [number, number][] = [[0, 0], [50, 50], [100, 100], [250, 200], [350, 300], [430, 400], [510, 500]];
    for (const [pm, aqi] of table) expect(pm10ToAqi(pm)).toBeCloseTo(aqi, 10);
    expect(pm10ToAqi(175)).toBeCloseTo(150, 10);
  });

  it("clamps at both ends and passes NaN through", () => {
    expect(pm10ToAqi(-3)).toBe(0);
    expect(pm10ToAqi(2000)).toBe(500);
    expect(pm10ToAqi(NaN)).toBeNaN();
  });

  it("replays the Python reference values", () => {
    expect(aqiCases.pm10_cases.length).toBeGreaterThan(10);
    for (const c of aqiCases.pm10_cases) {
      const raw = c.pm10 as number | string;
      const pm = raw === "Infinity" ? Infinity : raw === "-Infinity" ? -Infinity : raw === "NaN" ? NaN : (raw as number);
      const got = pm10ToAqi(pm);
      if ((c.aqi as number | string) === "NaN") expect(got).toBeNaN();
      else expect(got).toBe(c.aqi as number);
    }
  });

  it("is a different scale from PM2.5: the same concentration reads lower as PM10", () => {
    expect(pm10ToAqi(100)).toBeLessThan(pm25ToAqi(100));
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
