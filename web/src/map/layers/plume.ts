/**
 * The plume of the pollutant in view: turning a composed field into pixels, and the deck.gl layer that draws them.
 *
 * Geometry. Fields are 0.1 deg cells, row-major from the SOUTH-WEST corner. A BitmapLayer
 * stretches its image linearly between its bounds in Web Mercator, so an image with rows evenly
 * spaced in latitude would put mid-domain rows several tenths of a degree too far south. Rows are
 * therefore resampled (`resampleRowsToMercator`) to be evenly spaced in Mercator y before the
 * image is built; the image's row 0 is then the NORTH edge (`fieldToImageData` flips).
 *
 * Colour. `pm25`: the concentration ramp (the mode's name predates PM10; PM2.5, PM10 and coarse PM
 * all use this one ug/m3 scale, so switching pollutant compares like with like): colour and base
 * alpha from `pm25Ramp` of the DRY field; alpha scaled by `hazeOpacityFactor` of the haze ratio.
 * `aqi` / `aqi10`: CPCB category colour of the HOURLY value through `pm25ToAqi` / `pm10ToAqi`
 * (indicative: an hourly value on the 24-hour scale). There is no AQI for coarse PM alone. `diff`: composed minus baseline,
 * blue for reduction, red for increase, transparent within +/-2 ug/m3, saturating at +/-100.
 * Missing cells (NaN) are transparent in every mode.
 * A cell with missing HUMIDITY is drawn at dry opacity (humidity missing is not concentration
 * missing); a cell with missing CONCENTRATION is transparent.
 */
import { BitmapLayer } from "@deck.gl/layers";
import type { Texture } from "@luma.gl/core";
import { pm10ToAqi, pm25ToAqi } from "../../lib/aqi";
import { aqiColor, pm25Ramp } from "../../lib/colors";

export type PlumeMode = "pm25" | "aqi" | "aqi10" | "diff";
type LutMode = Exclude<PlumeMode, "diff">;

/** The run grid's edges [west, south, east, north] in degrees (from `meta.grid`). */
export function gridBounds(g: { lon_min: number; lat_min: number; cell: number; nx: number; ny: number }): [number, number, number, number] {
  return [g.lon_min, g.lat_min, g.lon_min + g.nx * g.cell, g.lat_min + g.ny * g.cell];
}

/**
 * Output rows after Mercator resampling (nearest source row per output row). The thinnest source
 * row (at 6 N) spans 1/354 of the domain's Mercator height, so more than 354 rows keeps every
 * row; 800 also bounds the placement error to half an output row (<= 2.4 km).
 */
export const PLUME_ROWS = 800;

export const DIFF_DEAD_BAND = 2;
export const DIFF_SATURATION = 100;
const DIFF_MAX_ALPHA = 200;
const DIFF_UP: [number, number, number] = [0xff, 0x5a, 0x5a]; // increase
const DIFF_DOWN: [number, number, number] = [0x6a, 0xa8, 0xff]; // reduction

const DEG = Math.PI / 180;

/** Web Mercator y (radians, unscaled) of a latitude in degrees. */
export function mercatorY(latDeg: number): number {
  return Math.log(Math.tan(Math.PI / 4 + (latDeg * DEG) / 2));
}

function latOfMercatorY(y: number): number {
  return (2 * Math.atan(Math.exp(y)) - Math.PI / 2) / DEG;
}

const rowMaps = new Map<string, Int32Array>();

/** For each output row (south first), the source row whose cell contains the row's centre. */
function mercatorRowMap(ny: number, latMin: number, latMax: number, outRows: number): Int32Array {
  const key = `${ny}|${latMin}|${latMax}|${outRows}`;
  let map = rowMaps.get(key);
  if (!map) {
    map = new Int32Array(outRows);
    const y0 = mercatorY(latMin);
    const dy = (mercatorY(latMax) - y0) / outRows;
    const cell = (latMax - latMin) / ny;
    for (let r = 0; r < outRows; r++) {
      const lat = latOfMercatorY(y0 + (r + 0.5) * dy);
      map[r] = Math.min(ny - 1, Math.max(0, Math.floor((lat - latMin) / cell)));
    }
    rowMaps.set(key, map);
  }
  return map;
}

