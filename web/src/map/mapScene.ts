/**
 * Builds the deck.gl layer list from the store, once per animation frame, rebuilding each layer
 * only when its inputs changed. Returns null from `frame` when nothing changed, so React is not
 * re-rendered for nothing.
 *
 * Order, bottom to top: plume, wind, fires, path (all flat, beneath the India boundary lines and
 * basemap labels), user sources, cities (on top).
 */
import type { Layer } from "@deck.gl/core";
import type { Device, Texture } from "@luma.gl/core";
import { errorMessage, isAbort } from "../api/client";
import type { Fire, Meta } from "../api/types";
import type { Weights } from "../lib/compose";
import type { AppState, AppStore } from "../state/store";
import { LABEL_ALL_ZOOM, cityLabel, cityLayers, type CityDatum } from "./layers/cities";
import { fireLayers, prepareFires, windowData, type PreparedFires } from "./layers/fires";
import { pathFetchDue, pathLayer, type PathFetched } from "./layers/path";
import { PLUME_ROWS, colorizeInto, makeImageData, plumeLayer, type PlumeMode } from "./layers/plume";
import { PlumeComposer, playheadPair, type HourKey } from "./layers/plumeComposer";
import { userSourcesLayer } from "./layers/userSources";
import { WIND_PARTICLES, WIND_TRAIL_POINTS, WindCache, windLayer } from "./layers/wind";
import { WindParticles, type WindGrid } from "./layers/windField";

export interface SceneEnv {
  /** The map style is set up (boundary layers exist). */
  ready: boolean;
  /** Flat layers go beneath this map layer (our India state lines, which sit under the labels). */
  flatBeforeId: string | undefined;
  zoom: number;
  armedForDrop: boolean;
  device: Device | null;
}

/** The plume mode the store's toggles ask for; null when no plume is drawn. */
export function plumeModeOf(s: Pick<AppState, "layers" | "compareBaseline">): PlumeMode | null {
  if (s.compareBaseline) return "diff";
  if (s.layers.aqi) return "aqi";
  if (s.layers.pm25) return "pm25";
  return null;
}

const sameList = (a: readonly unknown[] | null, b: readonly unknown[]) =>
  a !== null && a.length === b.length && a.every((x, i) => Object.is(x, b[i]));

/** A layer (or layers) cached against the inputs it was built from. */
class Slot<T> {
  private deps: readonly unknown[] | null = null;
  value: T | null = null;
  /** Rebuild when `deps` changed; returns true if it did. */
  update(deps: readonly unknown[], build: () => T | null): boolean {
    if (sameList(this.deps, deps)) return false;
    this.deps = deps;
    this.value = build();
    return true;
  }
  reset(): void {
    this.deps = null;
    this.value = null;
  }
}

export class MapScene {
  private readonly store: AppStore;
  private readonly onProblem: (key: string, message: string | null) => void;

  private composer: PlumeComposer | null = null;
  private composerGrid: Meta["grid"] | null = null;
  private pixels: Uint8ClampedArray<ArrayBuffer> | null = null;
  private texture: Texture | null = null;
  private textureDevice: Device | null = null;
  private plumeVersion = 0;

  private firesSource: Fire[] | null = null;
  private fires: PreparedFires | null = null;

  private readonly wind: WindCache;
  private readonly particles = new WindParticles(WIND_PARTICLES, WIND_TRAIL_POINTS);
  private windGrid: WindGrid | null = null;

  private pathLast: PathFetched | null = null;
  private pathBuild: string | null = null;
  private pathAbort: AbortController | null = null;
  private pathPoints: [number, number][] | null = null;
  private pathVersion = 0;

  private readonly slots = {
    plume: new Slot<Layer>(),
    fires: new Slot<Layer[]>(),
    path: new Slot<Layer>(),
    users: new Slot<Layer>(),
    cityData: new Slot<CityDatum[]>(),
    cities: new Slot<Layer[]>(),
  };
  private windLayerNow: Layer | null = null;
  private last: Layer[] | null = null;

