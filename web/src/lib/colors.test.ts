import { aqiColor, pm25Ramp, TAG_COLORS } from "./colors";

describe("pm25Ramp", () => {
  it("is transparent at or below 5 ug/m3", () => {
    expect(pm25Ramp(0)[3]).toBe(0);
    expect(pm25Ramp(5)[3]).toBe(0);
    expect(pm25Ramp(-3)[3]).toBe(0);
    expect(pm25Ramp(NaN)[3]).toBe(0);
  });

  it("alpha never decreases from 0 to 600 and reaches ~215 at 400", () => {
    let prev = -1;
    for (let v = 0; v <= 600; v += 5) {
      const a = pm25Ramp(v)[3];
      expect(a).toBeGreaterThanOrEqual(prev);
      prev = a;
    }
    expect(pm25Ramp(400)[3]).toBe(215);
    expect(pm25Ramp(600)[3]).toBe(215);
  });

  it("saturates at the 400+ colour for Infinity", () => {
    expect(pm25Ramp(Infinity)).toEqual([0x5a, 0x0f, 0x1c, 215]);
  });

  it("returns integer channels in 0..255", () => {
    for (let v = 0; v <= 600; v += 7) {
      for (const c of pm25Ramp(v)) {
        expect(Number.isInteger(c)).toBe(true);
        expect(c).toBeGreaterThanOrEqual(0);
        expect(c).toBeLessThanOrEqual(255);
      }
    }
  });

  it("hits the stop colours exactly", () => {
    expect(pm25Ramp(60).slice(0, 3)).toEqual([0xff, 0x8a, 0x3d]);
    expect(pm25Ramp(120).slice(0, 3)).toEqual([0xff, 0x5a, 0x2b]);
    expect(pm25Ramp(250).slice(0, 3)).toEqual([0xb3, 0x20, 0x2a]);
    expect(pm25Ramp(400).slice(0, 3)).toEqual([0x5a, 0x0f, 0x1c]);
    expect(pm25Ramp(900).slice(0, 3)).toEqual([0x5a, 0x0f, 0x1c]);
  });

  it("starts at pale amber just above 5", () => {
    expect(pm25Ramp(5.01).slice(0, 3)).toEqual([0xff, 0xd9, 0xa8]);
  });
});

describe("aqiColor", () => {
  it("uses CPCB category colours at each boundary", () => {
    expect(aqiColor(50)).toBe("#5fd38d");
    expect(aqiColor(51)).toBe("#b6d96a");
    expect(aqiColor(100)).toBe("#b6d96a");
    expect(aqiColor(101)).toBe("#f2d15c");
    expect(aqiColor(200)).toBe("#f2d15c");
    expect(aqiColor(201)).toBe("#ff8a3d");
    expect(aqiColor(300)).toBe("#ff8a3d");
    expect(aqiColor(301)).toBe("#ff5a5a");
    expect(aqiColor(400)).toBe("#ff5a5a");
    expect(aqiColor(401)).toBe("#b3202a");
    expect(aqiColor(450)).toBe("#b3202a");
  });

  it("rounds to the nearest integer before banding", () => {
    expect(aqiColor(50.4)).toBe("#5fd38d");
    expect(aqiColor(50.5)).toBe("#b6d96a");
    expect(aqiColor(100.4)).toBe("#b6d96a");
    expect(aqiColor(100.5)).toBe("#f2d15c");
  });

  it("treats negative as invalid grey, Infinity as Severe, zero as Good", () => {
    expect(aqiColor(-1)).toBe("#8b93a5");
    expect(aqiColor(-0.4)).toBe("#8b93a5");
    expect(aqiColor(0)).toBe("#5fd38d");
    expect(aqiColor(Infinity)).toBe("#b3202a");
  });

  it("is mute grey for missing values", () => {
    expect(aqiColor(null)).toBe("#8b93a5");
    expect(aqiColor(NaN)).toBe("#8b93a5");
    expect(aqiColor(undefined)).toBe("#8b93a5");
  });
});

describe("TAG_COLORS", () => {
  it("matches the brief", () => {
    expect(TAG_COLORS).toMatchObject({
      fires: "#ff5a2b",
      vehicles: "#6aa8ff",
      industry: "#b98cff",
      dust: "#e0b45a",
      residential: "#5fd3c4",
      unexplained: "#5b6475",
      user: "#9aa3b5",
    });
  });
});
