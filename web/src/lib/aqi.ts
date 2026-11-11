/** CPCB PM2.5-based AQI (24 h averaging); a port of server/vayu/aqi.py. */

// CPCB National AQI (2014) PM2.5 24-hour breakpoints, linear inside each band, capped at 500.
const PM_NODES = [0, 30, 60, 90, 120, 250, 380];
const AQI_NODES = [0, 50, 100, 200, 300, 400, 500];

/** PM2.5 24 h mean (ug/m3) to a float AQI, like numpy.interp (clamped at both ends; NaN in, NaN out). */
export function pm25ToAqi(v: number): number {
  if (Number.isNaN(v)) return NaN;
  const last = PM_NODES.length - 1;
  if (v <= PM_NODES[0]) return AQI_NODES[0];
  if (v >= PM_NODES[last]) return AQI_NODES[last];
  let j = 0;
  while (v >= PM_NODES[j + 1]) j++;
  const slope = (AQI_NODES[j + 1] - AQI_NODES[j]) / (PM_NODES[j + 1] - PM_NODES[j]);
  return slope * (v - PM_NODES[j]) + AQI_NODES[j];
}

export const ROLLING_WINDOW_H = 24;
export const ROLLING_MIN_VALUES = 16;

/**
 * Mean of the non-null values among the 24 hours ending at index `i` inclusive (`i-23..i`,
 * clipped at 0); null if fewer than 16 are available. The AQI shown is `pm25ToAqi` of this.
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
