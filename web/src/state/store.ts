/**
 * Application state (zustand): the run lifecycle, playback, scenario controls and per-city
 * side data. No timers for playback live here (`useMapAnimation` drives `tick` from
 * requestAnimationFrame); the only timer is the 1 s run-status poll. Failures become strings in
 * `error` (run) / `frameError` / `sourceError` / `firesError` / per-city `error`; nothing is
 * thrown into React.
 */
import { create } from "zustand";
import { ApiClient, ApiError, errorMessage, isAbort } from "../api/client";
import { HAZE } from "../api/decode";
import { FrameCache } from "../api/frameCache";
import type { Fire, Meta, Sector, SourceRequest } from "../api/types";
import type { Weights } from "../lib/compose";
import { useDropStore } from "../map/dropStore";
import { initialHour } from "../panels/initialHour";
import {
  DEFAULT_SLIDERS, FIRE_SCALING_RANGE, NO_SCENARIO, SLIDER_RANGE, createWeightSelectors, isFireAssumedHour,
  isForecastHour, type RegionScenario, type Sliders,
} from "./weights";

export type RunPhase = "idle" | "running" | "loading" | "ready" | "error";
export type Speed = 1 | 2 | 4 | 8;
export const SPEEDS: readonly Speed[] = [1, 2, 4, 8];
export const POLL_INTERVAL_MS = 1000;
export const REFRESH_NOTICE = "Run refreshed";
export const REFRESH_NOTICE_SOURCES = "Run refreshed; added sources were removed";
export const REFRESH_NOTICE_DIALOG = "; the add-source dialog was closed";
export const MAX_AUTO_REBUILDS = 2;
export const REBUILD_LOOP = "The run keeps being rebuilt on the server; start the run again.";
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
  /** Where and when the source is: what the user asked for, or for sources restored after a
   *  reload what the server stored (null only if the server sent none). */
  spec: SourceRequest | null;
}

/** Measured (CPCB via OpenAQ) or CAMS data for one city; CAMS leaves the measured-only fields null. */
export interface CityDataState {
  status: "idle" | "loading" | "ready" | "error";
  values: (number | null)[] | null;
  stationCount: number | null;
  error: string | null;
}

export const IDLE_CITY_DATA: CityDataState = {
  status: "idle", values: null, stationCount: null, error: null,
};

/**
 * The playhead for a new build of the same date: the same instant (`hours[floor(h)]`, keeping the
 * fraction) if the new window has it, else the initial-hour rule. A "today" window moves by a day
 * at UTC midnight, so keeping the index would silently jump a day.
 */
