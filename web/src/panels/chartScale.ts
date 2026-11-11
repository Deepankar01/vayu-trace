/** Pure scale and path helpers for the small SVG chart in the city panel (no chart library). */
import { fmtISTDay } from "../lib/format";

export type Point = [index: number, value: number];

/** Linear map from [d0, d1] to [r0, r1]; a zero-width domain maps everything to r0. */
export function linear(d0: number, d1: number, r0: number, r1: number): (v: number) => number {
  const span = d1 - d0;
  if (span === 0) return () => r0;
  const k = (r1 - r0) / span;
  return (v) => r0 + (v - d0) * k;
}

const ok = (v: number | null | undefined): v is number => v != null && Number.isFinite(v);

/** Largest finite value across several series (0 if none). */
export function seriesMax(series: readonly (readonly (number | null)[] | null)[]): number {
  let m = 0;
  for (const s of series) if (s) for (const v of s) if (ok(v) && v > m) m = v;
  return m;
}

/**
 * Y domain top (10 % headroom over `max`) and 1–3 round ticks above zero (steps of 1, 2, 2.5
 * or 5 times a power of ten; the smallest step that gives at most three).
 */
export function yTicks(max: number): { ticks: number[]; top: number } {
  const top = Number(((max > 0 ? max : 10) * 1.1).toPrecision(6));
  const mag = 10 ** Math.floor(Math.log10(top / 3));
  let step = mag;
  for (const f of [0.5, 1, 2, 2.5, 5, 10, 20]) {
    step = f * mag;
    if (Math.floor(top / step) <= 3) break;
  }
  const ticks: number[] = [];
  for (let v = step; v <= top + 1e-9; v += step) ticks.push(Number(v.toPrecision(6)));
  return { ticks, top };
}

/** Runs of consecutive non-missing values with index in [from, to], as [index, value] points. */
export function runs(values: readonly (number | null)[], from: number, to: number): Point[][] {
  const out: Point[][] = [];
  let cur: Point[] = [];
  for (let i = Math.max(0, from); i <= to && i < values.length; i++) {
    const v = values[i];
    if (ok(v)) cur.push([i, v]);
    else if (cur.length) {
      out.push(cur);
      cur = [];
    }
  }
  if (cur.length) out.push(cur);
  return out;
}

/** SVG path data through the points. */
export function pathD(points: readonly Point[], x: (i: number) => number, y: (v: number) => number): string {
  const r = (n: number) => Math.round(n * 10) / 10;
  return points.map(([i, v], k) => `${k === 0 ? "M" : "L"}${r(x(i))},${r(y(v))}`).join("");
}

/** The whole hour nearest to `px` on a plot `width` wide showing hours 0..n-1. */
export function hourFromX(px: number, width: number, n: number): number {
  if (n <= 1 || width <= 0) return 0;
  return Math.min(n - 1, Math.max(0, Math.round((px / width) * (n - 1))));
}

const IST_MS = 5.5 * 3600e3;
const HOUR_MS = 3600e3;

/**
 * IST midnights inside the window as fractional hour positions (hours[i] is the UTC instant of
 * index i; IST midnight is UTC 18:30, so it falls half-way between two indices) with "07 Nov".
 */
export function istDayStarts(hours: readonly string[]): { pos: number; label: string }[] {
  if (hours.length === 0) return [];
  const t0 = new Date(hours[0]).getTime();
  const tEnd = new Date(hours[hours.length - 1]).getTime();
  const day = 24 * HOUR_MS;
  let m = Math.ceil((t0 + IST_MS) / day) * day - IST_MS; // first IST midnight at or after t0
  const out: { pos: number; label: string }[] = [];
  for (; m <= tEnd; m += day) {
    out.push({ pos: (m - t0) / HOUR_MS, label: fmtISTDay(new Date(m)) });
  }
  return out;
}
