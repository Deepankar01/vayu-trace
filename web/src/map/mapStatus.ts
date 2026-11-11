/**
 * Map-local status for the UI (panels read it too): which hour the plume is waiting for.
 * `plumeLoadingHour` is non-null whenever the plume shown does not correspond to the playhead
 * because a needed frame is not loaded yet (nothing drawn, or only one of the two hours).
 */
import { create } from "zustand";

export interface MapStatus {
  plumeLoadingHour: number | null;
}

export const useMapStatus = create<MapStatus>()(() => ({ plumeLoadingHour: null }));

/** True while the plume does not match the playhead (see `plumeLoadingHour`). */
export const selectPlumeLoading = (s: MapStatus) => s.plumeLoadingHour !== null;
