import { MAX_DT, frameDt } from "./useMapAnimation";

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