  constructor(store: AppStore, onProblem: (key: string, message: string | null) => void) {
    this.store = store;
    this.onProblem = onProblem;
    this.wind = new WindCache(
      (hour, signal) => {
        const runId = store.getState().runId;
        if (!runId) return Promise.reject(new Error("no run"));
        return store.client.getWind(runId, hour, signal);
      },
      () => this.onProblem("wind", null),
      (m) => this.onProblem("wind", m),
    );
  }

  dispose(): void {
    this.wind.dispose();
    this.pathAbort?.abort();
    this.texture?.destroy();
    this.texture = null;
  }

  /** Advance animations by `dt` seconds and return the new layer list, or null if unchanged. */
  frame(dt: number, env: SceneEnv): Layer[] | null {
    const s = this.store.getState();
    if (!env.ready || !s.meta) {
      if (this.last && this.last.length === 0) return null;
      this.last = [];
      return this.last;
    }
    const meta = s.meta;
    const x = s.hour;
    const h = Math.floor(x);
    const weights = s.weights();
    let changed = false;

    changed = this.updatePlume(s, meta, x, weights, env) || changed;
    const windNow = this.updateWind(s, meta, h, dt, env);
    changed = windNow !== this.windLayerNow || changed;
    this.windLayerNow = windNow;
    changed = this.updateFires(s, h, env) || changed;
    changed = this.updatePath(s, meta, x, env) || changed;
    changed = this.slots.users.update([s.userSources], () => userSourcesLayer(s.userSources)) || changed;
    changed = this.updateCities(s, meta, h, weights, env) || changed;

    if (!changed && this.last) return null;
    const list: Layer[] = [];
    const push = (l: Layer | Layer[] | null) => {
      if (Array.isArray(l)) list.push(...l);
      else if (l) list.push(l);
    };
    push(this.slots.plume.value);
    push(this.windLayerNow);
    push(this.slots.fires.value);
    push(this.slots.path.value);
    push(this.slots.users.value);
    push(this.slots.cities.value);
    this.last = list;
    return list;
  }

  // --- plume ---

  private updatePlume(s: AppState, meta: Meta, x: number, weights: Weights, env: SceneEnv): boolean {
    const mode = plumeModeOf(s);
    const baseline = mode === "diff" ? s.baselineWeights() : null;
    return this.slots.plume.update(
      [mode, x, s.frameVersion, weights, baseline, meta.build_id, meta.grid, env.device, env.flatBeforeId],
      () => {
        if (!mode) return null;
        try {
          const layer = this.drawPlume(meta, x, mode, weights, baseline, env);
          this.onProblem("plume", null);
          return layer;
        } catch (e) {
          this.onProblem("plume", `plume: ${errorMessage(e)}`);
          return null;
        }
      },
    );
  }

  private drawPlume(
    meta: Meta, x: number, mode: PlumeMode, weights: Weights, baseline: Weights | null,
    env: SceneEnv,
  ): Layer | null {
    const frames = this.store.frames;
    const { grid } = meta;
    if (this.composerGrid !== grid) {
      this.composer = new PlumeComposer(grid);
      this.composerGrid = grid;
      this.pixels = new Uint8ClampedArray(new ArrayBuffer(grid.nx * PLUME_ROWS * 4));
      this.texture?.destroy();
      this.texture = null;
    }
    const pair = playheadPair(x, meta.hours.length, (hh) => frames.get(hh) !== undefined);
    if (!pair) return null;
    const key = (hour: number): HourKey => ({
      hour, build: meta.build_id, frame: frames.get(hour)!, weights, baseline, mode, stale: frames.isStale(hour),
    });
    const a = this.composer!.get(key(pair.a));
    const b = pair.b === null ? null : this.composer!.get(key(pair.b));
    const px = this.pixels!;
    colorizeInto(px, grid.nx, PLUME_ROWS, mode, a.value, b?.value ?? null, pair.t, a.haze, b?.haze ?? null);
    this.plumeVersion++;
    const image = this.upload(px, grid.nx, env.device);
    return plumeLayer(image, this.plumeVersion, env.flatBeforeId);
  }

