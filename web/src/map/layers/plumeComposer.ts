/**
 * Per-hour composition for the plume, memoised. Composing up to 68 tags x 102,400 cells is too slow for
 * every animation frame, so each whole hour is composed (and Mercator-resampled) once per key;
 * per frame only two composed hours are blended and colourised (`colorizeInto`).
 */
import { HAZE, NAN_CODE, type Frame } from "../../api/decode";
import { composeField, diffFields, type Weights } from "../../lib/compose";
import type { Pollutant } from "../../lib/pollutant";
import { PLUME_ROWS, resampleRowsToMercator, type PlumeMode } from "./plume";

export interface HourKey {
  hour: number;
  build: string;
  /** The cached frame object (a refetch is a new object). */
  frame: Frame;
  /** The store's memoised weights (compared by identity). */
  weights: Weights;
  /** Baseline weights in diff mode, else null. */
  baseline: Weights | null;
  mode: PlumeMode;
  /** Only this pollutant's tags are composed; absent = every concentration tag in the frame. */
  pollutant?: Pollutant;
  /** frameCache.isStale(hour) when composed. */
  stale: boolean;
}

export interface ComposedHour {
  key: HourKey;
  /** Mercator-resampled, south first: the dry concentration or composed minus baseline (diff). */
  value: Float32Array;
  /** Mercator-resampled haze ratio (`__haze`, the growth factor = haze-weighted / dry); null in diff. */
  haze: Float32Array | null;
}

/** Same memo key: every field equal, objects by identity. */
export function sameHourKey(a: HourKey | null, b: HourKey): boolean {
  return (
    a !== null && a.hour === b.hour && a.build === b.build && a.frame === b.frame && a.weights === b.weights &&
    a.baseline === b.baseline && a.mode === b.mode && a.pollutant === b.pollutant && a.stale === b.stale
  );
}

/**
 * Which hours to draw at playhead `x` (frames are hour means): `a = floor(x)` blended towards
 * `a + 1` by `t = x - floor(x)`. If one of the two is not loaded the other is drawn alone (no
 * stall); if neither, null (draw nothing).
 */
export function playheadPair(
  x: number, nHours: number, loaded: (h: number) => boolean,
): { a: number; b: number | null; t: number } | null {
  const h0 = Math.floor(x);
  const t = x - h0;
  const h1 = h0 + 1;
  const has0 = loaded(h0);
  const has1 = t > 0 && h1 < nHours && loaded(h1);
  if (has0 && has1) return { a: h0, b: h1, t };
  if (has0) return { a: h0, b: null, t: 0 };
  if (has1) return { a: h1, b: null, t: 0 };
  return null;
}

/**
 * The hour the plume is waiting for at playhead `x`, or null when what is drawn matches the
 * playhead. Non-null both when nothing is drawn and when only one of the two bracketing hours is
 * (the picture is then an hour mean, not the blend for this instant). Drives "loading hour N…".
 */
export function missingPlumeHour(x: number, nHours: number, loaded: (h: number) => boolean): number | null {
  const h0 = Math.floor(x);
  if (!loaded(h0)) return h0;
  const h1 = h0 + 1;
  if (x - h0 > 0 && h1 < nHours && !loaded(h1)) return h1;
  return null;
}

export interface GridSpec {
  lat_min: number;
  cell: number;
  nx: number;
  ny: number;
}

const KEEP = 4;

export class PlumeComposer {
  private readonly cache = new Map<number, ComposedHour>();
  private readonly grid: GridSpec;
  /** How many hours were actually composed (for tests / diagnostics). */
  composeCount = 0;

  constructor(grid: GridSpec) {
    this.grid = grid;
  }

  get size(): number {
    return this.cache.size;
  }

  /** The composed hour for `key`, composing only when the memo key changed. May throw (composeField). */
  get(key: HourKey): ComposedHour {
    const hit = this.cache.get(key.hour);
    if (hit && sameHourKey(hit.key, key)) {
      // refresh recency
      this.cache.delete(key.hour);
      this.cache.set(key.hour, hit);
      return hit;
    }
    const made = this.compose(key);
    this.cache.delete(key.hour);
    this.cache.set(key.hour, made);
    while (this.cache.size > KEEP) this.cache.delete(this.cache.keys().next().value!);
    return made;
  }

  clear(): void {
    this.cache.clear();
  }

  private compose(key: HourKey): ComposedHour {
    this.composeCount++;
    const { nx, ny, lat_min, cell } = this.grid;
    const latMax = lat_min + cell * ny;
    const resample = (f: Float32Array) => resampleRowsToMercator(f, nx, ny, lat_min, latMax, PLUME_ROWS);
    const only = { pollutant: key.pollutant };
    const dry = composeField(key.frame, key.weights, only);
    if (key.baseline) {
      const base = composeField(key.frame, key.baseline, only);
      return { key, value: resample(diffFields(dry, base)), haze: null };
    }
    let haze: Float32Array | null = null;
    const h = key.frame.tags.get(HAZE);
    if (h) {
      const ratio = new Float32Array(nx * ny);
      for (let i = 0; i < ratio.length; i++) ratio[i] = h.data[i] === NAN_CODE ? NaN : h.data[i] * h.scale;
      haze = resample(ratio);
    }
    return { key, value: resample(dry), haze };
  }
}
