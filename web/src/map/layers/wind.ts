/**
 * Animated wind streaks: the particles of `windField.ts` drawn as short fading line segments,
 * plus a small per-hour cache of the wind lattice (`/wind/{hour}?build=`).
 */
import { LineLayer } from "@deck.gl/layers";
import type { WindField } from "../../api/types";
import { toWindGrid, type Segments, type WindGrid } from "./windField";

export const WIND_PARTICLES = 3000;
export const WIND_TRAIL_POINTS = 8;

/**
 * The buffers in `seg` are rewritten in place every frame. deck.gl re-uploads a binary attribute
 * when the attribute OBJECT changes identity (Attribute.setExternalBuffer), so the attribute
 * objects are built fresh on every call while the typed arrays are reused.
 */
export function windLayer(seg: Segments, beforeId: string | undefined) {
  return new LineLayer({
    id: "wind",
    data: {
      length: seg.count,
      attributes: {
        getSourcePosition: { value: seg.source, size: 2 },
        getTargetPosition: { value: seg.target, size: 2 },
        getColor: { value: seg.colors, size: 4, normalized: true },
      },
    },
    getWidth: 1.2,
    widthUnits: "pixels",
    beforeId,
    pickable: false,
    parameters: { depthWriteEnabled: false },
  } as never);
}

export const WIND_RETRY_MS = 5000;

export type FetchWind = (hour: number, signal: AbortSignal) => Promise<WindField>;

/**
 * Wind lattices by whole hour for one build. `get(h)` returns a cached grid or starts a fetch
 * (one in flight per hour); `onLoad` fires when one lands. Hours far from the playhead are evicted
 * and their requests aborted. A failed hour is retried after WIND_RETRY_MS (no retry storm);
 * everything is dropped when the build changes.
 */
export class WindCache {
  private grids = new Map<number, WindGrid>();
  private inflight = new Map<number, AbortController>();
  /** Hour -> time it failed. */
  private failed = new Map<number, number>();
  private build: string | null = null;
  private readonly fetchWind: FetchWind;
  private readonly onLoad: () => void;
  private readonly onError: (message: string) => void;
  private readonly now: () => number;

  constructor(fetchWind: FetchWind, onLoad: () => void, onError: (message: string) => void, now: () => number = Date.now) {
    this.fetchWind = fetchWind;
    this.onLoad = onLoad;
    this.onError = onError;
    this.now = now;
  }

  /** The grid for `hour` under `build` (null while loading / failed); prefetches `hour + 1`. */
  get(build: string, hour: number, nHours: number): WindGrid | null {
    if (build !== this.build) this.reset(build);
    const t = this.now();
    for (const [h, at] of [...this.failed]) if (t - at >= WIND_RETRY_MS) this.failed.delete(h);
    for (const h of [...this.grids.keys()]) if (Math.abs(h - hour) > 2) this.grids.delete(h);
    for (const [h, c] of [...this.inflight]) {
      if (Math.abs(h - hour) > 2) {
        c.abort();
        this.inflight.delete(h);
      }
    }
    this.ensure(hour);
    if (hour + 1 < nHours) this.ensure(hour + 1);
    return this.grids.get(hour) ?? null;
  }

  dispose(): void {
    this.reset(null);
  }

  private reset(build: string | null): void {
    for (const c of this.inflight.values()) c.abort();
    this.inflight.clear();
    this.grids.clear();
    this.failed.clear();
    this.build = build;
  }

  private ensure(hour: number): void {
    if (this.grids.has(hour) || this.inflight.has(hour) || this.failed.has(hour)) return;
    const controller = new AbortController();
    const build = this.build;
    this.inflight.set(hour, controller);
    this.fetchWind(hour, controller.signal).then(
      (w) => {
        if (this.inflight.get(hour) !== controller || this.build !== build) return;
        this.inflight.delete(hour);
        this.grids.set(hour, toWindGrid(w));
        this.onLoad();
      },
      (e: unknown) => {
        if (this.inflight.get(hour) !== controller) return;
        this.inflight.delete(hour);
        if (controller.signal.aborted) return;
        this.failed.set(hour, this.now());
        this.onError(`wind for hour ${hour}: ${e instanceof Error ? e.message : String(e)}`);
      },
    );
  }
}
