/**
 * Pure derivations for the city panel: simulated and measured 24-hour AQI, model error, and the
 * breakdown legend (minor rows folded into one entry). No React; tested through the panel.
 */
import type { CityMeta } from "../api/types";
import { pm25ToAqi, rolling24h } from "../lib/aqi";
import { breakdown, breakdownIncomplete, type BreakdownRow } from "../lib/breakdown";
import { cityByTagAt, cityTotals, type Weights } from "../lib/compose";

export const MINOR_LABEL = "Minor sources (each under 5%)";
export const MINOR_COLOR = "#3e4554";

export interface LegendRow {
  key: string;
  label: string;
  color: string;
  share: number | null;
  kind: BreakdownRow["kind"] | "minor";
}

export interface CityView {
  totals: (number | null)[];
  simHourly: number | null;
  simMean: number | null;
  simAqi: number | null;
  legend: LegendRow[];
  incomplete: boolean;
  /** A tag without a weight (stale state) or an unknown tag: shown instead of numbers. */
  problem: string | null;
}

const fin = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

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
      out.push({ key: r.key, label: r.label, color: r.color, share: r.share, kind: r.kind });
    }
  }
  if (minorCount > 0) out.push({ key: "minor", label: MINOR_LABEL, color: MINOR_COLOR, share: minorShare, kind: "minor" });
  const gap = rows.find((r) => r.kind === "unexplained");
  if (gap) out.push({ key: gap.key, label: gap.label, color: gap.color, share: gap.share, kind: "unexplained" });
  return out;
}

export function cityView(
  city: CityMeta, weights: Weights, h: number, nHours: number, measuredHourly: number | null,
  labels: Readonly<Record<string, string>>,
): CityView {
  try {
    const totals = cityTotals(city, weights, nHours);
    const simMean = rolling24h(totals, h);
    const byTag = cityByTagAt(city, h);
    const rows = breakdown(byTag, weights, city.region, fin(measuredHourly) ? measuredHourly : null, labels);
    return {
      totals, simHourly: totals[h] ?? null, simMean, simAqi: simMean === null ? null : pm25ToAqi(simMean),
      legend: foldMinor(rows), incomplete: breakdownIncomplete(byTag, weights), problem: null,
    };
  } catch (e) {
    return {
      totals: [], simHourly: null, simMean: null, simAqi: null, legend: [], incomplete: false,
      problem: e instanceof Error ? e.message : String(e),
    };
  }
}

/** Measured 24-hour mean and AQI at hour h, computed the same way as the simulated one. */
export function measuredAt(values: readonly (number | null)[] | null, h: number) {
  const mean = values ? rolling24h(values, h) : null;
  const hourly = values?.[h];
  return { mean, aqi: mean === null ? null : pm25ToAqi(mean), hourly: fin(hourly) ? hourly : null };
}

/** True when the measured series has no value at all (or no stations). */
export function noMeasuredInWindow(values: readonly (number | null)[] | null, stationCount: number | null): boolean {
  return stationCount === 0 || !values || values.every((v) => !fin(v));
}
