/**
 * Map-local status for the UI (panels read it too): which hour the plume is waiting for, and
 * which hour the drawn back-trajectory belongs to.
 * `plumeLoadingHour` is non-null whenever the plume shown does not correspond to the playhead
 * because a needed frame is not loaded yet (nothing drawn, or only one of the two hours).
 * `pathHour` is the whole hour of the dotted path on the map, null when none is drawn (during
 * playback it is refreshed at most every few simulated hours, so it can lag the playhead).
 */
import { create } from "zustand";

export interface MapStatus {
  plumeLoadingHour: number | null;
  pathHour: number | null;
}

export const useMapStatus = create<MapStatus>()(() => ({ plumeLoadingHour: null, pathHour: null }));

/** True while the plume does not match the playhead (see `plumeLoadingHour`). */
export const selectPlumeLoading = (s: MapStatus) => s.plumeLoadingHour !== null;
