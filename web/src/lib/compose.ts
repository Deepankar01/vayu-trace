/**
 * Source composition in the browser: the server serves per-tag fields and never applies the
 * slider weights, so every weighted number on screen is made here.
 */
import { HAZE, NAN_CODE, type Frame } from "../api/decode";
import type { CityMeta } from "../api/types";
import { inPollutant, type Pollutant } from "./pollutant";

export type Weights = Record<string, number>;

/**
 * Weighted sum of a frame's concentration tags: sum of `code * scale * weight` per cell.
 *
 * - Tags are visited in sorted id order and accumulated in float32, so the result is
 *   deterministic and does not depend on the frame's tag order.
 * - A tag with weight 0 is skipped entirely, so its missing cells do not poison the result. All
 *   weights 0 gives all zeros. A concentration tag present in the frame with NO entry in
 *   `weights` is a bug (stale weights), not a zero: it throws.
 * - Missing stays missing: a cell is NaN if ANY contributing tag (non-zero weight) is missing
 *   (code 65535) there. Never zero-filled.
 * - `__haze` is a multiplicative factor, not a concentration, and is never summed. With
 *   `opts.haze` the result is multiplied by it (drawing opacity only; a missing haze cell
 *   makes the cell NaN; a frame without `__haze` throws, the server always sends it).
 * - With `opts.pollutant` only that pollutant's tags are summed (see `inPollutant`); the others
 *   are left out entirely, so they neither need a weight nor spread their missing cells.
 */
export function composeField(
  frame: Frame, weights: Weights, opts: { haze?: boolean; pollutant?: Pollutant } = {},
): Float32Array {
  const out = new Float32Array(frame.nx * frame.ny);
  const p = opts.pollutant;
  const ids = [...frame.tags.keys()].filter((id) => id !== HAZE && (p === undefined || inPollutant(id, p))).sort();
  for (const id of ids) {
    const w = weights[id];
    if (w === undefined) throw new Error(`no weight for source tag '${id}'`);
    if (w === 0) continue;
    const { data, scale } = frame.tags.get(id)!;
    const k = scale * w;
    for (let i = 0; i < out.length; i++) {
      const c = data[i];
      if (c === NAN_CODE) out[i] = NaN;
      else out[i] += c * k;
    }
  }
  if (opts.haze) {
    const haze = frame.tags.get(HAZE);
    if (!haze) throw new Error("frame has no __haze tag");
    for (let i = 0; i < out.length; i++) {
      const c = haze.data[i];
      out[i] = c === NAN_CODE ? NaN : out[i] * (c * haze.scale);
    }
  }
  return out;
}

/** Linear blend `a*(1-t) + b*t` of two fields; NaN where either end is NaN (0 < t < 1). */
export function lerpFields(a: Float32Array, b: Float32Array, t: number): Float32Array {
  if (a.length !== b.length) throw new Error("fields differ in size");
  if (t <= 0) return Float32Array.from(a);
  if (t >= 1) return Float32Array.from(b);
  const out = new Float32Array(a.length);
  const s = 1 - t;
  for (let i = 0; i < out.length; i++) out[i] = a[i] * s + b[i] * t;
  return out;
}

/** `a - b` per cell (the "compare with baseline" map); NaN where either is NaN. */
export function diffFields(a: Float32Array, b: Float32Array): Float32Array {
  if (a.length !== b.length) throw new Error("fields differ in size");
  const out = new Float32Array(a.length);
  for (let i = 0; i < out.length; i++) out[i] = a[i] - b[i];
  return out;
}

/** The city's per-tag values at one hour (index `h`, floored); null where missing or out of range. */
export function cityByTagAt(city: Pick<CityMeta, "by_tag">, h: number): Record<string, number | null> {
  const i = Math.floor(h);
  const out: Record<string, number | null> = {};
  for (const id of Object.keys(city.by_tag).sort()) out[id] = city.by_tag[id][i] ?? null;
  return out;
}

/**
 * Weighted city total per hour (ug/m3) from the meta per-tag series: sum over tags in sorted id
 * order of `value * weight`, left to right. Same rule as `composeField`:
 * - tags with weight 0 are skipped; a tag in `by_tag` with NO entry in `weights` throws;
 * - missing stays missing: if ANY contributing tag (non-zero weight) is null at an hour, that
 *   hour's total is null (never an under-estimate);
 * - the server omits a tag only when its series is entirely exact zeros (a series with any null
 *   is kept), so an absent tag counts as zeros and a present one's null is missing;
 * - with nothing contributing the total is 0. Pass `nHours` (meta.hours.length) so a city with no
 *   tags at all still yields `nHours` zeros.
 */
export function cityTotals(city: Pick<CityMeta, "by_tag">, weights: Weights, nHours = 0): (number | null)[] {
  const ids = Object.keys(city.by_tag).sort();
  for (const id of ids) {
    if (weights[id] === undefined) throw new Error(`no weight for source tag '${id}'`);
  }
  const contributing = ids.filter((id) => weights[id] !== 0);
  const hours = ids.reduce((n, id) => Math.max(n, city.by_tag[id].length), nHours);
  const out: (number | null)[] = [];
  for (let h = 0; h < hours; h++) {
    let total: number | null = 0;
    for (const id of contributing) {
      const v = city.by_tag[id][h];
      if (v == null) {
        total = null;
        break;
      }
      total += v * weights[id];
    }
    out.push(total);
  }
  return out;
}
