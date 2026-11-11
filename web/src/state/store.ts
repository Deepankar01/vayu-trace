/**
 * Application state (zustand): the run lifecycle, playback, scenario controls and per-city
 * side data. No timers for playback live here (a later task drives `tick` from
 * requestAnimationFrame); the only timer is the 1 s run-status poll. Failures become strings in
 * `error` (run) / `frameError` / `sourceError` / `firesError` / per-city `error`; nothing is
 * thrown into React.
 */
import { create } from "zustand";
import { ApiClient, ApiError, errorMessage, isAbort } from "../api/client";
import { FrameCache } from "../api/frameCache";
import type { Fire, Meta, Sector, SourceRequest } from "../api/types";
import type { Weights } from "../lib/compose";
import {
  DEFAULT_SLIDERS, FIRE_SCALING_RANGE, NO_SCENARIO, SLIDER_RANGE, isFireAssumedHour, isForecastHour,
  selectBaselineWeights, selectWeights, type RegionScenario, type Sliders,
} from "./weights";

export type RunPhase = "idle" | "running" | "loading" | "ready" | "error";
export type Speed = 1 | 2 | 4 | 8;
export const SPEEDS: readonly Speed[] = [1, 2, 4, 8];
export const POLL_INTERVAL_MS = 1000;
export const REFRESH_NOTICE = "Run refreshed; added sources were removed";
export const RUN_LOST = "run not found; start again";

export interface Layers {
  pm25: boolean;
  aqi: boolean;
  wind: boolean;
  fires: boolean;
  terrain: boolean;
}

export interface UserSource {
  id: string;
  label: string;
  color: string;
  enabled: boolean;
  /** What the user asked for; null for sources restored from the server's meta. */
  spec: SourceRequest | null;
}

/** Measured (CPCB via OpenAQ) or CAMS data for one city; CAMS leaves the measured-only fields null. */
export interface CityDataState {
  status: "idle" | "loading" | "ready" | "error";
  values: (number | null)[] | null;
  stationCount: number | null;
  live: number | null;
  liveError: string | null;
  error: string | null;
}

export const IDLE_CITY_DATA: CityDataState = {
  status: "idle", values: null, stationCount: null, live: null, liveError: null, error: null,
};

export interface AppState {
  runId: string | null;
  status: RunPhase;
  progress: number;
  stage: string;
  error: string | null;
  meta: Meta | null;
  fires: Fire[] | null;
  firesError: string | null;

  /** Playhead in hours since the run start (float); frame index = floor(hour). */
  hour: number;
  playing: boolean;
  /** Hours of simulation per second of wall time. */
  speed: Speed;

  layers: Layers;
  sliders: Sliders;
  fireScaling: number;
  firesContinue: boolean;
  regionScenario: RegionScenario;
  userSources: UserSource[];
  selectedCity: string | null;
  compareBaseline: boolean;

  measured: Record<string, CityDataState>;
  cams: Record<string, CityDataState>;

  /** Bumped whenever the frame cache changes, so views know to recompose. */
  frameVersion: number;
  frameError: string | null;
  sourceError: string | null;
  /** A short message for the UI (e.g. the run was refreshed and added sources were removed). */
  notice: string | null;

  startRun: (date: string) => Promise<void>;
  clearNotice: () => void;
  setHour: (h: number) => void;
  togglePlay: () => void;
  setSpeed: (s: Speed) => void;
  tick: (dtSeconds: number) => void;
  setLayer: (name: keyof Layers, on: boolean) => void;
  setSlider: (sector: Sector, value: number) => void;
  setFireScaling: (v: number) => void;
  setFiresContinue: (on: boolean) => void;
  setRegionScenario: (key: keyof RegionScenario, on: boolean) => void;
  setCompareBaseline: (on: boolean) => void;
  toggleUserSource: (id: string) => void;
  addSource: (req: SourceRequest) => Promise<void>;
  /** Sliders, fire scaling, fires-continue and the Delhi scenarios back to the baseline values.
   *  Added sources and their on/off state are left alone. */
  resetScenario: () => void;
  selectCity: (id: string | null) => void;

