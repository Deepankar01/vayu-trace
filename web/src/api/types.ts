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
  /** "fine": PM2.5. "coarse": the 2.5-10 um part of PM10 (id = "coarse_" + the fine tag's id,
   *  same kind/sector/region). User sources are fine. */
  size: "fine" | "coarse";
  /** User sources only: where and when it was placed (stored by the server, restored on reload). */
  source?: SourceRequest;
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
  /** Dry concentration (ug/m3) per tag and hour: PM2.5 for fine tags, 2.5-10 um mass for coarse
   *  tags. Tags that are zero all run long are absent (= zeros). */
  by_tag: Record<string, (number | null)[]>;
  /** The part of `by_tag[tag]` emitted inside the city's own ~30 km square. Absent tag = zeros. */
  by_tag_local: Record<string, (number | null)[]>;
  fire_age_h: (number | null)[];
  met: CityMet;
}

export interface MetaNotes {
  blh_estimated: boolean;
  dust_available: boolean;
  /** The dust sector is an estimate (national totals spread by a proxy), not gridded data. */
  dust_estimated: boolean;
  /** One sentence saying where the dust estimate comes from. */
  dust_source: string;
  /** Dry deposition velocities the model uses for fine and coarse particles (m/s). */
  v_dep_fine_m_s: number;
  v_dep_coarse_m_s: number;
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

/** What the measured and CAMS endpoints can serve (`?pollutant=`; pm25 is the default). */
export type DataPollutant = "pm25" | "pm10";

export interface MeasuredResponse {
  pollutant?: DataPollutant;
  values: (number | null)[];
  station_count: number;
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
