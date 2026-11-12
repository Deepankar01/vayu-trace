import { describe, expect, it } from "vitest";
import { makeFrame } from "../test-utils/frames";
import { breakdown } from "./breakdown";
import { cityTotals, composeField } from "./compose";
import { foldToFine, fineTwin, inPollutant, measuredCoarse, measuredCoarseSeries, pickPollutant } from "./pollutant";

describe("pollutant tag selection", () => {
  it("pm25 = fine tags, coarse = coarse tags, pm10 = both; user sources are fine", () => {
    const ids = ["vehicles_delhi_ncr", "coarse_vehicles_delhi_ncr", "fire_punjab", "coarse_fire_punjab", "user_1"];
    const pick = (p: "pm25" | "pm10" | "coarse") => ids.filter((id) => inPollutant(id, p));
    expect(pick("pm25")).toEqual(["vehicles_delhi_ncr", "fire_punjab", "user_1"]);
    expect(pick("coarse")).toEqual(["coarse_vehicles_delhi_ncr", "coarse_fire_punjab"]);
    expect(pick("pm10")).toEqual(ids);
    expect(fineTwin("coarse_dust_delhi_ncr")).toBe("dust_delhi_ncr");
    expect(fineTwin("dust_delhi_ncr")).toBe("dust_delhi_ncr");
  });

  it("pickPollutant keeps the pollutant's series, sharing the arrays", () => {
    const a = [1, 2];
    const b = [3, 4];
    const byTag = { vehicles_delhi_ncr: a, coarse_vehicles_delhi_ncr: b };
    expect(pickPollutant(byTag, "pm25")).toEqual({ vehicles_delhi_ncr: a });
    expect(pickPollutant(byTag, "coarse").coarse_vehicles_delhi_ncr).toBe(b);
    expect(Object.keys(pickPollutant(byTag, "pm10"))).toHaveLength(2);
  });

  it("city totals per pollutant: pm10 = pm25 + coarse, hour by hour", () => {
    const byTag = { vehicles_delhi_ncr: [10, 20], coarse_vehicles_delhi_ncr: [1, 2], coarse_dust_delhi_ncr: [5, 5], user_1: [3, 3] };
    const w = { vehicles_delhi_ncr: 2, coarse_vehicles_delhi_ncr: 2, coarse_dust_delhi_ncr: 1, user_1: 1 };
    const total = (p: "pm25" | "pm10" | "coarse") => cityTotals({ by_tag: pickPollutant(byTag, p) }, w, 2);
    expect(total("pm25")).toEqual([23, 43]);
    expect(total("coarse")).toEqual([7, 9]);
    expect(total("pm10")).toEqual([30, 52]);
  });
});

describe("composeField with a pollutant", () => {
  const frame = () => makeFrame(2, 1, {
    vehicles_delhi_ncr: [10, 20], coarse_vehicles_delhi_ncr: [4, NaN], user_1: [1, 1],
  }, [1, 1]);
  const w = { vehicles_delhi_ncr: 1, coarse_vehicles_delhi_ncr: 0.5, user_1: 1 };

  it("sums only that pollutant's tags", () => {
    const fine = composeField(frame(), w, { pollutant: "pm25" });
    expect(fine[0]).toBeCloseTo(11, 2);
    expect(fine[1]).toBeCloseTo(21, 2); // the coarse tag's missing cell does not reach PM2.5
    const coarse = composeField(frame(), w, { pollutant: "coarse" });
    expect(coarse[0]).toBeCloseTo(2, 2);
    expect(coarse[1]).toBeNaN(); // missing stays missing where it belongs
    const pm10 = composeField(frame(), w, { pollutant: "pm10" });
    expect(pm10[0]).toBeCloseTo(13, 2);
    expect(pm10[1]).toBeNaN();
  });

  it("needs weights for the tags it sums and none for the others", () => {
    expect(() => composeField(frame(), { vehicles_delhi_ncr: 1, user_1: 1 }, { pollutant: "pm25" })).not.toThrow();
    expect(() => composeField(frame(), { vehicles_delhi_ncr: 1, user_1: 1 }, { pollutant: "pm10" }))
      .toThrow(/no weight for source tag 'coarse_vehicles_delhi_ncr'/);
  });

  it("without a pollutant every concentration tag is summed, as before", () => {
    expect(composeField(frame(), w)[0]).toBeCloseTo(13, 2);
  });
});

