/**
 * The map's single requestAnimationFrame loop. Each frame: (1) advance the playhead with the
 * store's `tick(dt)` when playing, (2) run `step(dt)` (wind particles, layer rebuilds). `dt` is in
 * seconds, clamped to MAX_DT so a stalled frame does not jump the playhead. The loop stops while
 * the tab is hidden and restarts (with a fresh clock) when it is shown again.
 */
import { useEffect, useRef } from "react";
import { useStore, type AppStore } from "../state/store";

export const MAX_DT = 0.1;

/** Seconds since the previous frame (0 on the first), clamped to MAX_DT. */
export function frameDt(prevMs: number | null, nowMs: number): number {
  if (prevMs === null) return 0;
  return Math.min(MAX_DT, Math.max(0, (nowMs - prevMs) / 1000));
}

export function useMapAnimation(step: (dt: number) => void, store: AppStore = useStore): void {
  const stepRef = useRef(step);
  stepRef.current = step;

  useEffect(() => {
    let raf = 0;
    let prev: number | null = null;
    const loop = (now: number) => {
      const dt = frameDt(prev, now);
      prev = now;
      if (store.getState().playing) store.getState().tick(dt);
      stepRef.current(dt);
      raf = requestAnimationFrame(loop);
    };
    const start = () => {
      if (raf || document.hidden) return;
      prev = null;
      raf = requestAnimationFrame(loop);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };
    const onVisibility = () => (document.hidden ? stop() : start());
    document.addEventListener("visibilitychange", onVisibility);
    start();
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [store]);
}
