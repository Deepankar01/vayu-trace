/** CPCB PM2.5- and PM10-based AQI (24 h averaging); a port of server/vayu/aqi.py. */

// CPCB National AQI (2014) PM2.5 24-hour breakpoints, linear inside each band, capped at 500.
const PM_NODES = [0, 30, 60, 90, 120, 250, 380];
// Same table, PM10 24-hour breakpoints.
const PM10_NODES = [0, 50, 100, 250, 350, 430, 510];
const AQI_NODES = [0, 50, 100, 200, 300, 400, 500];

/** Piecewise-linear lookup like numpy.interp (clamped at both ends; NaN in, NaN out). */
function interp(v: number, nodes: readonly number[]): number {
  if (Number.isNaN(v)) return NaN;
  const last = nodes.length - 1;
  if (v <= nodes[0]) return AQI_NODES[0];
  if (v >= nodes[last]) return AQI_NODES[last];
  let j = 0;
  while (v >= nodes[j + 1]) j++;
  const slope = (AQI_NODES[j + 1] - AQI_NODES[j]) / (nodes[j + 1] - nodes[j]);
  return slope * (v - nodes[j]) + AQI_NODES[j];
}

/** PM2.5 24 h mean (ug/m3) to a float AQI. */
export function pm25ToAqi(v: number): number {
  return interp(v, PM_NODES);
}

/** PM10 24 h mean (ug/m3) to a float AQI. */
export function pm10ToAqi(v: number): number {
  return interp(v, PM10_NODES);
}

export const ROLLING_WINDOW_H = 24;
export const ROLLING_MIN_VALUES = 16;

/**
 * Mean of the non-null values among the 24 hours ending at index `i` inclusive (`i-23..i`,
 * clipped at 0); null if fewer than 16 are available. The AQI shown is `pm25ToAqi` (or `pm10ToAqi`) of this.
 */
export function rolling24h(series: readonly (number | null)[], i: number): number | null {
  let n = 0;
  let sum = 0;
  for (let k = Math.max(0, i - ROLLING_WINDOW_H + 1); k <= i && k < series.length; k++) {
    const v = series[k];
    if (v != null && Number.isFinite(v)) {
      sum += v;
      n++;
    }
  }
  return n < ROLLING_MIN_VALUES ? null : sum / n;
}
