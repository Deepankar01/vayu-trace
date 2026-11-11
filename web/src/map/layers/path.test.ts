import { PATH_PLAYING_EVERY_H, pathFetchDue } from "./path";

describe("pathFetchDue", () => {
  it("never fetches without a selected city", () => {
    expect(pathFetchDue(null, { city: null, hour: 3, playing: false })).toBe(false);
  });
  it("fetches for a newly selected or changed city at once, even while playing", () => {
    expect(pathFetchDue(null, { city: "delhi", hour: 3.4, playing: true })).toBe(true);
    expect(pathFetchDue({ city: "delhi", hour: 3 }, { city: "patna", hour: 3.4, playing: true })).toBe(true);
  });
  it("does not refetch within the same whole hour", () => {
    expect(pathFetchDue({ city: "delhi", hour: 3 }, { city: "delhi", hour: 3.9, playing: false })).toBe(false);
  });
  it("paused: refetches when the whole hour changes", () => {
    expect(pathFetchDue({ city: "delhi", hour: 3 }, { city: "delhi", hour: 4, playing: false })).toBe(true);
    expect(pathFetchDue({ city: "delhi", hour: 3 }, { city: "delhi", hour: 2.5, playing: false })).toBe(true);
  });
  it("playing: at most every 6 simulated hours", () => {
    expect(PATH_PLAYING_EVERY_H).toBe(6);
    expect(pathFetchDue({ city: "delhi", hour: 3 }, { city: "delhi", hour: 8.99, playing: true })).toBe(false);
    expect(pathFetchDue({ city: "delhi", hour: 3 }, { city: "delhi", hour: 9, playing: true })).toBe(true);
  });
  it("at 4x for 10 s of playback that is at most 7 fetches, not 40", () => {
    let last: { city: string; hour: number } | null = { city: "delhi", hour: 0 };
    let fetches = 0;
    for (let t = 0; t <= 10; t += 1 / 60) {
      const now = { city: "delhi", hour: t * 4, playing: true };
      if (pathFetchDue(last, now)) {
        fetches++;
        last = { city: "delhi", hour: Math.floor(now.hour) };
      }
    }
    expect(fetches).toBeLessThanOrEqual(7);
    // pausing afterwards catches up on the current hour
    expect(pathFetchDue(last, { city: "delhi", hour: 40, playing: false })).toBe(true);
  });
});
