/**
 * App keyboard shortcuts: Space play/pause, Left/Right one hour, Escape cancels drop arming or
 * closes the drop dialog (not while it is submitting). While any modal dialog is open
 * (`aria-modal="true"`: the drop dialog, the Validation dialog) only Escape is handled. Keys typed
 * into a form control, Space on a focused button (which the button handles itself), and keys whose
 * target is inside the map (MapLibre pans with the arrows there) are never captured.
 */
import { useEffect } from "react";
import { useDropStore } from "../map/dropStore";
import type { AppStore } from "../state/store";

export type KeyAction = "toggle" | "prev" | "next" | "escape";

interface KeyInfo {
  key: string;
  target: EventTarget | null;
  metaKey?: boolean;
  ctrlKey?: boolean;
  altKey?: boolean;
  /** A modal dialog is open (drop source, Validation): only Escape is a shortcut. */
  dialogOpen?: boolean;
}

const FORM_TAGS = new Set(["INPUT", "SELECT", "TEXTAREA"]);

/** True when the event target edits or operates on keys itself. */
export function isFormTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  return FORM_TAGS.has(target.tagName) || target.isContentEditable;
}

/** The map's own container (MapLibre's canvas container, inside `.vayu-map`). */
export const MAP_SELECTOR = ".vayu-map";

export function isMapTarget(target: EventTarget | null): boolean {
  return target instanceof Element && target.closest(MAP_SELECTOR) !== null;
}

/** True while any modal dialog is in the document. */
export function modalOpen(doc: Document = document): boolean {
  return doc.querySelector('[aria-modal="true"]') !== null;
}

/** The shortcut for a key event, or null to leave it alone. */
export function keyAction(e: KeyInfo): KeyAction | null {
  if (e.key === "Escape") return "escape";
  if (e.dialogOpen || e.metaKey || e.ctrlKey || e.altKey || isFormTarget(e.target) || isMapTarget(e.target)) return null;
  const onButton = e.target instanceof HTMLElement && (e.target.tagName === "BUTTON" || e.target.getAttribute("role") === "switch");
  if (e.key === " ") return onButton ? null : "toggle";
  if (e.key === "ArrowRight") return "next";
  if (e.key === "ArrowLeft") return "prev";
  return null;
}

export function useKeyboard(store: AppStore): void {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const action = keyAction({
        key: e.key, target: e.target, metaKey: e.metaKey, ctrlKey: e.ctrlKey, altKey: e.altKey,
        dialogOpen: useDropStore.getState().pending !== null || modalOpen(),
      });
      if (!action) return;
      const s = store.getState();
      switch (action) {
        case "toggle":
          e.preventDefault();
          s.togglePlay();
          break;
        case "next":
          e.preventDefault();
          s.setHour(Math.floor(s.hour) + 1);
          break;
        case "prev":
          e.preventDefault();
          s.setHour(Math.ceil(s.hour) - 1);
          break;
        case "escape": {
          const d = useDropStore.getState();
          if (d.pending) d.close();
          else if (d.armedForDrop) d.disarm();
          break;
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [store]);
}
