/**
 * The selected city's back-trajectory: a dotted white line. Fetched when the city or the WHOLE
 * hour changes; while playing at most every PATH_PLAYING_EVERY_H simulated hours (paused: every
 * hour change), so playback at 4x does not fire four requests a second.
 */
import { PathStyleExtension } from "@deck.gl/extensions";
import { PathLayer } from "@deck.gl/layers";

export const PATH_PLAYING_EVERY_H = 6;

export interface PathFetched {
  city: string;
  /** Whole hour fetched. */
  hour: number;
}

/** Whether to fetch a path now, given what was last fetched (or requested). */
export function pathFetchDue(last: PathFetched | null, now: { city: string | null; hour: number; playing: boolean }): boolean {
  if (!now.city) return false;
  if (!last || last.city !== now.city) return true;
  const h = Math.floor(now.hour);
  if (h === last.hour) return false;
  if (!now.playing) return true;
  return Math.abs(h - last.hour) >= PATH_PLAYING_EVERY_H;
}

const dashes = new PathStyleExtension({ dash: true });

export function pathLayer(points: [number, number][], beforeId: string | undefined) {
  return new PathLayer<{ path: [number, number][] }>({
    id: "back-trajectory",
    data: [{ path: points }],
    getPath: (d: { path: [number, number][] }) => d.path,
    getColor: [255, 255, 255, Math.round(0.85 * 255)],
    getWidth: 1.8,
    widthUnits: "pixels",
    capRounded: true,
    jointRounded: true,
    extensions: [dashes],
    getDashArray: [2, 5], // short dashes, ~square at this width: a dotted line
    dashUnits: "pixels",
    dashJustified: true,
    beforeId,
    pickable: false,
  } as never);
}
