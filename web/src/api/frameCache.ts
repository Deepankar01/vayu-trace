/**
 * Decoded-frame cache around the playhead, independent of the store so it can be tested with a
 * fake fetch.
 *
 * - Keeps frames for integer hours within +/-`radius` (12) of the centre hour (clipped to the run)
 *   and evicts the rest.
 * - Fetches missing hours nearest-first (ties: the later hour first, playback moves forward), at
 *   most `maxConcurrent` (4) at a time; a cached hour is never fetched again.
 * - Aborts in-flight requests whose hour leaves the window.
 * - A cached frame fetched with `extra=` user tags satisfies any request for a subset of them
 *   (disabling a source needs no refetch); a frame missing a needed tag is refetched, and `get`
 *   keeps returning the old frame meanwhile (no blank map; the new source is simply absent from
 *   it until the refetch lands).
 * - A failed hour is reported once through `onError` and not retried until the window moves past
 *   it, `clear()` or the extras change (no hammering a failing server).
 */
import type { Frame } from "./decode";

export type FetchFrame = (hour: number, extras: string[], signal: AbortSignal) => Promise<Frame>;

export interface FrameCacheOptions {
  fetchFrame: FetchFrame;
  radius?: number;
  maxConcurrent?: number;
  /** Called when a frame arrives or is evicted-by-clear (for the UI to redraw). */
  onChange?: () => void;
  onError?: (hour: number, error: unknown) => void;
}

interface Entry {
  frame: Frame;
  extras: Set<string>;
}

interface Flight {
  controller: AbortController;
  extras: string[];
}

export class FrameCache {
  private readonly fetchFrame: FetchFrame;
  private readonly radius: number;
  private readonly maxConcurrent: number;
  private readonly onChange?: () => void;
  private readonly onError?: (hour: number, error: unknown) => void;

  private readonly cache = new Map<number, Entry>();
  private readonly inflight = new Map<number, Flight>();
  private readonly failed = new Set<number>();
  private nHours = 0;
  private centre = 0;
  private extras: string[] = [];
  private active = false;

  constructor(opts: FrameCacheOptions) {
    this.fetchFrame = opts.fetchFrame;
    this.radius = opts.radius ?? 12;
    this.maxConcurrent = opts.maxConcurrent ?? 4;
    this.onChange = opts.onChange;
    this.onError = opts.onError;
  }

  /** Start serving a run of `nHours` hours; drops everything cached for any previous run. */
  configure(nHours: number): void {
    this.clear();
    this.nHours = nHours;
    this.active = true;
  }

  /** The enabled user tags to request with `extra=`. Re-fetches frames that lack a needed tag. */
  setExtras(extras: readonly string[]): void {
    const next = [...extras].sort();
    if (next.join(",") === this.extras.join(",")) return;
    this.extras = next;
    this.failed.clear();
    for (const [h, f] of [...this.inflight]) {
      if (!this.satisfies(f.extras, next)) this.abort(h);
    }
    this.pump();
  }

  /** Move the window to the integer hour containing the playhead and fetch what is missing. */
  setCentre(hour: number): void {
    this.centre = Math.floor(hour);
    this.pump();
  }

  /** The decoded frame for an integer hour, if cached (possibly lacking a just-added user tag). */
  get(hour: number): Frame | undefined {
    return this.cache.get(hour)?.frame;
  }

  /** Hours currently cached (for tests and diagnostics). */
  cachedHours(): number[] {
    return [...this.cache.keys()].sort((a, b) => a - b);
  }

  inflightHours(): number[] {
    return [...this.inflight.keys()].sort((a, b) => a - b);
  }

  /** Drop every frame and abort every request (a rebuilt run, a new run). Call `pump()` after. */
  clear(): void {
    for (const h of [...this.inflight.keys()]) this.abort(h);
    this.cache.clear();
    this.failed.clear();
    this.onChange?.();
  }

  /** Fetch whatever the window still lacks (after `clear()` once the new build is known). */
  refresh(): void {
    this.pump();
  }

  dispose(): void {
    this.active = false;
    this.clear();
  }

  private satisfies(have: Iterable<string>, need: readonly string[]): boolean {
    const h = new Set(have);
    return need.every((t) => h.has(t));
  }

  private window(): number[] {
    const lo = Math.max(0, this.centre - this.radius);
    const hi = Math.min(this.nHours - 1, this.centre + this.radius);
    const hours: number[] = [];
    for (let h = lo; h <= hi; h++) hours.push(h);
    // nearest first; the later hour first on ties
    return hours.sort((a, b) => Math.abs(a - this.centre) - Math.abs(b - this.centre) || b - a);
  }

  private abort(hour: number): void {
    this.inflight.get(hour)?.controller.abort();
    this.inflight.delete(hour);
  }

  private pump(): void {
    if (!this.active) return;
    const wanted = this.window();
    const inWindow = new Set(wanted);
    for (const h of [...this.inflight.keys()]) if (!inWindow.has(h)) this.abort(h);
    for (const h of [...this.cache.keys()]) if (!inWindow.has(h)) this.cache.delete(h);
    for (const h of [...this.failed]) if (!inWindow.has(h)) this.failed.delete(h);

    for (const h of wanted) {
      if (this.inflight.size >= this.maxConcurrent) break;
      if (this.inflight.has(h) || this.failed.has(h)) continue;
      const have = this.cache.get(h);
      if (have && this.satisfies(have.extras, this.extras)) continue;
      this.start(h);
    }
  }

  private start(hour: number): void {
    const controller = new AbortController();
    const extras = [...this.extras];
    const flight: Flight = { controller, extras };
    this.inflight.set(hour, flight);
    this.fetchFrame(hour, extras, controller.signal).then(
      (frame) => {
        if (this.inflight.get(hour) !== flight) return; // aborted or superseded meanwhile
        this.inflight.delete(hour);
        this.cache.set(hour, { frame, extras: new Set(extras) });
        this.onChange?.();
        this.pump();
      },
      (error) => {
        if (this.inflight.get(hour) !== flight) return;
        this.inflight.delete(hour);
        if (controller.signal.aborted) return;
        this.failed.add(hour);
        this.onError?.(hour, error);
        this.pump();
      },
    );
  }
}
