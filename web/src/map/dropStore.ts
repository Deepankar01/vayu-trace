/**
 * Map-local UI state: "Drop source" arming. While armed a map click reports its lon/lat
 * (`onDropPoint`) instead of selecting a city, the cursor is a crosshair, and Escape disarms.
 * Kept out of the app store (web/src/state) because it is pure map interaction state.
 */
import { create } from "zustand";

export interface DropState {
  armedForDrop: boolean;
  arm: () => void;
  disarm: () => void;
}

export const useDropStore = create<DropState>()((set) => ({
  armedForDrop: false,
  arm: () => set({ armedForDrop: true }),
  disarm: () => set({ armedForDrop: false }),
}));