export function remapHour(oldHours: readonly string[] | undefined, h: number, meta: Meta): number {
  const i = Math.floor(h);
  const instant = oldHours?.[i];
  const at = instant === undefined ? -1 : meta.hours.findIndex((t) => Date.parse(t) === Date.parse(instant));
  return at >= 0 ? at + (h - i) : initialHour(meta);
}

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
  /** Bumped on every frame failure, so views can ask `frames.gaveUp(hour)` again. */
  frameFailures: number;
  sourceError: string | null;
  /** A short message for the UI (e.g. the run was refreshed and added sources were removed). */
  notice: string | null;

  startRun: (date: string) => Promise<void>;
  clearNotice: () => void;
  /** Move the playhead (a seek): an hour the frame cache gave up on is tried again. */
  setHour: (h: number) => void;
  /** Fetch an hour the frame cache gave up on again, with a fresh set of attempts. */
  retryHour: (h: number) => void;
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
  /** Remove an added source on the server, then from meta, city series and the frame cache. */
  removeSource: (id: string) => Promise<void>;
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
  let rebuilding: { token: number; promise: Promise<void> } | null = null;
  let autoRebuilds = 0; // consecutive 409 rebuilds with no frame loaded in between
  const selectors = createWeightSelectors();
  let client!: ApiClient; // assigned by the (synchronous) state initialiser below
  let frames!: FrameCache;

  const useStore = create<AppState>()((set, get) => {
    const lastHour = () => Math.max(0, (get().meta?.hours.length ?? 1) - 1);
    const enabledUserTags = () => get().userSources.filter((u) => u.enabled).map((u) => u.id);

    client = new ApiClient({
      fetch: deps.fetch,
      baseUrl: deps.baseUrl,
      getBuild: () => get().meta?.build_id ?? null,
      onRebuilt: (newBuild, sent) => rebuild(newBuild, sent),
    });

    frames = new FrameCache({
      fetchFrame: (hour, extras, signal) => {
        const runId = get().runId;
        if (!runId) return Promise.reject(new Error("no run"));
        return client.getFrame(runId, hour, extras, signal).then((frame) => {
          const known = new Set(get().meta?.tags.map((t) => t.id));
          for (const id of frame.tags.keys()) {
            if (id !== HAZE && !known.has(id)) throw new Error(`frame has tag '${id}' that the run's meta does not list`);
          }
          return frame;
        });
      },
      onChange: () => set((s) => ({ frameVersion: s.frameVersion + 1 })),
      onFrame: () => {
        autoRebuilds = 0;
        if (get().frameError !== null) set({ frameError: null });
      },
      onError: (hour, e) =>
        set((s) => ({ frameError: `frame for hour ${hour}: ${errorMessage(e)}`, frameFailures: s.frameFailures + 1 })),
    });

    const userSourcesFrom = (meta: Meta, previous: UserSource[]): UserSource[] =>
      meta.tags
        .filter((t) => t.kind === "user")
        .map((t) => {
          const old = previous.find((u) => u.id === t.id);
          return { id: t.id, label: t.label, color: t.color, enabled: old?.enabled ?? true, spec: old?.spec ?? t.source ?? null };
        });

    /** Install a meta: user sources, playhead clamp, frame window. */
    const applyMeta = (meta: Meta, keepUserState: boolean) => {
      const known = new Set(meta.tags.map((t) => t.id));
      const orphan = meta.cities.flatMap((c) => Object.keys(c.by_tag)).find((id) => !known.has(id));
      if (orphan) set({ error: `city series has tag '${orphan}' that the run's meta does not list` });
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

    const abortError = () => new DOMException("run superseded", "AbortError");

    /**
     * The single 409 path (single flight per run). `sentBuild` is the build the failed request
     * carried: the event is ignored when that is no longer the current build (a late 409 for an
     * already superseded build) or when `newBuild` is the current build. Run rebuilt (`newBuild`
     * a string): drop cached frames, refetch meta. Run expired or gone (null): drop frames, POST
     * the run again, poll until ready, then refetch meta. Added sources belong to a build, so
     * they are cleared either way and `notice` says so; fires are refetched (per build). While it
     * runs status is "running"; a failure lands in `error`. At most MAX_AUTO_REBUILDS in a row.
     * Everything is tied to the run token: starting another run abandons it.
     */
    function rebuild(newBuild: string | null, sentBuild: string): Promise<void> {
      const token = runToken;
      const runId = get().runId;
      const current = get().meta?.build_id ?? null;
      if (!runId || sentBuild !== current || (newBuild !== null && newBuild === current)) return Promise.resolve();
      if (rebuilding && rebuilding.token === token) return rebuilding.promise;
      if (autoRebuilds >= MAX_AUTO_REBUILDS) {
        set({ status: "error", error: REBUILD_LOOP });
        return Promise.reject(new Error(REBUILD_LOOP));
      }
      autoRebuilds++;
      const signal = runAbort?.signal;
      const checked = <T,>(v: T): T => {
        if (stale(token)) throw abortError();
        return v;
      };
      const mine: { token: number; promise: Promise<void> } = { token, promise: Promise.resolve() };
      mine.promise = (async () => {
          try {
            set({ status: "running", stage: "refreshing run", progress: 0, error: null });
            frames.clear();
            if (newBuild === null) {
              checked(await client.postRun(runId, signal));
              for (;;) {
                const st = checked(await client.getRunStatus(runId, signal));
                if (st.status === "ready") break;
                if (st.status === "error") throw new Error(st.error ?? "the run failed");
                set({ progress: st.progress, stage: st.stage });
                await sleep(POLL_INTERVAL_MS);
                checked(undefined);
              }
            }
            const meta = checked(await client.getMeta(runId, signal));
            // the old build's per-city data and in-flight requests belong to the old window
            abortCity();
            const old = get();
            const hadSources = old.userSources.length > 0;
            set({ hour: remapHour(old.meta?.hours, old.hour, meta), measured: {}, cams: {} });
            applyMeta(meta, false);
            // a pending drop dialog's start hour indexes the old window: close it
            const drop = useDropStore.getState();
            const hadDialog = drop.pending !== null || drop.armedForDrop;
            if (hadDialog) useDropStore.setState({ pending: null, armedForDrop: false, busy: false });
            const notice = (hadSources ? REFRESH_NOTICE_SOURCES : REFRESH_NOTICE) + (hadDialog ? REFRESH_NOTICE_DIALOG : "");
            set({ status: "ready", notice, fires: null });
            loadFires(token, runId, signal);
            const city = get().selectedCity;
            if (city) fetchCityData(city);
          } catch (e) {
            if (!stale(token) && !isAbort(e)) set({ status: "error", error: errorMessage(e) });
            throw e;
          } finally {
            if (rebuilding === mine) rebuilding = null;
          }
        })();
      rebuilding = mine;
      return mine.promise;
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
      set({ status: "ready", error: null, fireScaling: meta.notes.fire_scaling_default });
      applyMeta(meta, false); // may set `error` (inconsistent meta), so it comes last
      const city = get().selectedCity;
      if (city) fetchCityData(city);
      loadFires(token, runId, signal);
    }

    function loadFires(token: number, runId: string, signal?: AbortSignal) {
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
            setCityData("measured", id, { status: "ready", values: r.values, stationCount: r.station_count, error: null }),
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
      layers: { pm25: true, aqi: false, wind: true, fires: true, terrain: false },
      sliders: { ...DEFAULT_SLIDERS }, fireScaling: 1, firesContinue: true,
      regionScenario: { ...NO_SCENARIO }, userSources: [], selectedCity: null, compareBaseline: false,
      measured: {}, cams: {}, frameVersion: 0, frameError: null, frameFailures: 0, sourceError: null, notice: null,

      startRun: async (date) => {
        const token = ++runToken;
        clearPoll();
        runAbort?.abort();
        autoRebuilds = 0;
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
        if (frames.gaveUp(Math.floor(hour))) frames.retry(Math.floor(hour));
      },
      retryHour: (h) => frames.retry(Math.floor(h)),
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
            return series && !series.every((v) => v === 0) ? { ...c, by_tag: { ...c.by_tag, [id]: series } } : c;
          });
          set((s) => ({
            meta: { ...meta, cities, tags: [...meta.tags, { id, kind: "user", sector: null, region: null, label, color, source: req }] },
            userSources: [...s.userSources, { id, label, color, enabled: true, spec: req }],
          }));
          frames.setExtras(enabledUserTags());
        } catch (e) {
          if (!isAbort(e)) set({ sourceError: errorMessage(e) });
        }
      },

      removeSource: async (id) => {
        const runId = get().runId;
        const token = runToken;
        if (!runId) return;
        set({ sourceError: null });
        try {
          await client.deleteSource(runId, id);
        } catch (e) {
          // 404: the server no longer has it, so dropping it here is still right
          if (!(e instanceof ApiError && e.status === 404)) {
            if (!isAbort(e)) set({ sourceError: errorMessage(e) });
            return;
          }
        }
        if (stale(token)) return;
        const meta = get().meta;
        if (!meta) return;
        // cached frames carry the tag, which would have no weight once meta drops it
        frames.clear();
        const cities = meta.cities.map((c) => {
          if (!(id in c.by_tag)) return c;
          const { [id]: _gone, ...rest } = c.by_tag;
          void _gone;
          return { ...c, by_tag: rest };
        });
        set((s) => ({
          meta: { ...meta, cities, tags: meta.tags.filter((t) => t.id !== id) },
          userSources: s.userSources.filter((u) => u.id !== id),
        }));
        frames.setExtras(enabledUserTags());
        frames.refresh();
      },

      selectCity: (id) => {
        if (id !== get().selectedCity) abortCity();
        set({ selectedCity: id });
        if (id) fetchCityData(id);
      },

      weights: () => selectors.weights(get()),
      baselineWeights: () => selectors.baselineWeights(get()),
      isForecastHour: (h) => isForecastHour(get().meta, h),
      isFireAssumedHour: (h) => isFireAssumedHour(get().meta, h),
    };
  });

  return Object.assign(useStore, { client, frames });
}

export type AppStore = ReturnType<typeof createAppStore>;

/** The app-wide store. */
export const useStore = createAppStore();
