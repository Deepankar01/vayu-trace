/**
 * MapScene against a real store with its client calls stubbed (no MapLibre, no GPU): what it
 * draws and reports across a build change, while the plume waits, and when one city fails.
 */
import type { Layer } from "@deck.gl/core";
import { describe, expect, it, vi } from "vitest";
import type { WindField } from "../api/types";
import { makeMeta } from "../test-utils/meta";
import { testStore } from "../test-utils/panels";
import { MapScene, plumeModeOf, type SceneEnv } from "./mapScene";

const ENV: SceneEnv = {
  ready: true, flatBeforeId: undefined, zoom: 5, armedForDrop: false, device: null,
  project: null, viewVersion: 0,
};

const WIND: WindField = { step: 1, lon0: 66, lat0: 6, nx: 2, ny: 2, u: [1, 1, 1, 1], v: [0, 0, 0, 0] };

interface Pending<T> {
  signal: AbortSignal;
  resolve: (v: T) => void;
}

function setup() {
  const { store } = testStore({ selectedCity: "delhi", layers: { pm25: true, aqi: false, wind: true, fires: false, terrain: false } });
  const winds: (Pending<WindField> & { hour: number })[] = [];
  const paths: Pending<[number, number][]>[] = [];
  vi.spyOn(store.client, "getWind").mockImplementation(
    (_run, hour, signal) => new Promise((resolve) => winds.push({ hour, signal: signal!, resolve })),
  );
  vi.spyOn(store.client, "getPath").mockImplementation(
    (_run, _city, _hour, signal) => new Promise((resolve) => paths.push({ signal: signal!, resolve })),
  );
  const problems: Record<string, string | null> = {};
  const plumeWaits: (number | null)[] = [];
  const pathHours: (number | null)[] = [];
  const scene = new MapScene(
    store, (k, m) => (problems[k] = m), (h) => plumeWaits.push(h), (h) => pathHours.push(h),
  );
  let layers: Layer[] = [];
  const frame = () => {
    const next = scene.frame(0.016, ENV);
    if (next) layers = next;
    return layers.map((l) => l.id);
  };
  return { store, scene, winds, paths, problems, plumeWaits, pathHours, frame };
}

const flush = () => new Promise<void>((r) => setTimeout(r, 0));

describe("plumeModeOf", () => {
  const layers = (pm25: boolean, aqi: boolean) => ({ pm25, aqi, wind: true, fires: true, terrain: false });
  const mode = (pollutant: "pm25" | "pm10" | "coarse", pm25: boolean, aqi: boolean, compareBaseline = false) =>
    plumeModeOf({ layers: layers(pm25, aqi), compareBaseline, pollutant });
  it("PM2.5 is as before: concentration, AQI, difference, or nothing", () => {
    expect(mode("pm25", true, false)).toBe("pm25");
    expect(mode("pm25", false, true)).toBe("aqi");
    expect(mode("pm25", false, true, true)).toBe("diff");
    expect(mode("pm25", false, false)).toBeNull();
  });
  it("PM10 AQI uses the PM10 breakpoints; coarse PM has no AQI and falls back to concentration", () => {
    expect(mode("pm10", false, true)).toBe("aqi10");
    expect(mode("pm10", true, false)).toBe("pm25");
    expect(mode("coarse", false, true)).toBe("pm25");
    expect(mode("coarse", false, true, true)).toBe("diff");
    expect(mode("coarse", false, false)).toBeNull();
  });
});

describe("MapScene", () => {
  it("draws wind and the path for the current build, and drops both (aborting the path request) on a new build", async () => {
    const t = setup();
    t.frame();
    expect(t.paths).toHaveLength(1);
    t.winds.filter((w) => w.hour === 0).forEach((w) => w.resolve(WIND));
    t.paths[0].resolve([[77, 28], [76, 29]]);
    await flush();
    expect(t.frame()).toEqual(expect.arrayContaining(["wind", "back-trajectory"]));
    expect(t.pathHours.at(-1)).toBe(0);

    // a second path request in flight when the build changes
    t.store.getState().setHour(3);
    t.frame();
    expect(t.paths).toHaveLength(2);
    const winds1 = t.winds.length;
    t.store.setState({ meta: makeMeta({ build_id: "b2" }) });
    const ids = t.frame();
    expect(t.paths[1].signal.aborted).toBe(true);
    expect(ids).not.toContain("wind"); // never advected through the old build's wind
    expect(ids).not.toContain("back-trajectory");
    expect(t.pathHours.at(-1)).toBeNull();
    expect(t.winds.length).toBeGreaterThan(winds1); // b2's wind is requested
    expect(t.paths).toHaveLength(3); // and b2's path
    t.paths[1].resolve([[70, 20], [71, 21]]); // the old build's answer arrives late: ignored
    await flush();
    expect(t.frame()).not.toContain("back-trajectory");
  });

  it("reports the hour the plume waits for, and null once there is no plume to wait for", () => {
    const t = setup();
    t.store.getState().setHour(4.5);
    t.frame();
    expect(t.plumeWaits.at(-1)).toBe(4); // no frame cached: waiting for the playhead hour
    t.store.getState().setLayer("pm25", false);
    t.frame();
    expect(t.plumeWaits.at(-1)).toBeNull();
  });

  it("one city's failure is reported and does not blank the other cities", () => {
    const t = setup();
    const meta = makeMeta();
    meta.cities[1] = { ...meta.cities[1], by_tag: { ...meta.cities[1].by_tag, ghost_tag: meta.cities[1].fire_age_h } };
    t.store.setState({ meta });
    const ids = t.frame();
    expect(t.problems.cities).toMatch(/^city ludhiana: /);
    expect(ids).toContain("city-markers");
    const markers = (t.scene as unknown as { slots: { cityData: { value: { city: { id: string } }[] } } }).slots.cityData.value;
    expect(markers.map((d) => d.city.id)).toEqual(["delhi"]);
  });
});
