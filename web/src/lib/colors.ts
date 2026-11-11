export type Rgba = [number, number, number, number];

export const TAG_COLORS = {
  fires: "#ff5a2b",
  vehicles: "#6aa8ff",
  industry: "#b98cff",
  dust: "#e0b45a",
  residential: "#5fd3c4",
  unexplained: "#5b6475",
  user: "#9aa3b5",
} as const;

const MUTE = "#8b93a5";

// PM2.5 (ug/m3) colour stops: pale amber -> orange -> red-orange -> deep red -> maroon.
const STOPS: { v: number; rgb: [number, number, number] }[] = [
  { v: 5, rgb: [0xff, 0xd9, 0xa8] },
  { v: 60, rgb: [0xff, 0x8a, 0x3d] },
  { v: 120, rgb: [0xff, 0x5a, 0x2b] },
  { v: 250, rgb: [0xb3, 0x20, 0x2a] },
  { v: 400, rgb: [0x5a, 0x0f, 0x1c] },
];
const MAX_ALPHA = 215;

/** Colour for a dry PM2.5 concentration; fully transparent at or below 5 ug/m3. Alpha rises as
 *  the square root of (v - 5) / 395, from 0 to 215 at 400. */
export function pm25Ramp(v: number): Rgba {
  if (!(v > 5)) return [0, 0, 0, 0];
  const t = Math.min(v, 400);
  // square-root curve: typical 40-150 ug/m3 plumes read clearly; still 0 at 5 and 215 at 400+
  const alpha = Math.round(MAX_ALPHA * Math.sqrt(Math.min(1, Math.max(0, (t - 5) / 395))));
  let i = 0;
  while (i < STOPS.length - 2 && t > STOPS[i + 1].v) i++;
  const a = STOPS[i];
  const b = STOPS[i + 1];
  const f = (t - a.v) / (b.v - a.v);
  const c = a.rgb.map((x, k) => Math.round(x + (b.rgb[k] - x) * f));
  return [c[0], c[1], c[2], alpha];
}

const AQI_BANDS: { max: number; color: string }[] = [
  { max: 50, color: "#5fd38d" }, // Good
  { max: 100, color: "#b6d96a" }, // Satisfactory
  { max: 200, color: "#f2d15c" }, // Moderate
  { max: 300, color: "#ff8a3d" }, // Poor
  { max: 400, color: "#ff5a5a" }, // Very Poor
  { max: Infinity, color: "#b3202a" }, // Severe
];

/**
 * CPCB category colour for an AQI value. AQI arrives as a float, so it is rounded to the nearest
 * integer first and then banded (50.4 -> Good, 50.5 -> Satisfactory). Missing, NaN or negative
 * values are invalid and return the mute grey; Infinity is Severe.
 */
export function aqiColor(aqi: number | null | undefined): string {
  if (aqi == null || Number.isNaN(aqi) || aqi < 0) return MUTE;
  const rounded = Math.round(aqi);
  return AQI_BANDS.find((b) => rounded <= b.max)!.color;
}
