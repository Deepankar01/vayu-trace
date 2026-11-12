import { aqiColor, pm25Ramp } from "../../lib/colors";
import { pm10ToAqi, pm25ToAqi } from "../../lib/aqi";
import {
  PLUME_ROWS, DIFF_DEAD_BAND, DIFF_SATURATION, colorizeInto, fieldToImageData, gridBounds, hazeOpacityFactor, mercatorY,
  resampleRowsToMercator,
} from "./plume";

const px = (img: { data: Uint8ClampedArray; width: number }, x: number, y: number) =>
  Array.from(img.data.slice((y * img.width + x) * 4, (y * img.width + x) * 4 + 4));

const hex = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16));

describe("fieldToImageData", () => {
  it("puts the south-west cell (index 0) in the bottom-left pixel (north up)", () => {
    const nx = 3, ny = 2;
    const f = new Float32Array(nx * ny);
    f[0] = 200;
    const img = fieldToImageData(f, nx, ny, "pm25");
    expect(img.width).toBe(3);
    expect(img.height).toBe(2);
    expect(px(img, 0, 1)[3]).toBeGreaterThan(0); // bottom-left
    expect(px(img, 0, 0)[3]).toBe(0); // top-left is the north-west cell, empty
    expect(px(img, 2, 1)[3]).toBe(0);
  });

  it("north-east cell (last index) lands top-right", () => {
    const f = new Float32Array(6);
    f[5] = 200;
    const img = fieldToImageData(f, 3, 2, "pm25");
    expect(px(img, 2, 0)[3]).toBeGreaterThan(0);
    expect(px(img, 0, 1)[3]).toBe(0);
  });

  it("a zero field is fully transparent in every mode", () => {
    for (const mode of ["pm25", "aqi", "diff"] as const) {
      const img = fieldToImageData(new Float32Array(16), 4, 4, mode);
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(0);
    }
  });

  it("NaN cells are fully transparent in every mode", () => {
    for (const mode of ["pm25", "aqi", "diff"] as const) {
      const img = fieldToImageData(new Float32Array([NaN, NaN, NaN, NaN]), 2, 2, mode);
      for (let i = 3; i < img.data.length; i += 4) expect(img.data[i]).toBe(0);
    }
  });

  it("pm25 mode follows pm25Ramp (colour and alpha, without haze = dry factor 0.6)", () => {
    const img = fieldToImageData(new Float32Array([150]), 1, 1, "pm25");
    const [r, g, b, a] = pm25Ramp(150);
    const p = px(img, 0, 0);
    expect(Math.abs(p[0] - r)).toBeLessThanOrEqual(2);
    expect(Math.abs(p[1] - g)).toBeLessThanOrEqual(2);
    expect(Math.abs(p[2] - b)).toBeLessThanOrEqual(2);
    expect(Math.abs(p[3] - a * 0.6)).toBeLessThanOrEqual(1.5);
  });

  it("pm25 mode: haze makes a cell denser, up to the full ramp alpha", () => {
    const f = new Float32Array([150, 150, 150]);
    const haze = new Float32Array([1, 1.5, 3]);
    const out = new Uint8ClampedArray(12);
    colorizeInto(out, 3, 1, "pm25", f, f, 0, haze, haze);
    const a = pm25Ramp(150)[3];
    expect(Math.abs(out[3] - a * 0.6)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(out[7] - a * 0.8)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(out[11] - a)).toBeLessThanOrEqual(1.5);
  });

  it("aqi mode colours by the CPCB category of the hourly value", () => {
    const values = [20, 45, 75, 100, 200, 300];
    const img = fieldToImageData(new Float32Array(values), values.length, 1, "aqi");
    values.forEach((v, i) => {
      const p = px(img, i, 0);
      expect(p.slice(0, 3)).toEqual(hex(aqiColor(pm25ToAqi(v))));
      expect(p[3]).toBeGreaterThan(0);
    });
  });

  it("aqi10 mode uses the PM10 breakpoints, so the same value can fall in a lower category", () => {
    const values = [20, 75, 100, 200, 300, 380];
    const img = fieldToImageData(new Float32Array(values), values.length, 1, "aqi10");
    values.forEach((v, i) => expect(px(img, i, 0).slice(0, 3)).toEqual(hex(aqiColor(pm10ToAqi(v)))));
    const fine = fieldToImageData(new Float32Array([100]), 1, 1, "aqi");
    expect(px(img, 2, 0).slice(0, 3)).not.toEqual(px(fine, 0, 0).slice(0, 3)); // 100: Satisfactory vs Poor
  });

  it("diff mode: transparent inside the +/-2 dead band, blue for reduction, red for increase", () => {
    const values = [1.9, -1.9, 2, -2, 50, -50];
    const img = fieldToImageData(new Float32Array(values), values.length, 1, "diff");
    expect(DIFF_DEAD_BAND).toBe(2);
    for (let i = 0; i < 4; i++) expect(px(img, i, 0)[3]).toBe(0);
    const up = px(img, 4, 0);
    const down = px(img, 5, 0);
    expect(up[0]).toBeGreaterThan(up[2]); // red
    expect(down[2]).toBeGreaterThan(down[0]); // blue
    expect(up[3]).toBe(down[3]); // symmetric
    expect(up[3]).toBeGreaterThan(0);
  });

  it("diff mode saturates at +/-100", () => {
    expect(DIFF_SATURATION).toBe(100);
    const img = fieldToImageData(new Float32Array([100, 400, -100, -400, 60]), 5, 1, "diff");
    expect(px(img, 0, 0)[3]).toBe(px(img, 1, 0)[3]);
    expect(px(img, 2, 0)[3]).toBe(px(img, 3, 0)[3]);
    expect(px(img, 0, 0)[3]).toBe(px(img, 2, 0)[3]);
    expect(px(img, 4, 0)[3]).toBeLessThan(px(img, 0, 0)[3]);
  });

  it("haze: a side without a haze field counts as dry (ratio 1), never borrowing the other's", () => {
    const f = new Float32Array([150]);
    const a = pm25Ramp(150)[3];
    const only = (hA: Float32Array | null, hB: Float32Array | null) => {
      const out = new Uint8ClampedArray(4);
      colorizeInto(out, 1, 1, "pm25", f, f, 0.5, hA, hB);
      return out[3];
    };
    // A has ratio 2, B none: 0.5 * 2 + 0.5 * 1 = 1.5 -> factor 0.8 (borrowing would give 1.0)
    expect(Math.abs(only(new Float32Array([2]), null) - a * 0.8)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(only(null, new Float32Array([2])) - a * 0.8)).toBeLessThanOrEqual(1.5);
    expect(Math.abs(only(null, null) - a * 0.6)).toBeLessThanOrEqual(1.5);
  });

  it("colorizeInto lerps two fields (NaN where either end is NaN)", () => {
    const a = new Float32Array([0, 100, NaN]);
    const b = new Float32Array([200, 100, 100]);
    const mid = new Uint8ClampedArray(12);
    colorizeInto(mid, 3, 1, "pm25", a, b, 0.5, null, null);
    const ref = new Uint8ClampedArray(12);
    colorizeInto(ref, 3, 1, "pm25", new Float32Array([100, 100, 100]), null, 0, null, null);
    expect(Array.from(mid.slice(0, 8))).toEqual(Array.from(ref.slice(0, 8)));
    expect(mid[11]).toBe(0);
  });
});

