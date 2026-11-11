import type { WindField } from "../../api/types";
import { WindParticles, advect, sampleWind, toWindGrid } from "./windField";

/** 3x3 lattice at 1 deg from (66, 6): u = lon index, v = 10 * lat index. */
function field(over: Partial<WindField> = {}): WindField {
  const u: (number | null)[] = [];
  const v: (number | null)[] = [];
  for (let j = 0; j < 3; j++) for (let i = 0; i < 3; i++) {
    u.push(i);
    v.push(10 * j);
  }
  return { step: 1, lon0: 66, lat0: 6, nx: 3, ny: 3, u, v, ...over };
}

describe("sampleWind", () => {
  const g = toWindGrid(field());
  it("returns lattice values at nodes (row 0 = south)", () => {
    expect(sampleWind(g, 66, 6)).toEqual([0, 0]);
    expect(sampleWind(g, 67, 8)).toEqual([1, 20]);
  });
  it("interpolates bilinearly between nodes", () => {
    const s = sampleWind(g, 66.5, 6.25)!;
    expect(s[0]).toBeCloseTo(0.5);
    expect(s[1]).toBeCloseTo(2.5);
  });
  it("works on the east and north edges and is null outside", () => {
    expect(sampleWind(g, 68, 8)).toEqual([2, 20]);
    expect(sampleWind(g, 68.01, 7)).toBeNull();
    expect(sampleWind(g, 67, 5.99)).toBeNull();
    expect(sampleWind(g, NaN, 7)).toBeNull();
  });
  it("is null where any surrounding node has no data", () => {
    const f = field();
    f.v[0] = null; // node (66, 6)
    const h = toWindGrid(f);
    expect(sampleWind(h, 66.5, 6.5)).toBeNull();
    expect(sampleWind(h, 66, 6)).toBeNull();
    expect(sampleWind(h, 67.5, 7.5)).not.toBeNull(); // that cell does not touch the missing node
  });
});

describe("advect", () => {
  it("u > 0 moves east, v > 0 moves north, proportional to speed", () => {
    const [lon1, lat1] = advect(80, 20, 5, 0, 1, 0.1);
    expect(lon1).toBeGreaterThan(80);
    expect(lat1).toBe(20);
    const [lon2, lat2] = advect(80, 20, 0, 5, 1, 0.1);
    expect(lat2).toBeCloseTo(20.5);
    expect(lon2).toBe(80);
    const [lon3] = advect(80, 20, 10, 0, 1, 0.1);
    expect(lon3 - 80).toBeCloseTo(2 * (lon1 - 80));
    const [lon4, lat4] = advect(80, 20, -5, -5, 1, 0.1);
    expect(lon4).toBeLessThan(80);
    expect(lat4).toBeLessThan(20);
  });
  it("east-west steps are stretched by 1/cos(lat) (degrees of longitude shrink northwards)", () => {
    const [a] = advect(80, 0, 5, 0, 1, 0.1);
    const [b] = advect(80, 60, 5, 0, 1, 0.1);
    expect((b - 80) / (a - 80)).toBeCloseTo(2, 3);
  });
});

describe("WindParticles", () => {
  const seq = (values: number[]) => {
    let k = 0;
    return () => values[k++ % values.length];
  };

  it("spawns inside the domain where wind is defined", () => {
    const g = toWindGrid(field());
    const p = new WindParticles(50, 4, Math.random);
    p.step(g, 0.016);
    for (let i = 0; i < p.n; i++) {
      const [lon, lat] = p.position(i);
      expect(lon).toBeGreaterThanOrEqual(66);
      expect(lon).toBeLessThanOrEqual(68);
      expect(lat).toBeGreaterThanOrEqual(6);
      expect(lat).toBeLessThanOrEqual(8);
    }
  });

  it("moves particles with the wind", () => {
    const f = field({ u: Array(9).fill(5), v: Array(9).fill(0) });
    const g = toWindGrid(f);
    const p = new WindParticles(1, 4, seq([0.25, 0.5, 0.5]));
    p.step(g, 0.001);
    const [lon0, lat0] = p.position(0);
    p.step(g, 0.1);
    const [lon1, lat1] = p.position(0);
    expect(lon1).toBeGreaterThan(lon0);
    expect(lat1).toBeCloseTo(lat0);
  });

  it("respawns particles that leave the domain or outlive their life", () => {
    const f = field({ u: Array(9).fill(20), v: Array(9).fill(0) });
    const g = toWindGrid(f);
    const p = new WindParticles(1, 4, seq([0.99, 0.5, 0.5, 0.0, 0.5, 0.5]));
    p.step(g, 0.001); // spawned near the east edge
    const before = p.respawns;
    p.step(g, 0.5); // blown out east
    expect(p.respawns).toBeGreaterThan(before);
    const [lon] = p.position(0);
    expect(lon).toBeLessThanOrEqual(68);

    const q = new WindParticles(1, 4, seq([0.5]));
    const calm = toWindGrid(field({ u: Array(9).fill(0), v: Array(9).fill(0) }));
    q.step(calm, 0.001);
    const r0 = q.respawns;
    for (let k = 0; k < 100; k++) q.step(calm, 0.1); // 10 s, beyond any lifetime
    expect(q.respawns).toBeGreaterThan(r0);
  });

  it("parks particles when no wind is defined anywhere (no streaks)", () => {
    const f = field({ u: Array(9).fill(null), v: Array(9).fill(null) });
    const p = new WindParticles(10, 4, Math.random);
    p.step(toWindGrid(f), 0.016);
    expect(p.liveCount()).toBe(0);
  });

  it("writes trail segments with alpha falling towards the tail", () => {
    const f = field({ u: Array(9).fill(2), v: Array(9).fill(1) });
    const g = toWindGrid(f);
    const p = new WindParticles(5, 5, Math.random);
    for (let k = 0; k < 40; k++) p.step(g, 0.05);
    const seg = p.segments();
    expect(seg.count).toBe(5 * 4);
    expect(seg.source.length).toBeGreaterThanOrEqual(seg.count * 2);
    // head segment of particle 0 is at least as opaque as its last
    expect(seg.colors[3]).toBeGreaterThanOrEqual(seg.colors[3 * 4 + 3]);
  });
});
