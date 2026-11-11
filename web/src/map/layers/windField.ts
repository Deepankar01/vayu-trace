/**
 * Wind streak particles (pure; no deck.gl). The API's lattice (`/wind/{hour}`) is u, v in m/s on
 * 1 deg nodes, row-major from the south-west node; null means no data, and no streak is drawn
 * where any surrounding node lacks data.
 *
 * Motion is a visual, not a physical, rate: a particle moves `WIND_SPEED_SCALE` degrees per second
 * of wall time for each m/s of wind (so speed is proportional to the wind, independent of the
 * playback speed, and keeps flowing while paused).
 */
import type { WindField } from "../../api/types";

export const WIND_SPEED_SCALE = 0.15; // deg per second per m/s
const TRAIL_DT = 0.07; // seconds between stored trail points
const FADE_S = 0.5;
const MIN_LIFE_S = 2;
const MAX_LIFE_S = 5;
const SPAWN_TRIES = 20;
const BASE_ALPHA = 0.33 * 255;
const STREAK_RGB = [0xcf, 0xe0, 0xff];

export interface WindGrid {
  lon0: number;
  lat0: number;
  step: number;
  nx: number;
  ny: number;
  /** NaN where the API sent null. */
  u: Float32Array;
  v: Float32Array;
}

export function toWindGrid(w: WindField): WindGrid {
  const conv = (a: (number | null)[]) => Float32Array.from(a, (x) => (x == null ? NaN : x));
  return { lon0: w.lon0, lat0: w.lat0, step: w.step, nx: w.nx, ny: w.ny, u: conv(w.u), v: conv(w.v) };
}

/** Bilinear [u, v] at (lon, lat); null outside the lattice or where a surrounding node is missing. */
export function sampleWind(g: WindGrid, lon: number, lat: number): [number, number] | null {
  const fx = (lon - g.lon0) / g.step;
  const fy = (lat - g.lat0) / g.step;
  if (!(fx >= 0 && fy >= 0 && fx <= g.nx - 1 && fy <= g.ny - 1)) return null;
  // on the east / north edge use the last cell with weight 1 on its far side
  const i = Math.min(Math.floor(fx), g.nx - 2);
  const j = Math.min(Math.floor(fy), g.ny - 2);
  const tx = fx - i;
  const ty = fy - j;
  const k00 = j * g.nx + i;
  const k10 = k00 + 1;
  const k01 = k00 + g.nx;
  const k11 = k01 + 1;
  const lerp2 = (a: Float32Array) =>
    (a[k00] * (1 - tx) + a[k10] * tx) * (1 - ty) + (a[k01] * (1 - tx) + a[k11] * tx) * ty;
  const u = lerp2(g.u);
  const v = lerp2(g.v);
  // NaN at any corner poisons the blend, even with a zero weight (0 * NaN = NaN)
  if (Number.isNaN(u) || Number.isNaN(v)) return null;
  return [u, v];
}

/** One step: u east, v north; `scale` deg/s per m/s; longitude steps widened by 1/cos(lat). */
export function advect(lon: number, lat: number, u: number, v: number, dt: number, scale: number): [number, number] {
  const k = scale * dt;
  return [lon + (u * k) / Math.cos((lat * Math.PI) / 180), lat + v * k];
}

export interface Segments {
  count: number;
  /** lon, lat of each segment's head end */
  source: Float32Array;
  target: Float32Array;
  colors: Uint8Array;
}

export class WindParticles {
  readonly n: number;
  readonly trail: number;
  respawns = 0;
  private readonly rng: () => number;
  private readonly lon: Float32Array;
  private readonly lat: Float32Array;
  private readonly age: Float32Array;
  private readonly life: Float32Array;
  private readonly alive: Uint8Array;
  private readonly tx: Float32Array;
  private readonly ty: Float32Array;
  private head = 0;
  private clock = 0;
  private readonly seg: Segments;