/**
 * Resample a south-first field of `ny` rows evenly spaced in latitude to `outRows` rows evenly
 * spaced in Mercator y (still south first). Nearest row: each output row copies the source row
 * containing its centre latitude, so values (and NaN) are carried exactly, never blended; the
 * GPU's linear filtering smooths the image afterwards.
 */
export function resampleRowsToMercator(
  field: Float32Array, nx: number, ny: number, latMin: number, latMax: number, outRows: number,
  out: Float32Array = new Float32Array(nx * outRows),
): Float32Array {
  if (field.length !== nx * ny) throw new Error("field size does not match nx*ny");
  const map = mercatorRowMap(ny, latMin, latMax, outRows);
  for (let r = 0; r < outRows; r++) {
    const s = map[r] * nx;
    out.set(field.subarray(s, s + nx), r * nx);
  }
  return out;
}

/**
 * Opacity multiplier from the haze ratio (haze-weighted field / dry field, i.e. the hygroscopic
 * growth factor, >= 1). Rule: `0.6 + 0.4 * (clamp(ratio, 1, 2) - 1)`: dry air draws at 0.6 of
 * the ramp's alpha, a doubling or more by humidity at the full ramp alpha; monotonic, always in
 * [0.6, 1]. Missing humidity (NaN/null) counts as dry: the dry concentration is still known, so
 * the cell is drawn, just never denser than its dry value warrants.
 */
export function hazeOpacityFactor(ratio: number | null): number {
  if (ratio == null || !(ratio > 1)) return 0.6;
  return 0.6 + 0.4 * (Math.min(ratio, 2) - 1);
}

// --- colour lookup tables (value quantised to 0.25 ug/m3, 0..400) ---

const LUT_STEP = 4; // entries per ug/m3
const LUT_MAX = 400;
const LUT_N = LUT_MAX * LUT_STEP + 1;

function hexRgb(h: string): [number, number, number] {
  return [parseInt(h.slice(1, 3), 16), parseInt(h.slice(3, 5), 16), parseInt(h.slice(5, 7), 16)];
}

/** AQI-mode alpha: 0 at or below 5 ug/m3 like the ramp, rising continuously (no hard edge) and
 *  faster than the ramp so categories read, reaching 215 at 155 ug/m3. */
function aqiAlpha(v: number): number {
  if (!(v > 5)) return 0;
  return Math.round(215 * Math.min(1, (v - 5) / 150));
}

function buildLut(mode: LutMode): Uint8Array {
  const lut = new Uint8Array(LUT_N * 4);
  // transparent entries keep the lowest colour so linear texture filtering does not darken edges
  const low = mode === "pm25" ? pm25Ramp(5.01) : [...hexRgb(aqiColor(0)), 0];
  for (let k = 0; k < LUT_N; k++) {
    const v = k / LUT_STEP;
    let rgba: number[];
    if (mode === "pm25") rgba = pm25Ramp(v);
    else rgba = [...hexRgb(aqiColor(mode === "aqi" ? pm25ToAqi(v) : pm10ToAqi(v))), aqiAlpha(v)];
    if (rgba[3] === 0) rgba = [low[0], low[1], low[2], 0];
    lut.set(rgba, k * 4);
  }
  return lut;
}

const luts = new Map<LutMode, Uint8Array>();
function lutFor(mode: LutMode): Uint8Array {
  let lut = luts.get(mode);
  if (!lut) luts.set(mode, (lut = buildLut(mode)));
  return lut;
}

/**
 * Colourise `a*(1-t) + b*t` (b may be null: just `a`) into `out` (RGBA, `nx*ny*4`), flipping rows
 * so row 0 of the image is the northern-most. `hazeA/hazeB` (same blend) scale the alpha in
 * pm25 and aqi/aqi10 modes; a missing side counts as dry (ratio 1), both missing gives factor 0.6.
 * NaN at either end is transparent. No allocation: call it every animation frame with `out`.
 */
