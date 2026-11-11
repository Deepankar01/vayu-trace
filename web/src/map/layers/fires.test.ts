import type { Fire } from "../../api/types";
import { FIRE_WINDOW_H, fireAlpha, fireRadiusPx, fireWindow, prepareFires, windowData } from "./fires";

const fires: Fire[] = [
  [75, 30, 4, 10],
  [75.1, 30, 9, 3],
  [75.2, 30, 16, 33],
  [75.3, 30, 1, 34],
  [75.4, 30, 25, 10],
  [75.5, 30, 2, 0],
];

describe("prepareFires", () => {
  it("sorts by hour index (stable) into flat arrays", () => {
    const p = prepareFires(fires);
    expect(Array.from(p.hours)).toEqual([0, 3, 10, 10, 33, 34]);
    expect(Array.from(p.positions.slice(0, 4))).toEqual([75.5, 30, 75.1, 30].map(Math.fround));
    expect(p.positions[4]).toBeCloseTo(75); // first hour-10 fire keeps its order
    expect(p.n).toBe(6);
  });
});

describe("fireWindow", () => {
  const p = prepareFires(fires);
  const hoursIn = (x: number) => {
    const [lo, hi] = fireWindow(p.hours, x);
    return Array.from(p.hours.slice(lo, hi));
  };
  it("is the 24 h up to the playhead's hour, both ends inclusive", () => {
    expect(FIRE_WINDOW_H).toBe(24);
    expect(hoursIn(33)).toEqual([10, 10, 33]); // 10..33
    expect(hoursIn(33.9)).toEqual([10, 10, 33]);
    expect(hoursIn(34)).toEqual([33, 34]); // 11..34
  });
  it("starts at hour 0", () => {
    expect(hoursIn(0)).toEqual([0]);
    expect(hoursIn(2.5)).toEqual([0]);
    expect(hoursIn(3)).toEqual([0, 3]);
  });
  it("is empty with no data or nothing in range", () => {
    expect(fireWindow(new Int32Array(0), 5)).toEqual([0, 0]);
    const [lo, hi] = fireWindow(p.hours, 100);
    expect(hi - lo).toBe(0);
  });
  it("handles 55,000 detections quickly", () => {
    const many: Fire[] = Array.from({ length: 55_000 }, (_, i) => [70 + (i % 100) / 10, 25, 1 + (i % 50), (i * 7919) % 144]);
    const t0 = performance.now();
    const big = prepareFires(many);
    const t1 = performance.now();
    let total = 0;
    for (let x = 0; x < 144; x += 0.25) {
      const [lo, hi] = fireWindow(big.hours, x);
      total += hi - lo;
    }
    const t2 = performance.now();
    expect(total).toBeGreaterThan(0);
    expect(t1 - t0).toBeLessThan(500);
    expect((t2 - t1) / 576).toBeLessThan(0.5); // per window lookup, ms
    const [lo, hi] = fireWindow(big.hours, 60);
    for (let i = lo; i < hi; i++) expect(big.hours[i]).toBeGreaterThan(36);
    expect(big.hours[lo - 1]).toBeLessThanOrEqual(36);
  });
});

describe("radius and fade", () => {
  it("radius grows with sqrt(frp) and is clamped to 1.5..9 px", () => {
    expect(fireRadiusPx(0)).toBe(1.5);
    expect(fireRadiusPx(16) / fireRadiusPx(4)).toBeCloseTo(2);
    expect(fireRadiusPx(1e6)).toBe(9);
    expect(fireRadiusPx(NaN)).toBe(1.5);
  });
  it("fades with age: full at 0 h, faint (not zero) at 23 h", () => {
    expect(fireAlpha(0)).toBe(1);
    expect(fireAlpha(23)).toBeGreaterThan(0);
    expect(fireAlpha(23)).toBeLessThan(0.3);
    expect(fireAlpha(12)).toBeLessThan(fireAlpha(6));
  });
});

describe("windowData", () => {
  it("views the window without copying and fills colours by age", () => {
    const p = prepareFires(fires);
    const d = windowData(p, 33);
    expect(d.length).toBe(3);
    expect(d.positions.buffer).toBe(p.positions.buffer);
    expect(d.positions.length).toBe(6);
    expect(d.radii.length).toBe(3);
    const alpha = d.glow;
    // the hour-33 fire is newest (alpha highest)
    expect(alpha[2 * 4 + 3]).toBeGreaterThan(alpha[0 * 4 + 3]);
  });
});
