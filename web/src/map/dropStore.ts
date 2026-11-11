/**
 * Map-local UI state for "Drop source": arming, and the point picked for the dialog. While armed
 * a map click reports its lon/lat (`onDropPoint`) instead of selecting a city, the cursor is a
 * crosshair, and Escape disarms. `pending` is the picked point (with its screen position, so the
 * dialog can open next to it) until the dialog closes. Kept out of the app store (web/src/state)
 * because it is pure interaction state.
 */
import { create } from "zustand";

export interface DropPoint {
  lon: number;
  lat: number;
  /** Screen position of the click, CSS pixels. */
  x: number;
  y: number;
}

export interface DropState {
  armedForDrop: boolean;
  pending: DropPoint | null;
  arm: () => void;
  disarm: () => void;
  /** A point was picked: disarm and open the dialog for it. */
  place: (p: DropPoint) => void;
  close: () => void;
}

export const useDropStore = create<DropState>()((set) => ({
  armedForDrop: false,
  pending: null,
  arm: () => set({ armedForDrop: true, pending: null }),
  disarm: () => set({ armedForDrop: false }),
  place: (p) => set({ armedForDrop: false, pending: p }),
  close: () => set({ pending: null }),
}));
