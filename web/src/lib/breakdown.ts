/**
 * Port of `breakdown` and `arrival` from server/vayu/receptors.py (the reference implementation).
 *
 * Agreement contract: results match Python within 1e-9 relative (strings, booleans and row order
 * exactly). To keep it, every sum iterates tags in SORTED tag-id order with an explicit
 * left-to-right `+=`, and ties are broken by `key` with plain code-unit comparison (keys are
 * ASCII), never by locale.
 */
import {
  DEFAULT_USER_LABEL, FIRE_STATE_NAMES, REGION_NAMES, SECTOR_LABEL, TAG_BY_ID, TAGS,
  UNEXPLAINED_COLOR, USER_COLOR,
} from "./tags";

export const SHARE_MINOR = 0.05; // hourly shares carry about +/-5 percentage points of uncertainty
export const FIRE_ARRIVAL_UGM3 = 15.0;

export type RowKind = "fire" | "local" | "transported" | "user" | "unexplained";

export interface BreakdownRow {
  /** Stable id, e.g. fire:punjab, local:vehicles, transported:vehicles:punjab. */
  key: string;
  label: string;
  kind: RowKind;
  sector: string | null;
  /** ug/m3 */
  value: number;
  /** 0..1 of the denominator; null when the denominator is 0. */
  share: number | null;
  /** Share below SHARE_MINOR: the UI folds these together. */
  minor: boolean;
  color: string;
}

const FIRE_KINDS = ["fire", "firefc"];

/** Catalogue tag, or null for a user tag (`user_*`). Anything else is an error. */
function lookup(tagId: string) {
  if (tagId.startsWith("user_")) return null;
  const tag = TAG_BY_ID.get(tagId);
  if (!tag) {
    throw new Error(`unknown source tag '${tagId}'; the stored run predates the current tag catalogue`);
  }
  return tag;
}

const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/**
 * Where a city's PM2.5 came from at one hour. Same semantics as the Python docstring:
 * effective value = `byTagNow[tag] * (weights[tag] ?? 1)`; null/NaN values are skipped and if
 * every tag is skipped the result is []. Fire (observed) and fire-persistence tags of one state
 * form one row; sector tags in `cityRegion` are "Local ...", the others "Transported ... - Region";
 * `user_*` tags get one row each (label from `labels`). Shares are of max(measured, simulated
 * total) when `measured` is finite, else of the simulated total (null if that is 0). A
 * "Not explained by model" row is added only when `measured` is finite and exceeds the total.
 * Rows of value exactly 0 are omitted. Order: fire, local, transported, user (each by value
 * descending, ties by key), then unexplained. Nothing is rounded. A tag that is neither in the
 * catalogue nor `user_*` throws.
 */
