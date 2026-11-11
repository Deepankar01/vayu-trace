/**
 * Pure display formatting. Times are UTC internally and shown in IST (UTC+5:30, no DST).
 * Every number on screen is drawn with tabular numerals (CSS); these only make the strings.
 */

export const MINUS = "−";
export const DASH = "–";
const THIN = " ";
const IST_OFFSET_MS = 5.5 * 3600 * 1000;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

const ok = (x: number | null | undefined): x is number => x != null && Number.isFinite(x);

/** A share 0..1 as a whole percent; "–" for null, "<1%" for a positive share under 0.5 %. */
export function fmtShare(x: number | null): string {
  if (!ok(x)) return DASH;
  if (x > 0 && x < 0.005) return "<1%";
  return `${Math.round(x * 100)}%`;
}

/** Model relative to measured, signed whole percent ("+12%", "−3%", "0%"); "" when not computable. */
export function fmtError(sim: number | null, measured: number | null): string {
  if (!ok(sim) || !ok(measured) || measured <= 0) return "";
  const r = ((sim - measured) / measured) * 100;
  const p = Math.sign(r) * Math.round(Math.abs(r)); // half away from zero: -37.5 -> -38
  if (p > 0) return `+${p}%`;
  if (p < 0) return `${MINUS}${-p}%`;
  return "0%";
}

/** Number with thin-space thousands grouping and a true minus; "–" for missing. */
export function fmtNumber(x: number | null | undefined, digits = 0): string {
  if (!ok(x)) return DASH;
  const fixed = Math.abs(x).toFixed(digits);
  const [int, frac] = fixed.split(".");
  const grouped = int.replace(/\B(?=(\d{3})+(?!\d))/g, THIN);
  const neg = x < 0 && Number(fixed) !== 0;
  return `${neg ? MINUS : ""}${grouped}${frac ? `.${frac}` : ""}`;
}

/** The IST wall-clock fields of an instant. */
function ist(d: Date | string) {
  const t = (typeof d === "string" ? new Date(d) : d).getTime() + IST_OFFSET_MS;
  const z = new Date(t);
  return { y: z.getUTCFullYear(), mo: z.getUTCMonth(), d: z.getUTCDate(), h: z.getUTCHours(), mi: z.getUTCMinutes() };
}
const p2 = (n: number) => String(n).padStart(2, "0");

/** "07 Nov 2025 · 18:00 IST" */
export function fmtIST(d: Date | string): string {
  const t = ist(d);
  return `${p2(t.d)} ${MONTHS[t.mo]} ${t.y} · ${p2(t.h)}:${p2(t.mi)} IST`;
}

/** "18:00 IST" */
export function fmtISTHour(d: Date | string): string {
  const t = ist(d);
  return `${p2(t.h)}:${p2(t.mi)} IST`;
}

/** "07 Nov" */
export function fmtISTDay(d: Date | string): string {
  const t = ist(d);
  return `${p2(t.d)} ${MONTHS[t.mo]}`;
}

/** "07 Nov · 18:00" (compact, for the timeline and chart hover). */
export function fmtISTShort(d: Date | string): string {
  const t = ist(d);
  return `${p2(t.d)} ${MONTHS[t.mo]} · ${p2(t.h)}:${p2(t.mi)}`;
}

/** IST calendar date "YYYY-MM-DD". */
export function istDateKey(d: Date | string): string {
  const t = ist(d);
  return `${t.y}-${p2(t.mo + 1)}-${p2(t.d)}`;
}

const POINTS = ["N", "NNE", "NE", "ENE", "E", "ESE", "SE", "SSE", "S", "SSW", "SW", "WSW", "W", "WNW", "NW", "NNW"];

/** 16-point compass name of a direction in degrees (where the wind blows FROM); "Calm" for null. */
export function compass16(deg: number | null): string {
  if (!ok(deg)) return "Calm";
  const i = Math.round((((deg % 360) + 360) % 360) / 22.5) % 16;
  return POINTS[i];
}
