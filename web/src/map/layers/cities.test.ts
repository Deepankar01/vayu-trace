import type { CityMeta } from "../../api/types";
import { pm25ToAqi, rolling24h } from "../../lib/aqi";
import { aqiColor } from "../../lib/colors";
import { LABEL_ALL_ZOOM, cityLabel, fireSeries, showLabel } from "./cities";

const N = 48;
const flat = (v: number | null) => Array.from({ length: N }, () => v);

function city(over: Partial<CityMeta> = {}): CityMeta {
  return {
    id: "kanpur", name: "Kanpur", lat: 26.45, lon: 80.33, region: "uttar_pradesh",
    by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: flat(0) },
    fire_age_h: flat(null),
    met: { wind_ms: flat(2), wind_dir_deg: flat(270), rh: flat(0.5), temp_c: flat(20), blh_m: flat(500) },
    ...over,
  };
}
const W = { vehicles_uttar_pradesh: 1, fire_punjab: 1, firefc_punjab: 1 };

describe("cityLabel", () => {
  it("'arrives +9 h' when the weighted fire contribution first crosses 15 ug/m3 nine hours later", () => {
    const fire = flat(0);
    for (let h = 29; h < N; h++) fire[h] = 20;
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: fire } });
    const l = cityLabel(c, 20, W);
    expect(l.primary).toBe("Kanpur");
    expect(l.secondary).toBe("arrives +9 h");
  });

  it("'smoke present · 17 h old' when the fire contribution is at or above 15 now", () => {
    const age = flat(null);
    age[30] = 16.6;
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: flat(10), firefc_punjab: flat(5) }, fire_age_h: age });
    expect(cityLabel(c, 30, W).secondary).toBe("smoke present · 17 h old");
  });

  it("'smoke present' alone when the age is unknown", () => {
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: flat(40) } });
    expect(cityLabel(c, 30, W).secondary).toBe("smoke present");
  });

  it("plain AQI when the fire weight is 0, and the marker is coloured by that AQI", () => {
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: flat(80) } });
    const l = cityLabel(c, 30, { ...W, fire_punjab: 0 });
    const aqi = pm25ToAqi(rolling24h(flat(100), 30)!);
    expect(l.secondary).toBe(`AQI ${Math.round(aqi)}`);
    expect(l.aqi).toBeCloseTo(aqi);
    expect(l.color).toBe(aqiColor(aqi));
  });

  it("AQI uses the weighted total (fires included)", () => {
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(50), fire_punjab: flat(10) } });
    const l = cityLabel(c, 30, W);
    expect(l.secondary).toBe(`AQI ${Math.round(pm25ToAqi(60))}`);
  });

  it("'AQI –' and the mute colour while fewer than 16 hours are available", () => {
    const l = cityLabel(city(), 5, W);
    expect(l.secondary).toBe("AQI –");
    expect(l.aqi).toBeNull();
    expect(l.color).toBe(aqiColor(null));
  });

  it("missing totals give 'AQI –'", () => {
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(null), fire_punjab: flat(0) } });
    expect(cityLabel(c, 30, W).secondary).toBe("AQI –");
  });

  it("the last hour: no later crossing, so the AQI line", () => {
    const c = city();
    expect(cityLabel(c, N - 1, W).secondary).toMatch(/^AQI \d+$/);
  });

  it("a fractional hour is floored", () => {
    const fire = flat(0);
    fire[21] = 30;
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: fire } });
    expect(cityLabel(c, 20.9, W).secondary).toBe("arrives +1 h");
  });
});

describe("fireSeries", () => {
  it("sums fire_* and firefc_* tags with weights; null where a contributing tag is null", () => {
    const a = flat(5);
    a[3] = null;
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: a, firefc_punjab: flat(2) } });
    const s = fireSeries(c, { ...W, firefc_punjab: 2 });
    expect(s[0]).toBe(9);
    expect(s[3]).toBeNull();
  });
  it("skips tags of weight 0 entirely", () => {
    const c = city({ by_tag: { vehicles_uttar_pradesh: flat(100), fire_punjab: flat(null) } });
    expect(fireSeries(c, { ...W, fire_punjab: 0 }).every((v) => v === 0)).toBe(true);
  });
});

describe("showLabel", () => {
  it("shows only priority cities below the declutter zoom, all from it", () => {
    expect(showLabel("delhi", 4.6)).toBe(true);
    expect(showLabel("gurugram", 4.6)).toBe(false);
    expect(showLabel("gurugram", LABEL_ALL_ZOOM)).toBe(true);
    expect(LABEL_ALL_ZOOM).toBe(5.5);
  });
});