describe("gridBounds", () => {
  it("derives the plume bounds from meta.grid (the model domain 66-98 E, 6-38 N)", () => {
    const b = gridBounds({ lon_min: 66, lat_min: 6, cell: 0.1, nx: 320, ny: 320 });
    expect(b.map((v) => Math.round(v * 1e9) / 1e9)).toEqual([66, 6, 98, 38]);
  });
});

describe("hazeOpacityFactor", () => {
  it("is 0.6 when dry (ratio 1), 1.0 from ratio 2 up, linear in between", () => {
    expect(hazeOpacityFactor(1)).toBeCloseTo(0.6);
    expect(hazeOpacityFactor(1.5)).toBeCloseTo(0.8);
    expect(hazeOpacityFactor(2)).toBeCloseTo(1);
    expect(hazeOpacityFactor(5)).toBeCloseTo(1);
  });
  it("never leaves [0.6, 1] and is monotonic", () => {
    let prev = 0;
    for (let r = 0; r <= 4; r += 0.05) {
      const f = hazeOpacityFactor(r);
      expect(f).toBeGreaterThanOrEqual(0.6);
      expect(f).toBeLessThanOrEqual(1);
      expect(f).toBeGreaterThanOrEqual(prev);
      prev = f;
    }
  });
  it("missing haze (NaN / null) counts as dry, 0.6", () => {
    expect(hazeOpacityFactor(NaN)).toBeCloseTo(0.6);
    expect(hazeOpacityFactor(null)).toBeCloseTo(0.6);
  });
});

