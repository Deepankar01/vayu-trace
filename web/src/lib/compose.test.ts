import { describe, expect, it } from "vitest";
import { makeFrame } from "../test-utils/frames";
import { cityByTagAt, cityTotals, composeField, diffFields, lerpFields } from "./compose";

// frames are quantised to 16 bits (error <= max / 131068), so compare with a small tolerance
const near = (a: number, b: number) => Math.abs(a - b) <= 1e-3 * Math.max(1, Math.abs(b));

describe("composeField", () => {
  const a = [10, 20, 30, 40];
  const b = [1, 2, 3, 4];
  const frame = () => makeFrame(2, 2, { vehicles_delhi_ncr: a, dust_punjab: b });

  it("equals the manual weighted sum", () => {
    const out = composeField(frame(), { vehicles_delhi_ncr: 1, dust_punjab: 0.5 });
    expect(out).toBeInstanceOf(Float32Array);
    a.forEach((x, i) => expect(near(out[i], x + 0.5 * b[i])).toBe(true));
  });

  it("is all zeros when every weight is 0, even where a tag is missing", () => {
    const f = makeFrame(2, 2, { vehicles_delhi_ncr: [NaN, 2, 3, 4], dust_punjab: b });
    expect([...composeField(f, { vehicles_delhi_ncr: 0, dust_punjab: 0 })]).toEqual([0, 0, 0, 0]);
  });

  it("treats a tag without a weight as skipped and ignores weights for absent tags", () => {
    const out = composeField(frame(), { vehicles_delhi_ncr: 2, fire_punjab: 9 });
    a.forEach((x, i) => expect(near(out[i], 2 * x)).toBe(true));
  });

  it("keeps missing cells missing when a contributing tag is NaN", () => {
    const f = makeFrame(2, 2, { vehicles_delhi_ncr: [NaN, 2, 3, 4], dust_punjab: [1, 1, NaN, 1] });
    const out = composeField(f, { vehicles_delhi_ncr: 1, dust_punjab: 1 });
    expect(out[0]).toBeNaN();
    expect(out[2]).toBeNaN();
    expect(near(out[1], 3)).toBe(true);
    // a zero-weight tag's NaNs do not poison the result
    const only = composeField(f, { vehicles_delhi_ncr: 1, dust_punjab: 0 });
    expect(near(only[2], 3)).toBe(true);
    expect(only[0]).toBeNaN();
  });

  it("never sums __haze; opts.haze multiplies by it", () => {
    const f = makeFrame(2, 2, { vehicles_delhi_ncr: a }, [1, 2, 1.5, 1]);
    const plain = composeField(f, { vehicles_delhi_ncr: 1, __haze: 5 });
    a.forEach((x, i) => expect(near(plain[i], x)).toBe(true));
    const hazy = composeField(f, { vehicles_delhi_ncr: 1 }, { haze: true });
    [1, 2, 1.5, 1].forEach((h, i) => expect(near(hazy[i], a[i] * h)).toBe(true));
  });

  it("is independent of the frame's tag order (sorted accumulation)", () => {
    const x = makeFrame(2, 2, { vehicles_delhi_ncr: a, dust_punjab: b, fire_punjab: [0.1, 0.2, 0.3, 0.7] });
    const y = makeFrame(2, 2, { fire_punjab: [0.1, 0.2, 0.3, 0.7], dust_punjab: b, vehicles_delhi_ncr: a });
    const w = { vehicles_delhi_ncr: 0.7, dust_punjab: 1 / 3, fire_punjab: 2.9 };
    expect([...composeField(x, w)]).toEqual([...composeField(y, w)]);
  });

  it("gives zeros for a frame without the weighted tags", () => {
    expect([...composeField(makeFrame(2, 1, {}), { vehicles_delhi_ncr: 1 })]).toEqual([0, 0]);
  });
});

describe("lerpFields / diffFields", () => {
  it("blends and propagates NaN", () => {
    const a = Float32Array.of(0, 10, NaN);
    const b = Float32Array.of(10, 20, 5);
    expect([...lerpFields(a, b, 0.5).slice(0, 2)]).toEqual([5, 15]);
    expect(lerpFields(a, b, 0.5)[2]).toBeNaN();
    expect(lerpFields(a, b, 0)[0]).toBe(0);
    expect(lerpFields(a, b, 1)[2]).toBe(5);
    expect([...diffFields(b, Float32Array.of(1, 2, 3))]).toEqual([9, 18, 2]);
    expect(() => lerpFields(a, Float32Array.of(1), 0.5)).toThrow();
  });
});

describe("cityTotals / cityByTagAt", () => {
  const city = {
    by_tag: {
      vehicles_delhi_ncr: [10, 20, null, null],
      fire_punjab: [1, null, null, 4],
      user_1: [0, 0, 0, 5],
    },
  };

  it("sums value x weight per hour", () => {
    const t = cityTotals(city, { vehicles_delhi_ncr: 0.5, fire_punjab: 2, user_1: 1 });
    expect(t).toEqual([5 + 2 + 0, 10, 0, 8 + 5]); // user_1 is a real 0 at hour 2
  });

  it("is null only where every contributing tag is null; zero-weight tags do not count", () => {
    expect(cityTotals(city, { vehicles_delhi_ncr: 1 })).toEqual([10, 20, null, null]);
    expect(cityTotals(city, { fire_punjab: 1 })).toEqual([1, null, null, 4]);
    expect(cityTotals(city, { fire_punjab: 1, vehicles_delhi_ncr: 1 })).toEqual([11, 20, null, 4]);
  });

  it("with nothing contributing gives 0, except where all the city's series are missing", () => {
    expect(cityTotals(city, {})).toEqual([0, 0, 0, 0]);
    const gap = { by_tag: { vehicles_delhi_ncr: [1, null], fire_punjab: [2, null] } };
    expect(cityTotals(gap, { vehicles_delhi_ncr: 0, fire_punjab: 0 })).toEqual([0, null]);
    expect(cityTotals({ by_tag: {} }, { vehicles_delhi_ncr: 1 })).toEqual([]);
    expect(cityTotals({ by_tag: {} }, { vehicles_delhi_ncr: 1 }, 3)).toEqual([0, 0, 0]); // absent tags are zeros
  });

  it("is deterministic in sorted tag-id order", () => {
    const c = { by_tag: { b_tag: [0.1], a_tag: [0.2], c_tag: [0.3] } };
    const w = { a_tag: 1, b_tag: 1, c_tag: 1 };
    expect(cityTotals(c, w)).toEqual([0.2 + 0.1 + 0.3]);
  });

  it("cityByTagAt returns the hour's values, null where missing or out of range", () => {
    expect(cityByTagAt(city, 3)).toEqual({ fire_punjab: 4, user_1: 5, vehicles_delhi_ncr: null });
    expect(cityByTagAt(city, 1.9).vehicles_delhi_ncr).toBe(20);
    expect(cityByTagAt(city, 99).user_1).toBeNull();
  });
});
