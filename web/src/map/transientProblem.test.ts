import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransientProblem } from "./transientProblem";

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("TransientProblem", () => {
  it("reports a message once, ignores repeats while shown, and clears itself after 10 s", () => {
    const report = vi.fn();
    const p = new TransientProblem(report);
    p.raise("Map error: tile 404");
    p.raise("Map error: tile 404");
    p.raise("Map error: tile 404");
    expect(report.mock.calls).toEqual([["Map error: tile 404"]]);
    vi.advanceTimersByTime(9_999);
    expect(report).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(1);
    expect(report.mock.calls).toEqual([["Map error: tile 404"], [null]]);
    p.raise("Map error: tile 404"); // after clearing, a new occurrence shows again
    expect(report).toHaveBeenCalledTimes(3);
  });

  it("a different message replaces the shown one and restarts the timer", () => {
    const report = vi.fn();
    const p = new TransientProblem(report);
    p.raise("a");
    vi.advanceTimersByTime(8_000);
    p.raise("b");
    vi.advanceTimersByTime(8_000);
    expect(report.mock.calls).toEqual([["a"], ["b"]]);
    vi.advanceTimersByTime(2_000);
    expect(report.mock.calls).toEqual([["a"], ["b"], [null]]);
  });
});
