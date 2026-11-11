/**
 * Pure selectors that turn scenario state into per-tag weights. No React, no store: they take
 * the state they need so they can be tested directly.
 */
import type { Meta, Sector, TagMeta } from "../api/types";
import type { Weights } from "../lib/compose";

export interface RegionScenario {
  delhiOddEven: boolean;
  delhiConstructionBan: boolean;
}

export type Sliders = Record<Sector, number>;

export interface UserSourceState {
  id: string;
  enabled: boolean;
}

/** What the weight rules read. */
export interface ScenarioState {
  meta: Pick<Meta, "tags" | "notes"> | null;
  sliders: Sliders;
  fireScaling: number;
  firesContinue: boolean;
  regionScenario: RegionScenario;
  userSources: readonly UserSourceState[];
}

export const ODD_EVEN_VEHICLE_FACTOR = 0.7;
export const SLIDER_RANGE = { min: 0, max: 2 } as const;
export const FIRE_SCALING_RANGE = { min: 0.5, max: 5 } as const;
export const DEFAULT_SLIDERS: Sliders = { vehicles: 1, industry: 1, dust: 1, residential: 1 };
export const NO_SCENARIO: RegionScenario = { delhiOddEven: false, delhiConstructionBan: false };

interface Rules {
  sliders: Sliders;
  fireScaling: number;
  firesContinue: boolean;
  region: RegionScenario;
  userOn: (id: string) => boolean;
}

function weightOf(tag: TagMeta, r: Rules): number {
  switch (tag.kind) {
    case "fire":
      return r.fireScaling;
    case "firefc":
      return r.firesContinue ? r.fireScaling : 0;
    case "user":
      return r.userOn(tag.id) ? 1 : 0;
    case "sector": {
      const base = r.sliders[tag.sector as Sector] ?? 1;
      if (tag.id === "vehicles_delhi_ncr" && r.region.delhiOddEven) return base * ODD_EVEN_VEHICLE_FACTOR;
      if (tag.id === "dust_delhi_ncr" && r.region.delhiConstructionBan) return base * 0;
      return base;
    }
    default:
      // never a silent weight of 1: an unknown kind is a contract break with the server
      throw new Error(`tag '${tag.id}' has unknown kind '${String(tag.kind)}'`);
  }
}

/** Weight for every tag in `meta.tags` (empty before meta is loaded). */
export function selectWeights(s: ScenarioState): Weights {
  if (!s.meta) return {};
  const enabled = new Map(s.userSources.map((u) => [u.id, u.enabled]));
  const rules: Rules = {
    sliders: s.sliders, fireScaling: s.fireScaling, firesContinue: s.firesContinue,
    region: s.regionScenario, userOn: (id) => enabled.get(id) ?? true,
  };
  return Object.fromEntries(s.meta.tags.map((t) => [t.id, weightOf(t, rules)]));
}

/** Weights of the unmodified run ("Compare with baseline"): sliders 1, no scenario, default
 *  fire scaling, fires continue, no user sources (weight 0). */
export function selectBaselineWeights(s: Pick<ScenarioState, "meta">): Weights {
  if (!s.meta) return {};
  const rules: Rules = {
    sliders: DEFAULT_SLIDERS, fireScaling: s.meta.notes.fire_scaling_default, firesContinue: true,
    region: NO_SCENARIO, userOn: () => false,
  };
  return Object.fromEntries(s.meta.tags.map((t) => [t.id, weightOf(t, rules)]));
}

/** Hour index (an integer frame index, or a float playhead which is floored) is a forecast hour. */
export function isForecastHour(meta: Pick<Meta, "forecast_from"> | null, h: number): boolean {
  return meta?.forecast_from != null && Math.floor(h) >= meta.forecast_from;
}

/** Fire emissions at this hour are assumed by persistence rather than observed. */
export function isFireAssumedHour(meta: Pick<Meta, "fires_assumed_from"> | null, h: number): boolean {
  return meta?.fires_assumed_from != null && Math.floor(h) >= meta.fires_assumed_from;
}

type Deps = readonly unknown[];
const sameDeps = (a: Deps | null, b: Deps) => a !== null && a.every((x, i) => Object.is(x, b[i]));

/**
 * Memoised selectors: the same inputs (meta tags/notes, sliders, fire scaling, fires-continue,
 * Delhi scenarios, user sources) return the SAME object, so `useStore((s) => s.weights())` does
 * not re-render on unrelated store changes (hour, frames, ...). Callers must treat the result as
 * read-only. The store creates one pair per store instance.
 */
export function createWeightSelectors() {
  let wDeps: Deps | null = null;
  let wOut: Weights = {};
  let bDeps: Deps | null = null;
  let bOut: Weights = {};
  return {
    weights(s: ScenarioState): Weights {
      const deps = [s.meta?.tags, s.meta?.notes, s.sliders, s.fireScaling, s.firesContinue, s.regionScenario, s.userSources];
      if (!sameDeps(wDeps, deps)) {
        wOut = selectWeights(s);
        wDeps = deps;
      }
      return wOut;
    },
    baselineWeights(s: Pick<ScenarioState, "meta">): Weights {
      const deps = [s.meta?.tags, s.meta?.notes];
      if (!sameDeps(bDeps, deps)) {
        bOut = selectBaselineWeights(s);
        bDeps = deps;
      }
      return bOut;
    },
  };
}
