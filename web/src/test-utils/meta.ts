import type { CityMeta, Meta, TagMeta } from "../api/types";

export const TEST_TAGS: TagMeta[] = [
  { id: "fire_punjab", kind: "fire", sector: null, region: "punjab", label: "Fires (satellite)", color: "#ff5a2b" },
  { id: "firefc_punjab", kind: "firefc", sector: null, region: "punjab", label: "Fires (satellite)", color: "#ff5a2b" },
  { id: "vehicles_delhi_ncr", kind: "sector", sector: "vehicles", region: "delhi_ncr", label: "Vehicles", color: "#6aa8ff" },
  { id: "industry_delhi_ncr", kind: "sector", sector: "industry", region: "delhi_ncr", label: "Industry and power", color: "#b98cff" },
  { id: "dust_delhi_ncr", kind: "sector", sector: "dust", region: "delhi_ncr", label: "Road and construction dust", color: "#e0b45a" },
  { id: "residential_delhi_ncr", kind: "sector", sector: "residential", region: "delhi_ncr", label: "Residential", color: "#5fd3c4" },
  { id: "vehicles_punjab", kind: "sector", sector: "vehicles", region: "punjab", label: "Vehicles", color: "#6aa8ff" },
];

function city(id: string, region: string, hours: number, base: number): CityMeta {
  const ramp = (k: number) => Array.from({ length: hours }, (_, h) => base * k + h);
  const flat = (v: number | null) => Array.from({ length: hours }, () => v);
  return {
    id, name: id, lat: 28, lon: 77, region,
    by_tag: { fire_punjab: ramp(1), vehicles_delhi_ncr: ramp(2), dust_delhi_ncr: ramp(0.5) },
    fire_age_h: flat(6),
    met: { wind_ms: flat(2), wind_dir_deg: flat(null), rh: flat(0.5), temp_c: flat(20), blh_m: flat(500) },
  };
}

export function makeMeta(over: Omit<Partial<Meta>, "hours"> & { hours?: number } = {}): Meta {
  const n = over.hours ?? 30;
  const { hours: _h, ...rest } = over;
  void _h;
  return {
    date: "2026-11-10", build_id: "b1", made_at: null,
    hours: Array.from({ length: n }, (_, h) => new Date(Date.UTC(2026, 10, 10, h)).toISOString()),
    forecast_from: null, fires_assumed_from: null, frame_semantics: "hour_mean_trapezoid",
    grid: { lon_min: 66, lat_min: 6, cell: 0.1, nx: 2, ny: 2 },
    tags: TEST_TAGS, cities: [city("delhi", "delhi_ncr", n, 10), city("ludhiana", "punjab", n, 20)],
    notes: {
      blh_estimated: false, dust_available: true, inventory_source: "test", inventory_year: 2020,
      fire_scaling_default: 1, step_stats: {}, city_area_km: 30, share_uncertainty_pp: { default: 10, delhi: 5 },
      min_date: "2018-04-01",
    },
    ...rest,
  };
}
