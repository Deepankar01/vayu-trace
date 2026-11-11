import { describe, expect, it, vi } from "vitest";
import type { Frame } from "./decode";
import { FrameCache } from "./frameCache";

interface Call {
  hour: number;
  extras: string[];
  signal: AbortSignal;
  resolve: (f?: Frame) => void;
  reject: (e: unknown) => void;
}

const stub = (): Frame => ({ tags: new Map(), nx: 1, ny: 1 });
const flush = () => new Promise<void>((r) => setTimeout(r, 0));

function setup(nHours = 100, opts: { radius?: number; maxConcurrent?: number } = {}) {
  const calls: Call[] = [];
  const onChange = vi.fn();
  const onError = vi.fn();
  const cache = new FrameCache({
    ...opts,
    onChange, onError,
    fetchFrame: (hour, extras, signal) =>
      new Promise<Frame>((resolve, reject) => {
        calls.push({ hour, extras, signal, resolve: (f) => resolve(f ?? stub()), reject });
      }),
  });
  cache.configure(nHours);
  const pending = () => calls.filter((c) => !c.signal.aborted && !(c as Call & { done?: boolean }).done);
  /** Resolve every request that is currently in flight, repeatedly, until the window is full. */
  async function drain() {
    for (let i = 0; i < 200; i++) {
      const open = cache.inflightHours();
      if (!open.length) return;
      for (const h of open) {
        const c = [...calls].reverse().find((x) => x.hour === h && !x.signal.aborted)!;
        c.resolve();
      }
      await flush();
    }
  }
  return { cache, calls, onChange, onError, pending, drain };
}

describe("FrameCache window and concurrency", () => {
  it("fetches nearest first, later hour first on ties, at most 4 at a time", async () => {
    const { cache, calls } = setup();
    cache.setCentre(50);
    expect(calls.map((c) => c.hour)).toEqual([50, 51, 49, 52]);
    expect(cache.inflightHours()).toHaveLength(4);
    calls[0].resolve();
    await flush();
    expect(calls.map((c) => c.hour)).toEqual([50, 51, 49, 52, 48]); // a slot freed, the next nearest starts
    expect(cache.inflightHours()).toHaveLength(4);
    expect(cache.get(50)).toBeDefined();
  });

  it("never exceeds 4 in flight while filling the +/-12 window (25 frames)", async () => {
    const { cache, calls, drain } = setup();
    let max = 0;
    const spy = vi.spyOn(cache, "inflightHours");
    cache.setCentre(50);
    for (let i = 0; i < 100 && cache.inflightHours().length; i++) {
      max = Math.max(max, cache.inflightHours().length);
      await drain();
    }
    spy.mockRestore();
    expect(max).toBeLessThanOrEqual(4);
    expect(cache.cachedHours()).toEqual(Array.from({ length: 25 }, (_, i) => 38 + i));
    expect(calls).toHaveLength(25);
  });

  it("clips the window at both ends of the run", async () => {
    const a = setup(100);
    a.cache.setCentre(2);
    await a.drain();
    expect(a.cache.cachedHours()).toEqual(Array.from({ length: 15 }, (_, i) => i)); // 0..14
    const b = setup(5);
    b.cache.setCentre(4.7);
    await b.drain();
    expect(b.cache.cachedHours()).toEqual([0, 1, 2, 3, 4]);
  });

  it("never refetches a cached hour; moving the window fetches only the new edge and evicts the far one", async () => {
    const { cache, calls, drain } = setup();
    cache.setCentre(50);
    await drain();
    const before = calls.length;
    cache.setCentre(50.9); // same integer hour
    cache.setCentre(50);
    expect(calls).toHaveLength(before);
    cache.setCentre(51);
    await drain();
    expect(calls.slice(before).map((c) => c.hour)).toEqual([63]);
    expect(cache.get(38)).toBeUndefined();
    expect(cache.get(63)).toBeDefined();
  });

  it("aborts in-flight requests that fall out of the window", async () => {
    const { cache, calls } = setup();
    cache.setCentre(50);
    const first = [...calls];
    cache.setCentre(80);
    expect(first.every((c) => c.signal.aborted)).toBe(true);
    expect(cache.inflightHours().every((h) => Math.abs(h - 80) <= 12)).toBe(true);
    // a late answer for an aborted request is ignored
    first[0].resolve();
    await flush();
    expect(cache.get(first[0].hour)).toBeUndefined();
  });

  it("keeps in-flight requests that are still inside the window", () => {
    const { cache, calls } = setup();
    cache.setCentre(50);
    cache.setCentre(51);
    expect(calls.slice(0, 4).every((c) => !c.signal.aborted)).toBe(true);
    expect(calls).toHaveLength(4);
  });
});

describe("FrameCache extras, failures and clear", () => {
  it("refetches frames lacking a newly enabled user tag, keeps serving the old one meanwhile", async () => {
    const { cache, calls, drain } = setup(30, { radius: 1 });
    cache.setCentre(10);
    await drain();
    expect(calls).toHaveLength(3);
    cache.setExtras(["user_1"]);
    expect(calls.slice(3).map((c) => c.extras)).toEqual([["user_1"], ["user_1"], ["user_1"]]);
    expect(cache.get(10)).toBeDefined(); // old frame still there
    await drain();
    expect(calls).toHaveLength(6);
    cache.setExtras([]); // disabling needs no refetch
    cache.setExtras(["user_1"]); // re-enabling a tag the frames already carry neither
    expect(calls).toHaveLength(6);
  });

  it("aborts an in-flight request made without a newly needed extra", () => {
    const { cache, calls } = setup(30, { radius: 0 });
    cache.setCentre(10);
    cache.setExtras(["user_1"]);
    expect(calls[0].signal.aborted).toBe(true);
    expect(calls[1].extras).toEqual(["user_1"]);
  });

  it("reports a failed hour once and does not retry it until the window moves or clear()", async () => {
    const { cache, calls, onError } = setup(30, { radius: 1 });
    cache.setCentre(10);
    calls.find((c) => c.hour === 10)!.reject(new Error("boom"));
    await flush();
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][0]).toBe(10);
    cache.setCentre(10);
    expect(calls.filter((c) => c.hour === 10)).toHaveLength(1);
    cache.clear();
    cache.refresh();
    expect(calls.filter((c) => c.hour === 10)).toHaveLength(2);
  });

  it("does not report aborts as errors", async () => {
    const { cache, calls, onError } = setup(100, { radius: 1 });
    cache.setCentre(50);
    cache.setCentre(90);
    calls[0].reject(new DOMException("aborted", "AbortError"));
    await flush();
    expect(onError).not.toHaveBeenCalled();
  });

  it("clear() drops frames and aborts requests; refresh() refills", async () => {
    const { cache, calls, drain, onChange } = setup(30, { radius: 1 });
    cache.setCentre(10);
    await drain();
    cache.setCentre(11); // starts hour 12
    cache.clear();
    expect(cache.cachedHours()).toEqual([]);
    expect(calls[calls.length - 1].signal.aborted).toBe(true);
    expect(onChange).toHaveBeenCalled();
    cache.refresh();
    expect(cache.inflightHours()).toEqual([10, 11, 12]);
  });

  it("serves nothing after dispose()", () => {
    const { cache, calls } = setup(30);
    cache.dispose();
    cache.setCentre(5);
    expect(calls).toHaveLength(0);
  });
});
