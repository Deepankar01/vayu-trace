import type { Meta } from "../api/types";

/**
 * Where the playhead starts for a freshly loaded run: the evening of the run's date (13:00 UTC,
 * 18:30 IST, when the night build-up begins and the 24-hour mean is available), or the last
 * observed hour of a forecast run if that comes first, or the last hour of a shorter window.
 */
export function initialHour(meta: Pick<Meta, "date" | "hours" | "forecast_from">): number {
  const target = Date.parse(`${meta.date}T13:00:00Z`);
  let h = meta.hours.findIndex((t) => Date.parse(t) === target);
  if (h < 0) h = meta.hours.length - 1;
  if (meta.forecast_from !== null && meta.forecast_from > 0) h = Math.min(h, meta.forecast_from - 1);
  return Math.max(0, h);
}
