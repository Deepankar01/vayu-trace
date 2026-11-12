import { describe, expect, it } from "vitest";
import { madeHere } from "./madeHere";

const ONE = {
  vehicles_delhi_ncr: 1, coarse_vehicles_delhi_ncr: 1, dust_delhi_ncr: 1, coarse_dust_delhi_ncr: 1,
  vehicles_punjab: 1, coarse_vehicles_punjab: 1, fire_punjab: 1, user_1: 1,
};

const city = {
  by_tag: {
    vehicles_delhi_ncr: [60], vehicles_punjab: [20], fire_punjab: [20],
    coarse_vehicles_delhi_ncr: [10], coarse_dust_delhi_ncr: [30], coarse_vehicles_punjab: [10],
  },
  by_tag_local: {
    vehicles_delhi_ncr: [40], // 20 of the Delhi NCR vehicles come from the region outside the city square
    coarse_vehicles_delhi_ncr: [8], coarse_dust_delhi_ncr: [27],
  },
};

describe("madeHere", () => {
  it("PM2.5: made here from by_tag_local, arrived = total − made here, shares of the total", () => {
    const m = madeHere(city, ONE, 0, "pm25");
    expect(m).toMatchObject({ local: 40, arrived: 60, added: 0, total: 100, localShare: 0.4, arrivedShare: 0.6 });
  });

  it("coarse: only the coarse tags", () => {
    const m = madeHere(city, ONE, 0, "coarse");
    expect(m).toMatchObject({ local: 35, arrived: 15, added: 0, total: 50, localShare: 0.7, arrivedShare: 0.3 });
  });

  it("PM10 is the sum of the two", () => {
    const m = madeHere(city, ONE, 0, "pm10");
    expect(m).toMatchObject({ local: 75, arrived: 75, total: 150, localShare: 0.5 });
  });

  it("applies the weights to both the local part and the total", () => {
    const w = { ...ONE, vehicles_delhi_ncr: 0.5, vehicles_punjab: 2, fire_punjab: 0 };
    // local 0.5 x 40 = 20; total 0.5 x 60 + 2 x 20 + 0 = 70
    expect(madeHere(city, w, 0, "pm25")).toMatchObject({ local: 20, arrived: 50, total: 70 });
    // a coarse twin follows its own weight entry
    const c = madeHere(city, { ...ONE, coarse_dust_delhi_ncr: 0 }, 0, "coarse");
    expect(c).toMatchObject({ local: 8, arrived: 12, total: 20, localShare: 0.4 });
  });

  it("a tag absent from by_tag_local is zeros (all of it arrived)", () => {
    const m = madeHere({ by_tag: { vehicles_punjab: [20] }, by_tag_local: {} }, ONE, 0, "pm25");
    expect(m).toMatchObject({ local: 0, arrived: 20, localShare: 0, arrivedShare: 1 });
  });

  it("added sources are a third part: not split by place, in PM2.5 and PM10, never in coarse", () => {
    const withUser = { by_tag: { ...city.by_tag, user_1: [25] }, by_tag_local: city.by_tag_local };
    const m = madeHere(withUser, ONE, 0, "pm25");
    expect(m).toMatchObject({ local: 40, arrived: 60, added: 25, total: 125, localShare: 0.32, addedShare: 0.2 });
    expect(madeHere(withUser, ONE, 0, "pm10")).toMatchObject({ added: 25, total: 175 });
    expect(madeHere(withUser, ONE, 0, "coarse")).toMatchObject({ added: 0, total: 50 });
    // switched off: weight 0
    expect(madeHere(withUser, { ...ONE, user_1: 0 }, 0, "pm25")).toMatchObject({ added: 0, total: 100 });
  });

  it("an undefined share is null, never 0: zero total", () => {
    const m = madeHere({ by_tag: {}, by_tag_local: {} }, ONE, 0, "coarse");
    expect(m).toMatchObject({ local: 0, arrived: 0, total: 0, localShare: null, arrivedShare: null, addedShare: null });
    const off = madeHere(city, { ...ONE, coarse_vehicles_delhi_ncr: 0, coarse_dust_delhi_ncr: 0, coarse_vehicles_punjab: 0 }, 0, "coarse");
    expect(off.total).toBe(0);
    expect(off.localShare).toBeNull();
  });

  it("an undefined share is null, never 0: missing data", () => {
    const gap = { by_tag: { vehicles_delhi_ncr: [null], vehicles_punjab: [20] }, by_tag_local: { vehicles_delhi_ncr: [null] } };
    expect(madeHere(gap, ONE, 0, "pm25")).toMatchObject({ local: null, arrived: null, total: null, localShare: null, arrivedShare: null });
    // a missing local value alone also leaves the split unknown
    const localGap = { by_tag: { vehicles_delhi_ncr: [60] }, by_tag_local: { vehicles_delhi_ncr: [null] } };
    expect(madeHere(localGap, ONE, 0, "pm25")).toMatchObject({ local: null, arrived: null, localShare: null });
    // a missing tag that is weighted out does not count
    expect(madeHere(gap, { ...ONE, vehicles_delhi_ncr: 0 }, 0, "pm25")).toMatchObject({ local: 0, arrived: 20, localShare: 0 });
    // an hour outside the series is missing too
    expect(madeHere(city, ONE, 5, "pm25").localShare).toBeNull();
  });

  it("floors the hour and throws for a tag without a weight (stale weights), like cityTotals", () => {
    expect(madeHere(city, ONE, 0.9, "pm25").local).toBe(40);
    expect(() => madeHere(city, { vehicles_delhi_ncr: 1 }, 0, "pm25")).toThrow(/no weight for source tag/);
  });
});