export function colorizeInto(
  out: Uint8ClampedArray, nx: number, ny: number, mode: PlumeMode,
  a: Float32Array, b: Float32Array | null, t: number,
  hazeA: Float32Array | null, hazeB: Float32Array | null,
): void {
  const n = nx * ny;
  if (out.length !== n * 4 || a.length !== n || (b && b.length !== n)) throw new Error("size mismatch");
  const bb = b ?? a;
  const s = b ? 1 - t : 1;
  const tt = b ? t : 0;
  const hA = hazeA;
  const hB = b ? hazeB : null; // never borrow the other frame's humidity
  const anyHaze = hA !== null || hB !== null;
  const lut = mode === "diff" ? null : lutFor(mode);
  for (let row = 0; row < ny; row++) {
    const src = row * nx;
    const dst = (ny - 1 - row) * nx * 4;
    for (let i = 0; i < nx; i++) {
      const k = src + i;
      const v = a[k] * s + bb[k] * tt;
      const o = dst + i * 4;
      if (Number.isNaN(v)) {
        out[o] = out[o + 1] = out[o + 2] = out[o + 3] = 0;
        continue;
      }
      if (lut) {
        const q = v >= LUT_MAX ? LUT_N - 1 : v > 0 ? (v * LUT_STEP + 0.5) | 0 : 0;
        const l = q * 4;
        out[o] = lut[l];
        out[o + 1] = lut[l + 1];
        out[o + 2] = lut[l + 2];
        const ratio = anyHaze ? (hA ? hA[k] : 1) * s + (hB ? hB[k] : 1) * tt : NaN;
        out[o + 3] = lut[l + 3] * hazeOpacityFactor(ratio);
      } else {
        const c = v < 0 ? DIFF_DOWN : DIFF_UP;
        out[o] = c[0];
        out[o + 1] = c[1];
        out[o + 2] = c[2];
        const m = Math.min(Math.abs(v), DIFF_SATURATION);
        out[o + 3] = m <= DIFF_DEAD_BAND ? 0 : (DIFF_MAX_ALPHA * (m - DIFF_DEAD_BAND)) / (DIFF_SATURATION - DIFF_DEAD_BAND);
      }
    }
  }
}

/** ImageData where the platform has it (browsers), else a structurally identical object (jsdom). */
export function makeImageData(data: Uint8ClampedArray<ArrayBuffer>, width: number, height: number): ImageData {
  if (typeof ImageData !== "undefined") return new ImageData(data, width, height);
  return { data, width, height, colorSpace: "srgb" } as ImageData;
}

/**
 * A field (south-first rows) as an RGBA image with north up. `opts.haze` is the haze ratio field
 * (see `hazeOpacityFactor`); without it the dry factor applies.
 */
export function fieldToImageData(
  field: Float32Array, nx: number, ny: number, mode: PlumeMode, opts: { haze?: Float32Array | null } = {},
): ImageData {
  const data = new Uint8ClampedArray(nx * ny * 4);
  colorizeInto(data, nx, ny, mode, field, null, 0, opts.haze ?? null, null);
  return makeImageData(data, nx, ny);
}

/**
 * The plume layer. `image` is the app-owned texture (updated in place every frame; `version`
 * changes so deck.gl redraws) or, before the GPU device is known, an ImageData.
 */
export function plumeLayer(
  image: Texture | ImageData, version: number, beforeId: string | undefined,
  bounds: [number, number, number, number],
) {
  return new BitmapLayer({
    id: "plume",
    image,
    bounds,
    beforeId,
    // linear filtering: cells blend instead of looking blocky
    textureParameters: { minFilter: "linear", magFilter: "linear", mipmapFilter: "none" },
    pickable: false,
    // unknown to BitmapLayer; a change marks the layer for redraw after an in-place texture write
    version,
  } as ConstructorParameters<typeof BitmapLayer>[0] & { beforeId?: string; version: number });
}