describe("foldToFine", () => {
  const now = {
    vehicles_delhi_ncr: 60, coarse_vehicles_delhi_ncr: 6,
    coarse_dust_delhi_ncr: 30, // its fine twin is absent from by_tag: zeros
    fire_punjab: 40, // no coarse twin in by_tag
    user_1: 5,
  };

  it("pm25: the fine values unchanged", () => {
    expect(foldToFine(now, "pm25")).toEqual({ vehicles_delhi_ncr: 60, fire_punjab: 40, user_1: 5 });
  });

  it("pm10: each coarse value added to its fine twin id; an absent twin counts as zeros", () => {
    expect(foldToFine(now, "pm10")).toEqual({ vehicles_delhi_ncr: 66, dust_delhi_ncr: 30, fire_punjab: 40, user_1: 5 });
  });

  it("coarse: coarse values alone, under the fine ids; no added sources", () => {
    expect(foldToFine(now, "coarse")).toEqual({ vehicles_delhi_ncr: 6, dust_delhi_ncr: 30 });
  });

  it("missing stays missing: a null or NaN twin makes the folded value null, never a part-sum", () => {
    expect(foldToFine({ vehicles_delhi_ncr: 60, coarse_vehicles_delhi_ncr: null }, "pm10")).toEqual({ vehicles_delhi_ncr: null });
    expect(foldToFine({ vehicles_delhi_ncr: NaN, coarse_vehicles_delhi_ncr: 6 }, "pm10")).toEqual({ vehicles_delhi_ncr: null });
    expect(foldToFine({ vehicles_delhi_ncr: null, coarse_vehicles_delhi_ncr: 6 }, "coarse")).toEqual({ vehicles_delhi_ncr: 6 });
  });

  it("feeds the unchanged breakdown: PM10 rows carry fine + coarse, weights by fine id, measured PM10 as denominator", () => {
    const rows = breakdown(foldToFine(now, "pm10"), { vehicles_delhi_ncr: 0.5, dust_delhi_ncr: 1, fire_punjab: 1, user_1: 1 }, "delhi_ncr", 200);
    const value = Object.fromEntries(rows.map((r) => [r.key, r.value]));
    expect(value).toEqual({ "fire:punjab": 40, "local:vehicles": 33, "local:dust": 30, "user:user_1": 5, unexplained: 92 });
    expect(rows.find((r) => r.key === "local:dust")).toMatchObject({ sector: "dust", share: 30 / 200 });
  });
});

describe("measured coarse (PM10 − PM2.5)", () => {
  it("is the difference when both are present", () => {
    expect(measuredCoarse(180, 100)).toBe(80);
  });
  it("is null (a dash) when either is missing", () => {
    expect(measuredCoarse(null, 100)).toBeNull();
    expect(measuredCoarse(180, null)).toBeNull();
    expect(measuredCoarse(undefined, undefined)).toBeNull();
    expect(measuredCoarse(NaN, 100)).toBeNull();
  });
  it("is 0 when PM10 reads below PM2.5, never negative", () => {
    expect(measuredCoarse(90, 100)).toBe(0);
    expect(measuredCoarse(100, 100)).toBe(0);
  });
  it("series: hour by hour, null without both series", () => {
    expect(measuredCoarseSeries([180, null, 90], [100, 50, 100])).toEqual([80, null, 0]);
    expect(measuredCoarseSeries([180, 200], [100])).toEqual([80, null]);
    expect(measuredCoarseSeries(null, [100])).toBeNull();
    expect(measuredCoarseSeries([180], null)).toBeNull();
  });
});
