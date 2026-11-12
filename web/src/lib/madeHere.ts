/**
 * "Made here vs arrived": how much of a city's modelled concentration at one hour was emitted
 * inside the city's own ~30 km square (`by_tag_local`) and how much came from outside it. A model
 * estimate from the tagged parcels, not a measurement. The slider weights are applied here, as
 * everywhere in the browser.
 */
import type { CityMeta } from "../api/types";
import type { Weights } from "./compose";
import { inPollutant, isUserTag, type Pollutant } from "./pollutant";

export interface MadeHere {
  /** ug/m3 from catalogue sources inside the city's square; null when a value is missing. */
  local: number | null;
  /** ug/m3 from catalogue sources outside it (catalogue total − local). */
  arrived: number | null;
  /** ug/m3 from user-added sources (0 when there are none; they are not split by place). */
  added: number | null;
  /** local + arrived + added. */
  total: number | null;
  /** Shares of `total`, 0..1; null (shown as a dash, never 0 %) when the total is 0 or missing. */
  localShare: number | null;
  arrivedShare: number | null;
  addedShare: number | null;
}

type Series = Readonly<Record<string, readonly (number | null)[]>>;

/**
 * Weighted sum at hour `h` over the tags `keep` accepts, in sorted id order. Same rules as
 * `cityTotals`: weight 0 skips the tag, a tag without a weight throws, an absent tag is zeros and
 * a null/NaN value of a contributing tag makes the sum null (missing is never zero).
 */
function sumAt(series: Series, weights: Weights, h: number, keep: (id: string) => boolean): number | null {
  let total = 0;
  for (const id of Object.keys(series).sort()) {
    if (!keep(id)) continue;
    const w = weights[id];
    if (w === undefined) throw new Error(`no weight for source tag '${id}'`);
    if (w === 0) continue;
    const v = series[id][h];
    if (v == null || !Number.isFinite(v)) return null;
    total += v * w;
  }
  return total;
}

/**
 * Made here = sum of weight x `by_tag_local[tag]` over the pollutant's catalogue tags; arrived =
 * the weighted total of those tags − made here (floored at 0 against float rounding: the local
 * part is a part of the total); added = the weighted user-source total (fine, so none in the
 * coarse view).
 */
export function madeHere(
  city: Pick<CityMeta, "by_tag" | "by_tag_local">, weights: Weights, h: number, p: Pollutant,
): MadeHere {
  const hour = Math.floor(h);
  const catalogue = (id: string) => inPollutant(id, p) && !isUserTag(id);
  const local = sumAt(city.by_tag_local ?? {}, weights, hour, catalogue);
  const all = sumAt(city.by_tag, weights, hour, catalogue);
  const added = sumAt(city.by_tag, weights, hour, (id) => inPollutant(id, p) && isUserTag(id));
  const arrived = local === null || all === null ? null : Math.max(0, all - local);
  const total = local === null || arrived === null || added === null ? null : local + arrived + added;
  const share = (x: number | null) => (x === null || total === null || !(total > 0) ? null : x / total);
  return { local, arrived, added, total, localShare: share(local), arrivedShare: share(arrived), addedShare: share(added) };
}
