/**
 * Screen-space label declutter: greedy by priority, a label is shown only if its box overlaps no
 * box already accepted. Boxes depend on the city name and the camera only (the status line gets
 * a fixed width), so the result does not flicker as the status text changes during playback.
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
const STATUS_W = 120;
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
