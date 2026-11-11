/**
 * Satellite fire detections: a soft additive glow (#ff5a2b) with a pale core, radius by
 * sqrt(FRP), for the 24 h up to the playhead, fading with age. The detections (~55k per run) are
 * sorted by hour once; the window is found by binary search and drawn as zero-copy views into
 * those arrays, rebuilt only when the playhead's WHOLE hour changes.
 */
import { ScatterplotLayer } from "@deck.gl/layers";
import type { Fire } from "../../api/types";
import { ADDITIVE_BLEND } from "./rgba";

export const FIRE_WINDOW_H = 24;
const RADIUS_PER_SQRT_MW = 0.9;
const MIN_R = 1.5;
const MAX_R = 9;
const MIN_ALPHA = 0.15;

const GLOW_RGB = [0xff, 0x5a, 0x2b];
// Additive: thousands of overlapping detections in Punjab add up, so each one is faint.
const GLOW_ALPHA = 0.16;
const CORE_ALPHA = 0.5;
const CORE_RGB = [0xff, 0xb8, 0x80]; // between the mockup's #ffd9a8 core and the fire red: reads as embers, not a white blob

export function fireRadiusPx(frpMw: number): number {
  if (!(frpMw > 0)) return MIN_R;
  return Math.min(MAX_R, Math.max(MIN_R, RADIUS_PER_SQRT_MW * Math.sqrt(frpMw)));
}

/** Opacity by age in hours: 1 when new, falling linearly to 0.15 at 23 h. */
export function fireAlpha(ageH: number): number {
  const a = Math.min(Math.max(ageH, 0), FIRE_WINDOW_H - 1) / (FIRE_WINDOW_H - 1);
  return 1 - (1 - MIN_ALPHA) * a;
}

export interface PreparedFires {
  n: number;
  /** Sorted ascending (stable). */
  hours: Int32Array;
  /** lon, lat per detection, in `hours` order. */
  positions: Float32Array;
  radii: Float32Array;
  /** RGBA scratch, written for the current window only. */
  glow: Uint8Array;
  core: Uint8Array;
}

export function prepareFires(fires: readonly Fire[]): PreparedFires {
  const order = fires.map((_, i) => i).sort((a, b) => fires[a][3] - fires[b][3] || a - b);
  const n = fires.length;
  const hours = new Int32Array(n);
  const positions = new Float32Array(2 * n);
  const radii = new Float32Array(n);
  order.forEach((src, k) => {
    const [lon, lat, frp, hour] = fires[src];
    hours[k] = hour;
    positions[2 * k] = lon;
    positions[2 * k + 1] = lat;
    radii[k] = fireRadiusPx(frp);
  });
  return { n, hours, positions, radii, glow: new Uint8Array(4 * n), core: new Uint8Array(4 * n) };
}

/** First index with hours[i] >= h. */
function lowerBound(hours: Int32Array, h: number): number {
  let lo = 0;
  let hi = hours.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (hours[mid] < h) lo = mid + 1;
    else hi = mid;
  }
  return lo;
}

/** [lo, hi) of detections with hour index in `floor(x) - 23 .. floor(x)`. */
export function fireWindow(hours: Int32Array, x: number): [number, number] {
  const h = Math.floor(x);
  return [lowerBound(hours, h - FIRE_WINDOW_H + 1), lowerBound(hours, h + 1)];
}

export interface FireWindowData {
  length: number;
  positions: Float32Array;
  radii: Float32Array;
  glow: Uint8Array;
  core: Uint8Array;
}

/** Views of the window at playhead `x` with age-faded colours written in place. */
export function windowData(p: PreparedFires, x: number): FireWindowData {
  const [lo, hi] = fireWindow(p.hours, x);
  const h = Math.floor(x);
  for (let i = lo; i < hi; i++) {
    const a = fireAlpha(h - p.hours[i]);
    const o = 4 * i;
    p.glow[o] = GLOW_RGB[0];
    p.glow[o + 1] = GLOW_RGB[1];
    p.glow[o + 2] = GLOW_RGB[2];
    p.glow[o + 3] = Math.round(255 * GLOW_ALPHA * a);
    p.core[o] = CORE_RGB[0];
    p.core[o + 1] = CORE_RGB[1];
    p.core[o + 2] = CORE_RGB[2];
    p.core[o + 3] = Math.round(255 * CORE_ALPHA * a);
  }
  return {
    length: hi - lo,
    positions: p.positions.subarray(2 * lo, 2 * hi),
    radii: p.radii.subarray(lo, hi),
    glow: p.glow.subarray(4 * lo, 4 * hi),
    core: p.core.subarray(4 * lo, 4 * hi),
  };
}

/** A scatterplot whose discs fade from the centre outwards: a cheap blur for the glow. */
class SoftScatterplotLayer extends ScatterplotLayer {
  static layerName = "SoftScatterplotLayer";
  getShaders() {
    const shaders = super.getShaders();
    return {
      ...shaders,
      inject: {
        ...shaders.inject,
        "fs:DECKGL_FILTER_COLOR": "float fall = 1.0 - clamp(length(geometry.uv), 0.0, 1.0); color.a *= fall * fall;",
      },
    };
  }
}

export function fireLayers(w: FireWindowData, beforeId: string | undefined) {
  const base = { length: w.length, attributes: { getPosition: { value: w.positions, size: 2 }, getRadius: { value: w.radii, size: 1 } } };
  const common = {
    radiusUnits: "pixels" as const,
    beforeId,
    pickable: false,
    parameters: { ...ADDITIVE_BLEND, depthWriteEnabled: false },
  };
  return [
    new SoftScatterplotLayer({
      ...common,
      id: "fires-glow",
      data: { ...base, attributes: { ...base.attributes, getFillColor: { value: w.glow, size: 4, normalized: true } } },
      radiusScale: 1.8,
    } as never),
    new ScatterplotLayer({
      ...common,
      id: "fires-core",
      data: { ...base, attributes: { ...base.attributes, getFillColor: { value: w.core, size: 4, normalized: true } } },
      radiusScale: 0.35,
      radiusMinPixels: 0.8,
      // the cores blend normally: additive cores turn a dense cluster into a white blob
      parameters: { depthWriteEnabled: false },
    } as never),
  ];
}
