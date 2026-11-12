import { describe, expect, it } from "vitest";
import { makeMeta } from "../test-utils/meta";
import {
  DEFAULT_SLIDERS, NO_SCENARIO, isFireAssumedHour, isForecastHour, selectBaselineWeights, selectWeights,
  type ScenarioState,
} from "./weights";

const base = (over: Partial<ScenarioState> = {}): ScenarioState => ({
  meta: makeMeta(), sliders: { ...DEFAULT_SLIDERS }, fireScaling: 1, firesContinue: true,
  regionScenario: { ...NO_SCENARIO }, userSources: [], ...over,
});

describe("selectWeights", () => {
  it("is empty before meta is loaded", () => {
    expect(selectWeights(base({ meta: null }))).toEqual({});
    expect(selectBaselineWeights({ meta: null })).toEqual({});
  });

  it("throws for a tag of unknown kind instead of weighting it 1", () => {
    const meta = makeMeta();
    meta.tags = [...meta.tags, { ...meta.tags[2], id: "mystery", kind: "volcano" as never }];
    expect(() => selectWeights(base({ meta }))).toThrow("tag 'mystery' has unknown kind 'volcano'");
  });

  it("gives every tag weight 1 at the defaults", () => {
    const w = selectWeights(base());
    expect(Object.keys(w).sort()).toEqual(makeMeta().tags.map((t) => t.id).sort());
    expect(Object.values(w).every((x) => x === 1)).toBe(true);
  });

  it("sector tags follow their slider", () => {
    const w = selectWeights(base({ sliders: { vehicles: 1.5, industry: 0, dust: 2, residential: 0.25 } }));
    expect(w).toMatchObject({
      vehicles_delhi_ncr: 1.5, vehicles_punjab: 1.5, industry_delhi_ncr: 0, dust_delhi_ncr: 2, residential_delhi_ncr: 0.25,
    });
  });

  it("odd-even scales Delhi NCR vehicles by 0.7 times the slider, and only those", () => {
    const w = selectWeights(base({ regionScenario: { delhiOddEven: true, delhiConstructionBan: false }, sliders: { ...DEFAULT_SLIDERS, vehicles: 2 } }));
    expect(w.vehicles_delhi_ncr).toBeCloseTo(1.4, 12);
    expect(w.vehicles_punjab).toBe(2);
    expect(w.dust_delhi_ncr).toBe(1);
  });

  it("the construction ban zeroes Delhi NCR dust only", () => {
    const w = selectWeights(base({ regionScenario: { delhiOddEven: false, delhiConstructionBan: true } }));
    expect(w.dust_delhi_ncr).toBe(0);
    expect(w.vehicles_delhi_ncr).toBe(1);
  });

  it("every coarse twin has exactly its fine tag's weight, under any scenario", () => {
    const meta = makeMeta();
    const scenarios: Partial<ScenarioState>[] = [
      {},
      { sliders: { vehicles: 1.5, industry: 0, dust: 2, residential: 0.25 } },
      { regionScenario: { delhiOddEven: true, delhiConstructionBan: true }, sliders: { ...DEFAULT_SLIDERS, vehicles: 2 } },
      { fireScaling: 3, firesContinue: false },
    ];
    for (const sc of scenarios) {
      const w = selectWeights(base({ meta, ...sc }));
      for (const t of meta.tags.filter((x) => x.size === "fine")) expect([t.id, w[`coarse_${t.id}`]]).toEqual([t.id, w[t.id]]);
    }
    const b = selectBaselineWeights({ meta });
    for (const t of meta.tags.filter((x) => x.size === "fine")) expect(b[`coarse_${t.id}`]).toBe(b[t.id]);
  });

  it("the Delhi scenarios reach the coarse twins of the Delhi NCR tags, and only those", () => {
    const w = selectWeights(base({ regionScenario: { delhiOddEven: true, delhiConstructionBan: true } }));
    expect(w.coarse_vehicles_delhi_ncr).toBeCloseTo(0.7, 12);
    expect(w.coarse_dust_delhi_ncr).toBe(0);
    expect(w.coarse_vehicles_punjab).toBe(1);
    // the dust slider at 0 switches the dust estimate off in both sizes
    const off = selectWeights(base({ sliders: { ...DEFAULT_SLIDERS, dust: 0 } }));
    expect([off.dust_delhi_ncr, off.coarse_dust_delhi_ncr]).toEqual([0, 0]);
  });

  it("fire tags take fireScaling; firefc only while fires continue", () => {
    expect(selectWeights(base({ fireScaling: 2 }))).toMatchObject({ fire_punjab: 2, firefc_punjab: 2 });
    expect(selectWeights(base({ fireScaling: 2, firesContinue: false }))).toMatchObject({ fire_punjab: 2, firefc_punjab: 0 });
  });

  it("user sources are 1 while enabled and 0 when toggled off", () => {
    const meta = makeMeta();
    meta.tags = [...meta.tags, { id: "user_1", kind: "user", sector: null, region: null, label: "x", color: "#999", size: "fine" }];
    expect(selectWeights(base({ meta, userSources: [{ id: "user_1", enabled: true }] })).user_1).toBe(1);
    expect(selectWeights(base({ meta, userSources: [{ id: "user_1", enabled: false }] })).user_1).toBe(0);
  });
});

describe("selectBaselineWeights", () => {
  it("ignores every scenario control, uses the default fire scaling and drops user sources", () => {
    const meta = makeMeta();
    meta.notes.fire_scaling_default = 1.5;
    meta.tags = [...meta.tags, { id: "user_1", kind: "user", sector: null, region: null, label: "x", color: "#999", size: "fine" }];
    const w = selectBaselineWeights({ meta });
    expect(w).toMatchObject({
      fire_punjab: 1.5, firefc_punjab: 1.5, vehicles_delhi_ncr: 1, dust_delhi_ncr: 1, vehicles_punjab: 1, user_1: 0,
    });
    // and it does not move with the scenario
    const moved = base({ meta, fireScaling: 4, firesContinue: false, sliders: { vehicles: 0, industry: 0, dust: 0, residential: 0 }, regionScenario: { delhiOddEven: true, delhiConstructionBan: true } });
    expect(selectBaselineWeights(moved)).toEqual(w);
  });
});

describe("forecast and assumed-fire hours", () => {
  const meta = makeMeta({ forecast_from: 20, fires_assumed_from: 12 });
  it("flags hours at or after the boundary, flooring a float playhead", () => {
    expect(isForecastHour(meta, 19)).toBe(false);
    expect(isForecastHour(meta, 19.9)).toBe(false);
    expect(isForecastHour(meta, 20)).toBe(true);
    expect(isFireAssumedHour(meta, 11.99)).toBe(false);
    expect(isFireAssumedHour(meta, 12)).toBe(true);
  });
  it("is false when the boundary is null or meta is missing", () => {
    expect(isForecastHour(makeMeta(), 29)).toBe(false);
    expect(isFireAssumedHour(makeMeta(), 29)).toBe(false);
    expect(isForecastHour(null, 5)).toBe(false);
    expect(isFireAssumedHour(null, 5)).toBe(false);
  });
});
