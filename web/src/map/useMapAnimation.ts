/**
 * The map's single requestAnimationFrame loop. Each frame: (1) advance the playhead with the
 * store's `tick(dt)` when playing, (2) run `step(dt)` (wind particles, layer rebuilds). `dt` is in
 * seconds, clamped to MAX_DT so a stalled frame does not jump the playhead. The loop stops while
 * the tab is hidden and restarts (with a fresh clock) when it is shown again.
 *
 * An exception in a frame never kills the loop: the next frame is scheduled first, the error is
 * caught and reported once per distinct message (`onError(null)` after a clean frame clears it).
 */
import { useEffect, useRef } from "react";
import { useStore, type AppStore } from "../state/store";

export const MAX_DT = 0.1;

/** Seconds since the previous frame (0 on the first), clamped to MAX_DT. */
export function frameDt(prevMs: number | null, nowMs: number): number {
  if (prevMs === null) return 0;
  return Math.min(MAX_DT, Math.max(0, (nowMs - prevMs) / 1000));
}

export interface LoopOptions {
  /** One frame's work. */
  frame: (dt: number) => void;
  /** A frame threw (message), or frames are clean again (null). Called on changes only. */
  onError?: (message: string | null) => void;
  raf?: (cb: (now: number) => void) => number;
  caf?: (id: number) => void;
}

/** Start the loop; returns `stop`. */
export function startAnimationLoop({ frame, onError, raf = requestAnimationFrame, caf = cancelAnimationFrame }: LoopOptions): () => void {
  let id = 0;
  let stopped = false;
  let prev: number | null = null;
  let lastError: string | null = null;
  const loop = (now: number) => {
    if (stopped) return;
    id = raf(loop); // first: an exception below cannot stop the animation
    const dt = frameDt(prev, now);
    prev = now;
    let message: string | null = null;
    try {
      frame(dt);
    } catch (e) {
      message = `map animation: ${e instanceof Error ? e.message : String(e)}`;
      if (message !== lastError) console.error(e);
    }
    if (message !== lastError) {
      lastError = message;
      onError?.(message);
    }
  };
  id = raf(loop);
  return () => {
    stopped = true;
    caf(id);
  };
}

export function useMapAnimation(
  step: (dt: number) => void, onError?: (message: string | null) => void, store: AppStore = useStore,
): void {
  const latest = useRef({ step, onError });
  latest.current = { step, onError };

  useEffect(() => {
    let stop: (() => void) | null = null;
    const start = () => {
      if (stop || document.hidden) return;
      stop = startAnimationLoop({
        frame: (dt) => {
          if (store.getState().playing) store.getState().tick(dt);
          latest.current.step(dt);
        },
        onError: (m) => latest.current.onError?.(m),
      });
    };
    const halt = () => {
      stop?.();
      stop = null;
    };
    const onVisibility = () => (document.hidden ? halt() : start());
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      halt();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);
}