  constructor(n: number, trail: number, rng: () => number = Math.random) {
    this.n = n;
    this.trail = trail;
    this.rng = rng;
    this.lon = new Float32Array(n);
    this.lat = new Float32Array(n);
    this.age = new Float32Array(n);
    this.life = new Float32Array(n); // 0: needs spawning
    this.alive = new Uint8Array(n);
    this.tx = new Float32Array(n * trail);
    this.ty = new Float32Array(n * trail);
    const count = n * (trail - 1);
    this.seg = { count, source: new Float32Array(2 * count), target: new Float32Array(2 * count), colors: new Uint8Array(4 * count) };
  }

  position(i: number): [number, number] {
    return [this.lon[i], this.lat[i]];
  }

  liveCount(): number {
    let c = 0;
    for (let i = 0; i < this.n; i++) c += this.alive[i];
    return c;
  }

  /** Advance every particle by `dt` seconds through `grid`; respawn the expired and the lost. */
  step(grid: WindGrid, dt: number): void {
    for (let i = 0; i < this.n; i++) {
      if (!this.alive[i] || this.age[i] >= this.life[i]) {
        this.spawn(i, grid);
        continue;
      }
      const w = sampleWind(grid, this.lon[i], this.lat[i]);
      if (!w) {
        this.spawn(i, grid);
        continue;
      }
      const [lon, lat] = advect(this.lon[i], this.lat[i], w[0], w[1], dt, WIND_SPEED_SCALE);
      if (!this.inside(grid, lon, lat)) {
        this.spawn(i, grid);
        continue;
      }
      this.lon[i] = lon;
      this.lat[i] = lat;
      this.age[i] += dt;
      const k = i * this.trail + this.head;
      this.tx[k] = lon;
      this.ty[k] = lat;
    }
    this.clock += dt;
    if (this.clock >= TRAIL_DT) {
      this.clock = 0;
      this.head = (this.head + 1) % this.trail;
      for (let i = 0; i < this.n; i++) {
        const k = i * this.trail + this.head;
        this.tx[k] = this.lon[i];
        this.ty[k] = this.lat[i];
      }
    }
  }

  /** Trail segments (head first per particle) in reused buffers; dead particles get alpha 0. */
  segments(): Segments {
    const { source, target, colors } = this.seg;
    const T = this.trail;
    let s = 0;
    for (let i = 0; i < this.n; i++) {
      const fade = this.alive[i]
        ? Math.max(0, Math.min(1, this.age[i] / FADE_S, (this.life[i] - this.age[i]) / FADE_S))
        : 0;
      for (let k = 0; k < T - 1; k++, s++) {
        const a = i * T + ((this.head - k + T) % T);
        const b = i * T + ((this.head - k - 1 + T) % T);
        source[2 * s] = this.tx[a];
        source[2 * s + 1] = this.ty[a];
        target[2 * s] = this.tx[b];
        target[2 * s + 1] = this.ty[b];
        colors[4 * s] = STREAK_RGB[0];
        colors[4 * s + 1] = STREAK_RGB[1];
        colors[4 * s + 2] = STREAK_RGB[2];
        colors[4 * s + 3] = Math.round(BASE_ALPHA * fade * (1 - k / (T - 1)));
      }
    }
    return this.seg;
  }

  private inside(g: WindGrid, lon: number, lat: number): boolean {
    return lon >= g.lon0 && lat >= g.lat0 && lon <= g.lon0 + (g.nx - 1) * g.step && lat <= g.lat0 + (g.ny - 1) * g.step;
  }

  private spawn(i: number, g: WindGrid): void {
    this.alive[i] = 0;
    for (let t = 0; t < SPAWN_TRIES; t++) {
      const lon = g.lon0 + this.rng() * (g.nx - 1) * g.step;
      const lat = g.lat0 + this.rng() * (g.ny - 1) * g.step;
      if (!sampleWind(g, lon, lat)) continue;
      this.lon[i] = lon;
      this.lat[i] = lat;
      this.age[i] = 0;
      this.life[i] = MIN_LIFE_S + this.rng() * (MAX_LIFE_S - MIN_LIFE_S);
      this.alive[i] = 1;
      this.tx.fill(lon, i * this.trail, (i + 1) * this.trail);
      this.ty.fill(lat, i * this.trail, (i + 1) * this.trail);
      this.respawns++;
      return;
    }
  }
}
