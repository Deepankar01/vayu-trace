import { MAX_DT, frameDt, startAnimationLoop } from "./useMapAnimation";

describe("frameDt", () => {
  it("is 0 on the first frame", () => {
    expect(frameDt(null, 1234)).toBe(0);
  });
  it("is the elapsed time in seconds", () => {
    expect(frameDt(1000, 1016)).toBeCloseTo(0.016);
  });
  it("is clamped to 100 ms so a stalled tab does not jump the playhead", () => {
    expect(MAX_DT).toBe(0.1);
    expect(frameDt(0, 5000)).toBe(0.1);
    expect(frameDt(1000, 900)).toBe(0);
  });
});

/** A manual requestAnimationFrame: `run(n)` fires n frames 16 ms apart. */
function fakeRaf() {
  let queue: ((now: number) => void)[] = [];
  let now = 0;
  return {
    raf: (cb: (now: number) => void) => queue.push(cb),
    caf: () => {
      queue = [];
    },
    run(n: number) {
      for (let i = 0; i < n; i++) {
        const q = queue;
        queue = [];
        now += 16;
        q.forEach((cb) => cb(now));
      }
    },
  };
}

describe("startAnimationLoop", () => {
  it("survives a throwing frame and reports the problem exactly once", () => {
    const r = fakeRaf();
    const errors: (string | null)[] = [];
    let calls = 0;
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const stop = startAnimationLoop({
      raf: r.raf, caf: r.caf,
      frame: () => {
        calls++;
        if (calls >= 2 && calls <= 4) throw new Error("boom");
      },
      onError: (m) => errors.push(m),
    });
    r.run(8);
    expect(calls).toBe(8); // kept running
    expect(errors).toEqual(["map animation: boom", null]); // once, then cleared
    expect(spy).toHaveBeenCalledTimes(1);
    stop();
    r.run(3);
    expect(calls).toBe(8);
    spy.mockRestore();
  });

  it("passes clamped dt (0 on the first frame)", () => {
    const r = fakeRaf();
    const dts: number[] = [];
    startAnimationLoop({ raf: r.raf, caf: r.caf, frame: (dt) => dts.push(dt) });
    r.run(3);
    expect(dts[0]).toBe(0);
    expect(dts[1]).toBeCloseTo(0.016);
  });
});
