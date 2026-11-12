/**
 * Which particles a view shows, and the tag arithmetic that follows from it.
 *
 * The model carries two sets of tags: fine (PM2.5) and their coarse twins (`coarse_` + the fine
 * id: the 2.5-10 um part of PM10). A view is one of
 * - "pm25": fine tags only;
 * - "pm10": fine + coarse tags;
 * - "coarse": coarse tags only (PM10 minus PM2.5).
 * User-added sources are fine: they count in pm25 and pm10 and never in coarse.
 */
import { COARSE_PREFIX } from "./tags";

export type Pollutant = "pm25" | "pm10" | "coarse";
export const POLLUTANTS: readonly Pollutant[] = ["pm25", "pm10", "coarse"];

/** Short name, as used in labels and sentences. */
export const POLLUTANT_LABEL: Readonly<Record<Pollutant, string>> = {
  pm25: "PM2.5", pm10: "PM10", coarse: "Coarse PM",
};
/** The same inside a sentence ("hourly coarse PM"). */
export const POLLUTANT_INLINE: Readonly<Record<Pollutant, string>> = {
  pm25: "PM2.5", pm10: "PM10", coarse: "coarse PM",
};
export const COARSE_LONG = "Coarse PM, 2.5–10 µm";
export const NO_COARSE_AQI = "No AQI for coarse PM alone: the CPCB index is defined for PM2.5 and PM10";

export const isCoarseTag = (id: string) => id.startsWith(COARSE_PREFIX);
export const isUserTag = (id: string) => id.startsWith("user_");
/** The fine tag a tag folds into: itself, or a coarse tag's twin. */
export const fineTwin = (id: string) => (isCoarseTag(id) ? id.slice(COARSE_PREFIX.length) : id);

/** True when tag `id` is part of pollutant `p`. Decided by the id alone (the server's naming rule). */
export function inPollutant(id: string, p: Pollutant): boolean {
  return p === "pm10" || isCoarseTag(id) === (p === "coarse");
}

/** The entries of a per-tag record that belong to `p` (values are shared, not copied). */
export function pickPollutant<T>(byTag: Readonly<Record<string, T>>, p: Pollutant): Record<string, T> {
  const out: Record<string, T> = {};
  for (const id of Object.keys(byTag)) if (inPollutant(id, p)) out[id] = byTag[id];
  return out;
}

const missing = (v: number | null | undefined): v is null | undefined => v == null || !Number.isFinite(v);

/**
 * One hour's per-tag values of pollutant `p`, keyed by FINE tag id, ready for `breakdown` (whose
 * contract knows fine ids only): each coarse value is added to its fine twin (pm10) or stands in
 * for it (coarse). A tag absent from the input is zeros, so a lone twin passes through unchanged.
 * Missing stays missing: if either twin is null/NaN the folded value is null, never a part-sum.
 * The weights need no folding: a coarse twin always has its fine tag's weight.
 */
export function foldToFine(byTagNow: Readonly<Record<string, number | null>>, p: Pollutant): Record<string, number | null> {
  const out: Record<string, number | null> = {};
  for (const id of Object.keys(byTagNow).sort()) {
    if (!inPollutant(id, p)) continue;
    const key = fineTwin(id);
    const v = byTagNow[id];
    if (!(key in out)) out[key] = missing(v) ? null : v;
    else {
      const prev = out[key];
      out[key] = prev === null || missing(v) ? null : prev + v;
    }
  }
  return out;
}

/**
 * Measured coarse PM at one hour from the two CPCB city means: PM10 − PM2.5. Null when either is
 * missing. The two means can come from different stations, so PM10 can read below PM2.5: that is
 * shown as 0, with no further claim. Displayed evidence only; never used to adjust the model.
 */
export function measuredCoarse(pm10: number | null | undefined, pm25: number | null | undefined): number | null {
  if (missing(pm10) || missing(pm25)) return null;
  return Math.max(0, pm10 - pm25);
}

/** `measuredCoarse` hour by hour; null when either series is absent. */
export function measuredCoarseSeries(
  pm10: readonly (number | null)[] | null, pm25: readonly (number | null)[] | null,
): (number | null)[] | null {
  if (!pm10 || !pm25) return null;
  return Array.from({ length: Math.max(pm10.length, pm25.length) }, (_, h) => measuredCoarse(pm10[h], pm25[h]));
}
