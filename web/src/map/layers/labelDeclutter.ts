/**
 * Screen-space label declutter: greedy by priority, a label is shown only if its box overlaps no
 * box already accepted. Boxes depend on the city name and the camera only: the status line is
 * always sized for the WIDEST text it can show (`WORST_STATUS`), so a label accepted while its
 * status is short ("model AQI 120") still fits when "smoke present · N h old" appears during playback,
 * and the result does not flicker (it is recomputed on map move/resize only).
 */

export interface LabelBox {
  id: string;
  /** Marker position in screen pixels. */
  x: number;
  y: number;
  name: string;
  /** Lower is more important. */
  priority: number;
}

/** Label geometry, matching `cityLayers` (11 px name above, 10 px status below, 11 px right). */
const OFFSET_X = 11;
const NAME_CHAR_W = 6.4;
/** The longest status line `statusLine` can draw (AQI is capped at 500; ages stay under 1000 h). */
export const WORST_STATUS = "model AQI 500 · smoke present · 999 h old";
/** Average advance of the 10 px status font (system sans), px per character; slightly generous. */
const STATUS_CHAR_W = 5.5;
export const STATUS_W = Math.ceil(WORST_STATUS.length * STATUS_CHAR_W); // 41 chars -> 226 px
const ABOVE = 14;
const BELOW = 14;
const PAD = 2;

export function labelRect(b: LabelBox): [number, number, number, number] {
  const w = Math.max(b.name.length * NAME_CHAR_W, STATUS_W);
  return [b.x + OFFSET_X - PAD, b.y - ABOVE - PAD, b.x + OFFSET_X + w + PAD, b.y + BELOW + PAD];
}

const overlaps = (a: number[], b: number[]) => a[0] < b[2] && b[0] < a[2] && a[1] < b[3] && b[1] < a[3];

/** Ids of the labels to show. Ties in priority keep the input order. */
export function declutterLabels(boxes: readonly LabelBox[]): Set<string> {
  const order = boxes.map((b, i) => ({ b, i })).sort((p, q) => p.b.priority - q.b.priority || p.i - q.i);
  const kept: number[][] = [];
  const shown = new Set<string>();
  for (const { b } of order) {
    if (!Number.isFinite(b.x) || !Number.isFinite(b.y)) continue;
    const r = labelRect(b);
    if (kept.some((k) => overlaps(k, r))) continue;
    kept.push(r);
    shown.add(b.id);
  }
  return shown;
}
