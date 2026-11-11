/**
 * A problem that clears itself: MapLibre reports transient errors (one failed tile) that should
 * not sit on screen forever. `raise` shows a message unless the same one is already shown, and
 * clears it after `ttlMs`; `clear` (or a dismissal in the UI) removes it.
 */
export const MAP_PROBLEM_TTL_MS = 10_000;

export class TransientProblem {
  private current: string | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private readonly report: (message: string | null) => void;
  private readonly ttlMs: number;

  constructor(report: (message: string | null) => void, ttlMs = MAP_PROBLEM_TTL_MS) {
    this.report = report;
    this.ttlMs = ttlMs;
  }

  raise(message: string): void {
    if (message === this.current) return; // the same message is not reported again while shown
    this.current = message;
    this.report(message);
    this.stopTimer();
    this.timer = setTimeout(() => this.clear(), this.ttlMs);
  }

  clear(): void {
    this.stopTimer();
    if (this.current === null) return;
    this.current = null;
    this.report(null);
  }

  dispose(): void {
    this.stopTimer();
  }

  private stopTimer(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }
}