export function breakdown(
  byTagNow: Readonly<Record<string, number | null>>,
  weights: Readonly<Record<string, number>>,
  cityRegion: string,
  measured: number | null | undefined,
  labels: Readonly<Record<string, string>> = {},
): BreakdownRow[] {
  const eff = new Map<string, number>();
  for (const tagId of Object.keys(byTagNow).sort(cmp)) {
    lookup(tagId);
    const v = byTagNow[tagId];
    if (v == null || !Number.isFinite(v)) continue;
    eff.set(tagId, v * (weights[tagId] ?? 1.0));
  }
  if (eff.size === 0) return [];
  let total = 0.0;
  for (const v of eff.values()) total += v;
  const haveMeasured = measured != null && Number.isFinite(measured);
  const denom = haveMeasured ? Math.max(measured, total) : total;

  const row = (key: string, label: string, kind: RowKind, sector: string | null, value: number, color: string): BreakdownRow => {
    const share = denom === 0 ? null : value / denom;
    const minor = share !== null && share < SHARE_MINOR && kind !== "unexplained";
    return { key, label, kind, sector, value, share, minor, color };
  };

  const groups: Record<"fire" | "local" | "transported" | "user", BreakdownRow[]> = {
    fire: [], local: [], transported: [], user: [],
  };
  const fireSum = new Map<string, number>();
  for (const [tagId, v] of eff) {
    // sorted tag-id order
    const tag = lookup(tagId);
    if (tag === null) {
      groups.user.push(row(`user:${tagId}`, labels[tagId] ?? DEFAULT_USER_LABEL, "user", null, v, USER_COLOR));
    } else if (FIRE_KINDS.includes(tag.kind)) {
      fireSum.set(tag.region, (fireSum.get(tag.region) ?? 0.0) + v);
    } else if (tag.region === cityRegion) {
      const name = SECTOR_LABEL[tag.sector!].toLowerCase();
      groups.local.push(row(`local:${tag.sector}`, `Local ${name}`, "local", tag.sector, v, tag.color));
    } else {
      const name = SECTOR_LABEL[tag.sector!].toLowerCase();
      groups.transported.push(
        row(`transported:${tag.sector}:${tag.region}`, `Transported ${name} — ${REGION_NAMES[tag.region]}`,
          "transported", tag.sector, v, tag.color),
      );
    }
  }
  const fireColor = TAGS.find((t) => t.kind === "fire")!.color;
  for (const [state, v] of fireSum) {
    groups.fire.push(row(`fire:${state}`, `Fires (satellite) — ${FIRE_STATE_NAMES[state]}`, "fire", null, v, fireColor));
  }

  const rows: BreakdownRow[] = [];
  for (const kind of ["fire", "local", "transported", "user"] as const) {
    rows.push(
      ...groups[kind]
        .filter((r) => r.value !== 0)
        .sort((a, b) => (a.value !== b.value ? (-a.value < -b.value ? -1 : 1) : cmp(a.key, b.key))),
    );
  }
  if (haveMeasured && measured > total) {
    rows.push(row("unexplained", "Not explained by model", "unexplained", null, measured - total, UNEXPLAINED_COLOR));
  }
  return rows;
}

export type ArrivalLabel =
  | { kind: "present"; age_h: number | null }
  | { kind: "arrives"; in_h: number }
  | { kind: "none" };

/**
 * Smoke status at `hour` from the city's total fire contribution per hour (after weights):
 * "present" (with the caller's `ageH`, null if NaN) if the value at `hour` is at or above
 * 15 ug/m3; "arrives" with `in_h` hours to the first later hour at or above it; else "none".
 * Null/NaN count as below the threshold; earlier hours are ignored. `hour` outside the series
 * throws a RangeError (Python: IndexError).
 */
export function arrival(fireSeries: readonly (number | null)[], hour: number, ageH: number | null = null): ArrivalLabel {
  if (!(hour >= 0 && hour < fireSeries.length)) {
    throw new RangeError(`hour ${hour} outside 0..${fireSeries.length - 1}`);
  }
  const age = ageH == null || !Number.isFinite(ageH) ? null : ageH;
  const hit = (i: number) => {
    const v = fireSeries[i];
    return v != null && Number.isFinite(v) && v >= FIRE_ARRIVAL_UGM3;
  };
  if (hit(hour)) return { kind: "present", age_h: age };
  for (let i = hour + 1; i < fireSeries.length; i++) {
    if (hit(i)) return { kind: "arrives", in_h: i - hour };
  }
  return { kind: "none" };
}

/**
 * True when the breakdown at this hour is incomplete: some tag with a non-zero weight (missing
 * weights default to 1.0, as in `breakdown`) is null/NaN, so `breakdown` skips it and its rows
 * and totals under-count. The UI marks such a breakdown as incomplete.
 */
export function breakdownIncomplete(
  byTagNow: Readonly<Record<string, number | null>>,
  weights: Readonly<Record<string, number>>,
): boolean {
  return Object.keys(byTagNow).some((id) => {
    const v = byTagNow[id];
    return (v == null || !Number.isFinite(v)) && (weights[id] ?? 1.0) !== 0;
  });
}
