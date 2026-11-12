/** The emission-tag catalogue; a port of the tag part of server/vayu/domain.py (tested against it). */

export const REGIONS = ["delhi_ncr", "punjab", "haryana", "uttar_pradesh", "bihar", "rest_of_india"] as const;
export const SECTORS = ["vehicles", "industry", "dust", "residential"] as const;
export const FIRE_STATES = ["punjab", "haryana", "uttar_pradesh", "madhya_pradesh", "other"] as const;

/** Coarse twins (the 2.5-10 um part of PM10) are named `coarse_` + the fine tag id. */
export const COARSE_PREFIX = "coarse_";

export interface CatalogueTag {
  id: string;
  kind: "fire" | "firefc" | "sector";
  sector: string | null;
  region: string;
  label: string;
  color: string;
  /** "fine": PM2.5. "coarse": the 2.5-10 um part of PM10. */
  size: "fine" | "coarse";
}

const SECTOR_LABELS: Record<string, string> = {
  vehicles: "Vehicles",
  industry: "Industry and power",
  dust: "Road and construction dust",
  residential: "Residential",
};
const COLORS: Record<string, string> = {
  fire: "#ff5a2b",
  vehicles: "#6aa8ff",
  industry: "#b98cff",
  dust: "#e0b45a",
  residential: "#5fd3c4",
};

export const REGION_NAMES: Record<string, string> = {
  delhi_ncr: "Delhi NCR",
  punjab: "Punjab",
  haryana: "Haryana",
  uttar_pradesh: "Uttar Pradesh",
  bihar: "Bihar",
  rest_of_india: "Rest of India",
};
export const FIRE_STATE_NAMES: Record<string, string> = {
  punjab: "Punjab",
  haryana: "Haryana",
  uttar_pradesh: "Uttar Pradesh",
  madhya_pradesh: "Madhya Pradesh",
  other: "other states and neighbouring countries",
};

export const FIRE_LABEL = "Fires (satellite)";
export const USER_COLOR = "#9aa3b5";
export const UNEXPLAINED_COLOR = "#5b6475";
export const DEFAULT_USER_LABEL = "Added source";

function buildTags(): CatalogueTag[] {
  const tags: CatalogueTag[] = [];
  for (const s of FIRE_STATES) tags.push({ id: `fire_${s}`, kind: "fire", sector: null, region: s, label: FIRE_LABEL, color: COLORS.fire, size: "fine" });
  for (const s of FIRE_STATES) tags.push({ id: `firefc_${s}`, kind: "firefc", sector: null, region: s, label: FIRE_LABEL, color: COLORS.fire, size: "fine" });
  for (const sec of SECTORS)
    for (const reg of REGIONS)
      tags.push({ id: `${sec}_${reg}`, kind: "sector", sector: sec, region: reg, label: SECTOR_LABELS[sec], color: COLORS[sec], size: "fine" });
  // coarse twins come after every fine tag (as in domain.py), so fine tag indices never change
  for (const t of [...tags]) tags.push({ ...t, id: COARSE_PREFIX + t.id, size: "coarse" });
  return tags;
}

export const TAGS: readonly CatalogueTag[] = buildTags();
export const TAG_BY_ID: ReadonlyMap<string, CatalogueTag> = new Map(TAGS.map((t) => [t.id, t]));
export const SECTOR_LABEL: Readonly<Record<string, string>> = SECTOR_LABELS;
