import type { CityMeta, Meta, TagMeta } from "../api/types";

const FINE_TAGS: TagMeta[] = [
  { id: "fire_punjab", kind: "fire", sector: null, region: "punjab", label: "Fires (satellite)", color: "#ff5a2b", size: "fine" },
  { id: "firefc_punjab", kind: "firefc", sector: null, region: "punjab", label: "Fires (satellite)", color: "#ff5a2b", size: "fine" },
  { id: "vehicles_delhi_ncr", kind: "sector", sector: "vehicles", region: "delhi_ncr", label: "Vehicles", color: "#6aa8ff", size: "fine" },
  { id: "industry_delhi_ncr", kind: "sector", sector: "industry", region: "delhi_ncr", label: "Industry and power", color: "#b98cff", size: "fine" },
  { id: "dust_delhi_ncr", kind: "sector", sector: "dust", region: "delhi_ncr", label: "Road and construction dust", color: "#e0b45a", size: "fine" },
  { id: "residential_delhi_ncr", kind: "sector", sector: "residential", region: "delhi_ncr", label: "Residential", color: "#5fd3c4", size: "fine" },
  { id: "vehicles_punjab", kind: "sector", sector: "vehicles", region: "punjab", label: "Vehicles", color: "#6aa8ff", size: "fine" },
];
/** As the server lists them: every fine tag, then its coarse twin (`coarse_` + id). */
export const TEST_TAGS: TagMeta[] = [
  ...FINE_TAGS,
  ...FINE_TAGS.map((t): TagMeta => ({ ...t, id: `coarse_${t.id}`, size: "coarse" })),
];

function city(id: string, region: string, hours: number, base: number): CityMeta {
  const ramp = (k: number) => Array.from({ length: hours }, (_, h) => base * k + h);
  const flat = (v: number | null) => Array.from({ length: hours }, () => v);
  return {
    id, name: id, lat: 28, lon: 77, region,
    // fine tags as before PM10 existed, plus one coarse tag (2.5-10 um) of constant 8 ug/m3
    by_tag: { fire_punjab: ramp(1), vehicles_delhi_ncr: ramp(2), dust_delhi_ncr: ramp(0.5), coarse_dust_delhi_ncr: flat(8) as number[] },
    // the part made inside the city's own square: only a Delhi NCR city has Delhi NCR emissions
    by_tag_local: region === "delhi_ncr" ? { vehicles_delhi_ncr: ramp(1), coarse_dust_delhi_ncr: flat(6) as number[] } : {},
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
      blh_estimated: false, dust_available: true, dust_estimated: true,
      dust_source: "Estimate: national road dust and construction totals, spread by road-transport emissions",
      v_dep_fine_m_s: 0.002, v_dep_coarse_m_s: 0.01, inventory_source: "test", inventory_year: 2020,
      fire_scaling_default: 1, step_stats: {}, city_area_km: 30, share_uncertainty_pp: { default: 15, delhi: 5 },
      min_date: "2018-04-01",
    },
    ...rest,
  };
}