  weights: () => Weights;
  baselineWeights: () => Weights;
  isForecastHour: (h: number) => boolean;
  isFireAssumedHour: (h: number) => boolean;
}

export interface StoreDeps {
  fetch?: typeof fetch;
  baseUrl?: string;
}

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

export function createAppStore(deps: StoreDeps = {}) {
  let runToken = 0; // a newer startRun invalidates everything older
  let runAbort: AbortController | null = null;
  let pollTimer: ReturnType<typeof setTimeout> | null = null;
  let cityAbort: AbortController | null = null;
  let rebuilding: Promise<void> | null = null;
  let client!: ApiClient; // assigned by the (synchronous) state initialiser below
  let frames!: FrameCache;

  const useStore = create<AppState>()((set, get) => {
    const lastHour = () => Math.max(0, (get().meta?.hours.length ?? 1) - 1);
    const enabledUserTags = () => get().userSources.filter((u) => u.enabled).map((u) => u.id);

    client = new ApiClient({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl,
      getBuild: () => get().meta?.build_id ?? null,
      onRebuilt: (newBuild) => rebuild(newBuild),
    });

    frames = new FrameCache({
      fetchFrame: (hour, extras, signal) => {
        const runId = get().runId;
        if (!runId) return Promise.reject(new Error("no run"));
        return client.getFrame(runId, hour, extras, signal);
      },
      onChange: () => set((s) => ({ frameVersion: s.frameVersion + 1 })),
      onError: (hour, e) => set({ frameError: `frame for hour ${hour}: ${errorMessage(e)}` }),
    });

    const userSourcesFrom = (meta: Meta, previous: UserSource[]): UserSource[] =>
      meta.tags
        .filter((t) => t.kind === "user")
        .map((t) => {
          const old = previous.find((u) => u.id === t.id);
          return { id: t.id, label: t.label, color: t.color, enabled: old?.enabled ?? true, spec: old?.spec ?? null };
        });

    /** Install a meta: user sources, playhead clamp, frame window. */
    const applyMeta = (meta: Meta, keepUserState: boolean) => {
      const hour = clamp(get().hour, 0, Math.max(0, meta.hours.length - 1));
      set((s) => ({
        meta, hour,
        userSources: userSourcesFrom(meta, keepUserState ? s.userSources : []),
        frameError: null,
      }));
      frames.configure(meta.hours.length);
      frames.setExtras(enabledUserTags());
      frames.setCentre(hour);
    };

    const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

    /**
     * The single 409 path (single flight). Run rebuilt (`newBuild` a string): drop cached frames,
     * refetch meta. Run expired or gone (null): drop frames, POST the run again, poll until it is
     * ready, then refetch meta. Added sources belong to a build, so they are cleared either way
     * (meta carries the new build's) and `notice` says so.
     */
    function rebuild(newBuild: string | null): Promise<void> {
      if (rebuilding) return rebuilding;
      const runId = get().runId;
      rebuilding = (async () => {
        try {
          if (!runId) throw new Error("no run");
          frames.clear();
          if (newBuild === null) {
            await client.postRun(runId);
            for (;;) {
              const st = await client.getRunStatus(runId);
              if (st.status === "ready") break;
              if (st.status === "error") throw new Error(st.error ?? "the run failed");
              set({ progress: st.progress, stage: st.stage });
              await sleep(POLL_INTERVAL_MS);
            }
          }
          applyMeta(await client.getMeta(runId), false);
          set({ notice: REFRESH_NOTICE });
        } finally {
          rebuilding = null;
        }
      })();
      return rebuilding;
    }

    // --- run lifecycle ---

    const stale = (token: number) => token !== runToken;

    const fail = (token: number, message: string) => {
      if (stale(token)) return;
      set({ status: "error", error: message });
    };

    const clearPoll = () => {
      if (pollTimer) clearTimeout(pollTimer);
      pollTimer = null;
    };

    async function loadMeta(token: number, runId: string, signal: AbortSignal) {
      set({ status: "loading", progress: 1, stage: "loading results" });
      const meta = await client.getMeta(runId, signal);
      if (stale(token)) return;
      applyMeta(meta, false);
      set({ status: "ready", error: null, fireScaling: meta.notes.fire_scaling_default });
      const city = get().selectedCity;
      if (city) fetchCityData(city);
      client.getFires(runId, signal).then(
        (fires) => !stale(token) && set({ fires, firesError: null }),
        (e) => !stale(token) && !isAbort(e) && set({ firesError: errorMessage(e) }),
      );
    }

    async function pollOnce(token: number, runId: string, signal: AbortSignal) {
      try {
        const st = await client.getRunStatus(runId, signal);
        if (stale(token)) return;
        if (st.status === "running") {
          set({ progress: st.progress, stage: st.stage });
          pollTimer = setTimeout(() => void pollOnce(token, runId, signal), POLL_INTERVAL_MS);
        } else if (st.status === "ready") {
          await loadMeta(token, runId, signal);
        } else {
          fail(token, st.error ?? "the run failed");
        }
      } catch (e) {
        if (isAbort(e)) return;
        fail(token, e instanceof ApiError && e.status === 404 ? RUN_LOST : errorMessage(e));
      }
    }

    // --- per-city measured / CAMS ---

    const setCityData = (kind: "measured" | "cams", id: string, data: CityDataState) =>
      set((s) => ({ [kind]: { ...s[kind], [id]: data } }) as Pick<AppState, typeof kind>);

    /** Back out of loading states when a city's requests are abandoned. */
    const resetLoading = () =>
      set((s) => {
        const undo = (m: Record<string, CityDataState>) =>
          Object.fromEntries(Object.entries(m).map(([k, v]) => [k, v.status === "loading" ? IDLE_CITY_DATA : v]));
        return { measured: undo(s.measured), cams: undo(s.cams) };
      });

    function abortCity() {
      cityAbort?.abort();
      cityAbort = null;
      resetLoading();
    }

    function fetchCityData(id: string) {
      const runId = get().runId;
      if (!runId || !get().meta) return;
      if (!cityAbort) cityAbort = new AbortController();
      const controller = cityAbort;
      const live = () => cityAbort === controller && !controller.signal.aborted;
      const needs = (kind: "measured" | "cams") => {
        const st = get()[kind][id]?.status ?? "idle";
        return st === "idle" || st === "error";
      };

      if (needs("measured")) {
        setCityData("measured", id, { ...IDLE_CITY_DATA, status: "loading" });
        client.getMeasured(runId, id, controller.signal).then(
          (r) =>
            live() &&
            setCityData("measured", id, {
              status: "ready", values: r.values, stationCount: r.station_count, live: r.live,
              liveError: r.live_error, error: null,
            }),
          (e) => live() && setCityData("measured", id, { ...IDLE_CITY_DATA, status: "error", error: errorMessage(e) }),
        );
      }
      if (needs("cams")) {
        setCityData("cams", id, { ...IDLE_CITY_DATA, status: "loading" });
        client.getCams(runId, id, controller.signal).then(
          (r) => live() && setCityData("cams", id, { ...IDLE_CITY_DATA, status: "ready", values: r.values }),
          (e) => live() && setCityData("cams", id, { ...IDLE_CITY_DATA, status: "error", error: errorMessage(e) }),
        );
      }
    }

    return {
      runId: null, status: "idle", progress: 0, stage: "", error: null,
      meta: null, fires: null, firesError: null,
      hour: 0, playing: false, speed: 1,
      layers: { pm25: true, aqi: false, wind: false, fires: true, terrain: false },
      sliders: { ...DEFAULT_SLIDERS }, fireScaling: 1, firesContinue: true,
      regionScenario: { ...NO_SCENARIO }, userSources: [], selectedCity: null, compareBaseline: false,
      measured: {}, cams: {}, frameVersion: 0, frameError: null, sourceError: null, notice: null,

      startRun: async (date) => {
        const token = ++runToken;
        clearPoll();
        runAbort?.abort();
        abortCity();
        frames.dispose();
        const controller = (runAbort = new AbortController());
        set({
          runId: null, status: "running", progress: 0, stage: "starting", error: null,
          meta: null, fires: null, firesError: null, hour: 0, playing: false,
          sliders: { ...DEFAULT_SLIDERS }, fireScaling: 1, firesContinue: true,
          regionScenario: { ...NO_SCENARIO }, userSources: [], compareBaseline: false,
          measured: {}, cams: {}, frameError: null, sourceError: null, notice: null,
        });
        try {
          const res = await client.postRun(date, controller.signal);
          if (stale(token)) return;
          set({ runId: res.run_id });
          if (res.status === "ready") await loadMeta(token, res.run_id, controller.signal);
          else await pollOnce(token, res.run_id, controller.signal);
        } catch (e) {
          if (!isAbort(e)) fail(token, errorMessage(e));
        }
      },

      clearNotice: () => set({ notice: null }),
      setHour: (h) => {
        if (!Number.isFinite(h)) return;
        const hour = clamp(h, 0, lastHour());
        set({ hour });
        frames.setCentre(hour);
      },
      togglePlay: () => {
        const s = get();
        if (!s.meta) return;
        if (s.playing) return set({ playing: false });
        // pressing play on the last hour starts over; there is no automatic wrap
        const hour = s.hour >= lastHour() ? 0 : s.hour;
        set({ playing: true, hour });
        frames.setCentre(hour);
      },
      setSpeed: (speed) => set({ speed }),
      tick: (dt) => {
        const s = get();
        if (!s.playing || !s.meta || !(dt > 0)) return;
        const end = lastHour();
        const next = s.hour + dt * s.speed;
        if (next >= end) {
          set({ hour: end, playing: false });
          frames.setCentre(end);
        } else {
          set({ hour: next });
          frames.setCentre(next);
        }
      },

      setLayer: (name, on) => set((s) => ({ layers: { ...s.layers, [name]: on } })),
      setSlider: (sector, value) =>
        set((s) => ({ sliders: { ...s.sliders, [sector]: clamp(value, SLIDER_RANGE.min, SLIDER_RANGE.max) } })),
      setFireScaling: (v) => set({ fireScaling: clamp(v, FIRE_SCALING_RANGE.min, FIRE_SCALING_RANGE.max) }),
      setFiresContinue: (on) => set({ firesContinue: on }),
      setRegionScenario: (key, on) => set((s) => ({ regionScenario: { ...s.regionScenario, [key]: on } })),
      setCompareBaseline: (on) => set({ compareBaseline: on }),
      toggleUserSource: (id) => {
        set((s) => ({ userSources: s.userSources.map((u) => (u.id === id ? { ...u, enabled: !u.enabled } : u)) }));
        frames.setExtras(enabledUserTags());
      },
      resetScenario: () =>
        set((s) => ({
          sliders: { ...DEFAULT_SLIDERS }, firesContinue: true, regionScenario: { ...NO_SCENARIO },
          fireScaling: s.meta?.notes.fire_scaling_default ?? 1,
        })),

      addSource: async (req) => {
        const runId = get().runId;
        const token = runToken;
        if (!runId) return;
        set({ sourceError: null });
        try {
          const res = await client.postSource(runId, req);
          if (stale(token)) return;
          const meta = get().meta;
          if (!meta) return;
          const { id, label, color } = res.tag;
          const cities = meta.cities.map((c) => {
            const series = res.by_city[c.id];
            return series?.some((v) => v) ? { ...c, by_tag: { ...c.by_tag, [id]: series } } : c;
          });
          set((s) => ({
            meta: { ...meta, cities, tags: [...meta.tags, { id, kind: "user", sector: null, region: null, label, color }] },
            userSources: [...s.userSources, { id, label, color, enabled: true, spec: req }],
          }));
          frames.setExtras(enabledUserTags());
        } catch (e) {
          if (!isAbort(e)) set({ sourceError: errorMessage(e) });
        }
      },

      selectCity: (id) => {
        if (id !== get().selectedCity) abortCity();
        set({ selectedCity: id });
        if (id) fetchCityData(id);
      },

      weights: () => selectWeights(get()),
      baselineWeights: () => selectBaselineWeights(get()),
      isForecastHour: (h) => isForecastHour(get().meta, h),
      isFireAssumedHour: (h) => isFireAssumedHour(get().meta, h),
    };
  });

  return Object.assign(useStore, { client, frames });
}

export type AppStore = ReturnType<typeof createAppStore>;

/** The app-wide store. */
export const useStore = createAppStore();