  /** Write the pixels into the one texture this scene owns (or, without a device yet, an ImageData). */
  private upload(px: Uint8ClampedArray<ArrayBuffer>, width: number, device: Device | null): Texture | ImageData {
    if (!device) return makeImageData(px, width, PLUME_ROWS);
    if (!this.texture || this.textureDevice !== device) {
      this.texture?.destroy();
      this.texture = device.createTexture({
        width, height: PLUME_ROWS, format: "rgba8unorm", mipLevels: 1,
        sampler: { minFilter: "linear", magFilter: "linear", addressModeU: "clamp-to-edge", addressModeV: "clamp-to-edge" },
      });
      this.textureDevice = device;
    }
    this.texture.writeData(px);
    return this.texture;
  }

  // --- wind ---

  private updateWind(s: AppState, meta: Meta, h: number, dt: number, env: SceneEnv): Layer | null {
    if (!s.layers.wind || !s.runId) {
      this.windGrid = null;
      return null;
    }
    const grid = this.wind.get(meta.build_id, h, meta.hours.length);
    if (grid) this.windGrid = grid; // until the next hour lands, keep flowing through the last one
    if (!this.windGrid) return null;
    this.particles.step(this.windGrid, dt);
    return windLayer(this.particles.segments(), env.flatBeforeId);
  }

  // --- fires ---

  private updateFires(s: AppState, h: number, env: SceneEnv): boolean {
    if (s.fires !== this.firesSource) {
      this.firesSource = s.fires;
      this.fires = s.fires ? prepareFires(s.fires) : null;
    }
    const on = s.layers.fires && this.fires !== null;
    return this.slots.fires.update([on, this.fires, h, env.flatBeforeId], () =>
      on ? fireLayers(windowData(this.fires!, h), env.flatBeforeId) : null,
    );
  }

  // --- back-trajectory path ---

  private updatePath(s: AppState, meta: Meta, x: number, env: SceneEnv): boolean {
    if (meta.build_id !== this.pathBuild) {
      this.pathBuild = meta.build_id;
      this.pathLast = null;
      this.pathPoints = null;
      this.pathVersion++;
    }
    const city = s.selectedCity;
    if (!city && (this.pathLast || this.pathPoints)) {
      this.pathAbort?.abort();
      this.pathLast = null;
      this.pathPoints = null;
      this.pathVersion++;
    }
    if (s.runId && pathFetchDue(this.pathLast, { city, hour: x, playing: s.playing })) {
      const hour = Math.floor(x);
      if (this.pathLast?.city !== city) {
        this.pathPoints = null; // never show another city's path
        this.pathVersion++;
      }
      this.pathLast = { city: city!, hour };
      this.fetchPath(s.runId, city!, hour);
    }
    return this.slots.path.update([this.pathVersion, env.flatBeforeId], () =>
      this.pathPoints && this.pathPoints.length > 1 ? pathLayer(this.pathPoints, env.flatBeforeId) : null,
    );
  }

  private fetchPath(runId: string, city: string, hour: number): void {
    this.pathAbort?.abort();
    const controller = (this.pathAbort = new AbortController());
    this.store.client.getPath(runId, city, hour, controller.signal).then(
      (points) => {
        if (controller.signal.aborted) return;
        this.pathPoints = points;
        this.pathVersion++;
        this.onProblem("path", null);
      },
      (e) => {
        if (controller.signal.aborted || isAbort(e)) return;
        this.pathPoints = null;
        this.pathVersion++;
        this.onProblem("path", `back-trajectory: ${errorMessage(e)}`);
      },
    );
  }

  // --- cities ---

  private updateCities(s: AppState, meta: Meta, h: number, weights: Weights, env: SceneEnv): boolean {
    this.slots.cityData.update([meta.cities, weights, h], () => {
      try {
        const data = meta.cities.map((city) => ({ city, label: cityLabel(city, h, weights) }));
        this.onProblem("cities", null);
        return data;
      } catch (e) {
        this.onProblem("cities", `city labels: ${errorMessage(e)}`);
        return [];
      }
    });
    const showAll = env.zoom >= LABEL_ALL_ZOOM;
    const select = this.store.getState().selectCity;
    return this.slots.cities.update([this.slots.cityData.value, s.selectedCity, showAll, env.armedForDrop], () =>
      cityLayers({
        data: this.slots.cityData.value ?? [],
        selected: s.selectedCity,
        zoom: env.zoom,
        pickable: !env.armedForDrop,
        onSelect: (id) => select(id),
      }),
    );
  }
}
