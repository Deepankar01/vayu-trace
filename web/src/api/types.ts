/** Shapes of the HTTP API (see server/vayu/api.py). JSON never carries NaN: missing is null. */

export type TagKind = "fire" | "firefc" | "sector" | "user";
export type Sector = "vehicles" | "industry" | "dust" | "residential";

export interface TagMeta {
  id: string;
  kind: TagKind;
  sector: string | null;
  region: string | null;
  label: string;
  color: string;
}

/** Hourly series for the city. `wind_dir_deg` null means calm; `rh` is a FRACTION 0..1. */
export interface CityMet {
  wind_ms: (number | null)[];
  wind_dir_deg: (number | null)[];
  rh: (number | null)[];
  temp_c: (number | null)[];
  blh_m: (number | null)[];
}

export interface CityMeta {
  id: string;
  name: string;
  lat: number;
  lon: number;
  region: string;
  /** Dry PM2.5 (ug/m3) per tag and hour. Tags that are zero all run long are absent (= zeros). */
  by_tag: Record<string, (number | null)[]>;
  fire_age_h: (number | null)[];
  met: CityMet;
}

export interface MetaNotes {
  blh_estimated: boolean;
  dust_available: boolean;
  inventory_source: string;
  inventory_year: number | null;
  fire_scaling_default: number;
  step_stats: unknown;
  city_area_km: number;
  share_uncertainty_pp: { default: number; delhi: number };
  min_date: string;
}

export interface Meta {
  date: string;
  build_id: string;
  made_at: string | null;
  /** ISO start instant of each output hour (UTC). */
  hours: string[];
  /** First hour index later than "now", or null. */
  forecast_from: number | null;
  /** First hour index whose fire emissions are assumed by persistence, or null. */
  fires_assumed_from: number | null;
  frame_semantics: string;
  grid: { lon_min: number; lat_min: number; cell: number; nx: number; ny: number };
  tags: TagMeta[];
  cities: CityMeta[];
  notes: MetaNotes;
}

export type RunState = "running" | "ready" | "error";

export interface RunStatus {
  status: RunState;
  progress: number;
  stage: string;
  error: string | null;
}

export interface PostRunResponse {
  run_id: string;
  /** Present (and "ready") only on the 200 reply for an already built date. */
  status?: "ready";
}

/** [lon, lat, frp_mw, hour_index] */
export type Fire = [number, number, number, number];

export interface WindField {
  step: number;
  lon0: number;
  lat0: number;
  nx: number;
  ny: number;
  u: (number | null)[];
  v: (number | null)[];
}

export interface MeasuredResponse {
  values: (number | null)[];
  station_count: number;
  live: number | null;
  live_error: string | null;
  source: string;
  aligned: string;
}

export interface CamsResponse {
  values: (number | null)[];
}

export interface SourceRequest {
  kind: string;
  lon: number;
  lat: number;
  amount: number;
  start_hour: number;
  duration_h: number;
}

export interface SourceResponse {
  tag: { id: string; label: string; color: string };
  by_city: Record<string, (number | null)[]>;
  build_id: string;
}