describe("resampleRowsToMercator", () => {
  const NX = 320, NY = 320, LAT0 = 6, LAT1 = 38, ROWS = PLUME_ROWS;
  const mercRow = (lat: number) =>
    Math.floor(((mercatorY(lat) - mercatorY(LAT0)) / (mercatorY(LAT1) - mercatorY(LAT0))) * ROWS);

  it.each([
    ["Delhi", 28.61, 77.21],
    ["Chennai", 13.08, 80.27],
    ["Srinagar", 34.08, 74.8],
  ])("a hot cell at %s is sampled by exactly the image row whose Mercator span holds the cell centre", (_name, lat, lon) => {
    const f = new Float32Array(NX * NY);
    const j = Math.floor((lat - LAT0) / 0.1);
    const i = Math.floor((lon - 66) / 0.1);
    f[j * NX + i] = 500;
    const out = resampleRowsToMercator(f, NX, NY, LAT0, LAT1, ROWS);
    expect(out.length).toBe(NX * ROWS);
    expect(ROWS).toBe(800);
    const centre = LAT0 + (j + 0.5) * 0.1;
    expect(out[mercRow(centre) * NX + i]).toBe(500);
    const hot: number[] = [];
    for (let r = 0; r < ROWS; r++) if (out[r * NX + i] === 500) hot.push(r);
    // the output row's centre latitude lies inside the source cell [j*0.1+6, (j+1)*0.1+6)
    for (const r of hot) {
      const y = mercatorY(LAT0) + ((r + 0.5) / ROWS) * (mercatorY(LAT1) - mercatorY(LAT0));
      const centreLat = (2 * Math.atan(Math.exp(y)) - Math.PI / 2) * (180 / Math.PI);
      expect(centreLat).toBeGreaterThanOrEqual(LAT0 + j * 0.1 - 1e-9);
      expect(centreLat).toBeLessThan(LAT0 + (j + 1) * 0.1 + 1e-9);
    }
  });

  it("differs from a linear-in-latitude placement mid-domain (the bug it fixes)", () => {
    const lat = 22.05;
    const linearRow = Math.floor(((lat - LAT0) / (LAT1 - LAT0)) * ROWS);
    expect(Math.abs(linearRow - mercRow(lat))).toBeGreaterThanOrEqual(3);
  });

  it("every source row appears (no row is skipped)", () => {
    const f = new Float32Array(NX * NY);
    for (let j = 0; j < NY; j++) f[j * NX] = j;
    const out = resampleRowsToMercator(f, NX, NY, LAT0, LAT1, ROWS);
    const seen = new Set<number>();
    for (let r = 0; r < ROWS; r++) seen.add(out[r * NX]);
    expect(seen.size).toBe(NY);
  });

  it("keeps a constant field constant", () => {
    const f = new Float32Array(NX * NY).fill(42);
    const out = resampleRowsToMercator(f, NX, NY, LAT0, LAT1, ROWS);
    expect(out.every((v) => v === 42)).toBe(true);
  });

  it("keeps NaN as NaN (no smearing into neighbours)", () => {
    const f = new Float32Array(NX * NY).fill(10);
    const j = 150;
    for (let i = 0; i < NX; i++) f[j * NX + i] = NaN;
    const out = resampleRowsToMercator(f, NX, NY, LAT0, LAT1, ROWS);
    let nanRows = 0;
    for (let r = 0; r < ROWS; r++) {
      if (Number.isNaN(out[r * NX])) nanRows++;
      else expect(out[r * NX]).toBe(10);
    }
    expect(nanRows).toBeGreaterThanOrEqual(1);
    expect(nanRows).toBeLessThanOrEqual(3);
  });
});
