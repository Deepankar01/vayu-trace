/**
 * Pure derivations for the city panel, for the pollutant in view: simulated and measured 24-hour
 * mean and AQI, model error, and the breakdown legend (minor rows folded into one entry). No
 * React; tested through the panel.
 */
import type { CityMeta } from "../api/types";
import { pm10ToAqi, pm25ToAqi, rolling24h } from "../lib/aqi";
import { breakdown, breakdownIncomplete, type BreakdownRow } from "../lib/breakdown";
import { cityByTagAt, cityTotals, type Weights } from "../lib/compose";
import { foldToFine, measuredCoarseSeries, pickPollutant, type Pollutant } from "../lib/pollutant";
import type { CityDataState } from "../state/store";

export const MINOR_LABEL = "Minor sources (each under 5%)";
export const MINOR_COLOR = "#3e4554";

export interface LegendRow {
  key: string;
  label: string;
  color: string;
  share: number | null;
  kind: BreakdownRow["kind"] | "minor";
  /** The row's sector (null for fires, added sources, the minor fold and the gap). */
  sector: string | null;
}

export interface CityView {
  totals: (number | null)[];
  simHourly: number | null;
  simMean: number | null;
  /** Null in the coarse view too: coarse PM alone has no AQI. */
  simAqi: number | null;
  /** The model's coarse PM (2.5-10 um) at this hour; null in the PM2.5 view (not shown there). */
  simCoarseHourly: number | null;
  legend: LegendRow[];
  incomplete: boolean;
  /** A tag without a weight (stale state) or an unknown tag: shown instead of numbers. */
  problem: string | null;
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** The CPCB 24-hour AQI of a mean concentration of `p`; null for coarse PM (no index exists). */
export function aqiOf(p: Pollutant, mean: number | null): number | null {
  if (mean === null || p === "coarse") return null;
  return p === "pm10" ? pm10ToAqi(mean) : pm25ToAqi(mean);
}

/** Breakdown rows in order, minor rows folded into one entry placed before "Not explained". */
export function foldMinor(rows: readonly BreakdownRow[]): LegendRow[] {
  const out: LegendRow[] = [];
  let minorShare = 0;
  let minorCount = 0;
  for (const r of rows) {
    if (r.minor) {
      minorShare += r.share ?? 0;
      minorCount++;
    } else if (r.kind !== "unexplained") {
      out.push({ key: r.key, label: r.label, color: r.color, share: r.share, kind: r.kind, sector: r.sector });
    }
  }
  if (minorCount > 0) out.push({ key: "minor", label: MINOR_LABEL, color: MINOR_COLOR, share: minorShare, kind: "minor", sector: null });
  const gap = rows.find((r) => r.kind === "unexplained");
  if (gap) out.push({ key: gap.key, label: gap.label, color: gap.color, share: gap.share, kind: "unexplained", sector: null });
  return out;
}

/**
 * The city's numbers for `pollutant` (default PM2.5: fine tags only, as before PM10 existed).
 * `measuredHourly` must be the measurement of the same pollutant (for coarse: PM10 − PM2.5). The
 * breakdown is made on fine tag ids: coarse values are folded into their twins (`foldToFine`).
 */
export function cityView(
  city: CityMeta, weights: Weights, h: number, nHours: number, measuredHourly: number | null,
  labels: Readonly<Record<string, string>>, pollutant: Pollutant = "pm25",
): CityView {
  try {
    const mine = { by_tag: pickPollutant(city.by_tag, pollutant) };
    const totals = cityTotals(mine, weights, nHours);
    const simMean = rolling24h(totals, h);
    const byTag = foldToFine(cityByTagAt(mine, h), pollutant);
    const rows = breakdown(byTag, weights, city.region, fin(measuredHourly) ? measuredHourly : null, labels);
    const coarse =
      pollutant === "pm25" ? null
        : pollutant === "coarse" ? totals
        : cityTotals({ by_tag: pickPollutant(city.by_tag, "coarse") }, weights, nHours);
    return {
      totals, simHourly: totals[h] ?? null, simMean, simAqi: aqiOf(pollutant, simMean),
      simCoarseHourly: coarse?.[h] ?? null,
      legend: foldMinor(rows), incomplete: breakdownIncomplete(byTag, weights), problem: null,
    };
  } catch (e) {
    return {
      totals: [], simHourly: null, simMean: null, simAqi: null, simCoarseHourly: null, legend: [], incomplete: false,
      problem: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Measured 24-hour mean and AQI at hour h, computed the same way as the simulated one. */
export function measuredAt(values: readonly (number | null)[] | null, h: number, pollutant: Pollutant = "pm25") {
  const mean = values ? rolling24h(values, h) : null;
  const hourly = values?.[h];
  return { mean, aqi: aqiOf(pollutant, mean), hourly: fin(hourly) ? hourly : null };
}

/**
 * "Measured coarse" as one data state, from the CPCB PM10 and PM2.5 states: an error if either
 * failed (saying which), loading until both are in, then PM10 − PM2.5 hour by hour (see
 * `measuredCoarse`). The station count is the smaller of the two, so "no stations" still reads
 * as no data.
 */
export function coarseMeasured(pm10: CityDataState, pm25: CityDataState): CityDataState {
  const failed = pm10.status === "error" ? (["PM10", pm10] as const) : pm25.status === "error" ? (["PM2.5", pm25] as const) : null;
  if (failed) return { status: "error", values: null, stationCount: null, error: `${failed[0]}: ${failed[1].error ?? "error"}` };
  if (pm10.status !== "ready" || pm25.status !== "ready") return { status: "loading", values: null, stationCount: null, error: null };
  return {
    status: "ready", values: measuredCoarseSeries(pm10.values, pm25.values),
    stationCount: Math.min(pm10.stationCount ?? 0, pm25.stationCount ?? 0), error: null,
  };
}

/** True when the measured series has no value at all (or no stations). */
export function noMeasuredInWindow(values: readonly (number | null)[] | null, stationCount: number | null): boolean {
  return stationCount === 0 || !values || values.every((v) => !fin(v));
}
