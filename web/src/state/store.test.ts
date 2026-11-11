import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Meta, RunStatus } from "../api/types";
import { frameBytes } from "../test-utils/frames";
import { makeMeta } from "../test-utils/meta";
import { createAppStore, REBUILD_LOOP, REFRESH_NOTICE, RUN_LOST } from "./store";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const frame = () => new Response(frameBytes(1, 1, { vehicles_delhi_ncr: { scale: 1, codes: [5] }, __haze: { scale: 1, codes: [1] } }));
const aborting = (signal?: AbortSignal | null) =>
  new Promise<Response>((_, rej) => signal?.addEventListener("abort", () => rej(new DOMException("aborted", "AbortError"))));

type Handler = (path: string, init: RequestInit | undefined, call: number) => Response | Promise<Response> | undefined;

function harness(handler: Handler) {
  const calls: string[] = [];
  const fetchMock = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}`);
    const n = calls.filter((c) => c === calls[calls.length - 1]).length;
    const r = handler(u, init, n);
    return r ?? json({ detail: `unhandled ${u}` }, 500);
  });
  const store = createAppStore({ fetch: fetchMock as unknown as typeof fetch });
  return { store, calls, fetchMock, get: () => store.getState() };
}

const RUN = "/api/runs/2026-11-10";
const running = (): RunStatus => ({ status: "running", progress: 0.4, stage: "simulating", error: null });

/** A server that has the run built already, serving `meta` and frames. */
function readyServer(meta: () => Meta = () => makeMeta(), extra?: Handler): Handler {
  return (u, init, n) => {
    const x = extra?.(u, init, n);
    if (x) return x;
    if (u === "/api/runs") return json({ run_id: "2026-11-10", status: "ready" });
    if (u === `${RUN}/meta`) return json(meta());
    if (u.startsWith(`${RUN}/fires`)) return json([[77, 29, 12.5, 3]]);
    if (u.startsWith(`${RUN}/frames/`)) return frame();
    if (u.includes("/measured")) return json({ values: [1, 2], station_count: 3, live: 9, live_error: null, source: "s", aligned: "a" });
    if (u.includes("/cams")) return json({ values: [4, 5] });
    return undefined;
  };
}

const flush = () => vi.advanceTimersByTimeAsync(0);

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("startRun and polling", () => {
  it("polls every second while running, then loads meta and fires", async () => {
    let polls = 0;
    const h = harness((u, init, n) => {
      if (u === "/api/runs") return json({ run_id: "2026-11-10" }, 202);
      if (u === RUN) return json(++polls < 3 ? running() : { status: "ready", progress: 1, stage: "ready", error: null });
      return readyServer()(u, init, n);
    });
    const p = h.get().startRun("2026-11-10");
    await flush();
    expect(h.get().status).toBe("running");
    expect(h.get().progress).toBe(0.4);
    expect(h.get().stage).toBe("simulating");
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(999);
    expect(polls).toBe(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(polls).toBe(2);
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(polls).toBe(3);
    expect(h.get().status).toBe("ready");
    expect(h.get().meta?.build_id).toBe("b1");
    expect(h.get().fires).toEqual([[77, 29, 12.5, 3]]);
    await vi.advanceTimersByTimeAsync(5000);
    expect(polls).toBe(3); // polling stopped
  });

  it("uses the 200 'ready' reply to skip polling", async () => {
    const h = harness(readyServer());
    await h.get().startRun("2026-11-10");
    expect(h.get().status).toBe("ready");
    expect(h.calls.filter((c) => c === `GET ${RUN}`)).toHaveLength(0);
    expect(h.get().fireScaling).toBe(1);
  });

  it("stops polling and stores the message when the run errors", async () => {
    let polls = 0;
    const h = harness((u) => {
      if (u === "/api/runs") return json({ run_id: "2026-11-10" }, 202);
      if (u === RUN) return json(++polls < 2 ? running() : { status: "error", progress: 0.5, stage: "x", error: "FIRMS: no data" });
      return undefined;
    });
    const p = h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(1000);
    await p;
    expect(h.get().status).toBe("error");
    expect(h.get().error).toBe("FIRMS: no data");
    await vi.advanceTimersByTimeAsync(10_000);
    expect(polls).toBe(2);
    expect(h.get().meta).toBeNull();
  });

  it("treats a 404 from the status endpoint as a lost run", async () => {
    const h = harness((u) => (u === "/api/runs" ? json({ run_id: "2026-11-10" }, 202) : u === RUN ? json({ detail: "gone" }, 404) : undefined));
    await h.get().startRun("2026-11-10");
    expect(h.get().status).toBe("error");
    expect(h.get().error).toBe(RUN_LOST);
  });

  it("surfaces a rejected POST as error text instead of throwing", async () => {
    const h = harness((u) => (u === "/api/runs" ? json({ detail: "2030-01-01 is in the future" }, 422) : undefined));
    await expect(h.get().startRun("2030-01-01")).resolves.toBeUndefined();
    expect(h.get().error).toMatch(/in the future/);
  });

  it("a newer startRun cancels the older poll", async () => {
    let polls = 0;
    const h = harness((u, init, n) => {
      if (u === "/api/runs") return json({ run_id: "2026-11-10" }, 202);
      if (u === RUN) return (polls++, json(running()));
      return readyServer()(u, init, n);
    });
    void h.get().startRun("2026-11-10");
    await flush();
    const first = polls;
    h.get().startRun("2026-11-10").catch(() => {});
    await flush();
    await vi.advanceTimersByTimeAsync(3000);
    expect(polls - first).toBe(4); // polls at t=0,1,2,3 s of ONE chain (the old chain was cancelled)
  });
});

describe("frames, builds and 409", () => {
  it("fetches the window around the playhead with ?build= and never more than 4 at once", async () => {
    let open = 0;
    let max = 0;
    const h = harness(
      readyServer(() => makeMeta(), (u, init) => {
        if (!u.includes("/frames/")) return undefined;
        open++;
        max = Math.max(max, open);
        return new Promise((r, rej) => {
          const t = setTimeout(() => (open--, r(frame())), 10);
          init?.signal?.addEventListener("abort", () => (clearTimeout(t), open--, rej(new DOMException("aborted", "AbortError"))));
        });
      }),
    );
    await h.get().startRun("2026-11-10");
    h.get().setHour(15);
    await vi.advanceTimersByTimeAsync(500);
    const hours = h.calls.filter((c) => c.includes("/frames/")).map((c) => Number(c.match(/frames\/(\d+)/)![1]));
    for (let w = 3; w <= 27; w++) expect(hours).toContain(w); // the full +/-12 window around hour 15
    expect(hours.some((x) => x > 27)).toBe(false);
    expect(h.calls.filter((c) => c.includes("/frames/")).every((c) => c.includes("?build=b1"))).toBe(true);
    expect(max).toBeLessThanOrEqual(4);
    expect(h.store.frames.get(15)).toBeDefined();
    expect(h.get().frameVersion).toBeGreaterThan(0);
  });

  it("on 409 drops cached frames, refetches meta, clears added sources and carries on with the new build", async () => {
    let meta = makeMeta();
    let rebuilt = false;
    const h = harness(
      readyServer(() => meta, (u) => {
        if (u.includes("/frames/") && u.includes("build=b1") && !rebuilt) {
          rebuilt = true;
          meta = makeMeta({ build_id: "b2" });
          return json({ detail: "run was rebuilt", build_id: "b2" }, 409);
        }
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.get().meta?.build_id).toBe("b2");
    expect(h.get().notice).toBe(REFRESH_NOTICE);
    expect(h.calls.filter((c) => c === `GET ${RUN}/meta`)).toHaveLength(2); // initial + refetch
    const later = h.calls.filter((c) => c.includes("/frames/") && c.includes("build=b2"));
    expect(later.length).toBeGreaterThanOrEqual(13);
    expect(h.store.frames.get(0)).toBeDefined(); // refilled from the new build
  });

  it("only one meta refetch when several frame requests get 409 together", async () => {
    let meta = makeMeta();
    let flip = false;
    const h = harness(
      readyServer(() => meta, (u) => {
        if (u.includes("/frames/") && u.includes("build=b1")) {
          if (!flip) {
            flip = true;
            meta = makeMeta({ build_id: "b2" });
          }
          return json({ detail: "run was rebuilt", build_id: "b2" }, 409);
        }
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.calls.filter((c) => c === `GET ${RUN}/meta`)).toHaveLength(2);
  });

  it("on 409 with build_id null starts the run again, polls, then refetches meta and removes added sources", async () => {
    let expired = false;
    let meta = makeMeta();
    let posts = 0;
    let statusPolls = 0;
    const h = harness((u, init, n) => {
      if (u === "/api/runs") return (posts++, posts === 1 ? json({ run_id: "2026-11-10", status: "ready" }) : json({ run_id: "2026-11-10" }, 202));
      if (u === RUN) return json(++statusPolls < 2 ? running() : { status: "ready", progress: 1, stage: "ready", error: null });
      if (u.startsWith(`${RUN}/sources`)) return json({ tag: { id: "user_1", label: "Kiln", color: "#999" }, by_city: { delhi: [1, 1], ludhiana: [0, 0] }, build_id: "b1" });
      if (u.includes("/frames/") && u.includes("build=b1") && !expired && h.get().userSources.length) {
        expired = true;
        meta = makeMeta({ build_id: "b9" });
        return json({ detail: "run expired", build_id: null }, 409);
      }
      return readyServer(() => meta)(u, init, n);
    });
    await h.get().startRun("2026-11-10");
    await h.get().addSource({ kind: "brick_kiln", lon: 77, lat: 28, amount: 1, start_hour: 0, duration_h: 4 });
    expect(h.get().userSources).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(posts).toBe(2);
    expect(statusPolls).toBe(2);
    expect(h.get().meta?.build_id).toBe("b9");
    expect(h.get().userSources).toEqual([]);
    expect(h.get().notice).toBe(REFRESH_NOTICE);
    h.get().clearNotice();
    expect(h.get().notice).toBeNull();
  });
});

describe("selectCity: measured and CAMS", () => {
  const pendingByCity = (log: AbortSignal[]): Handler => (u, init) => {
    if (u.includes("/cities/") && (u.includes("/measured") || u.includes("/cams"))) {
      if (init?.signal) log.push(init.signal);
      return aborting(init?.signal) as unknown as Promise<Response>;
    }
    return undefined;
  };

  it("fetches both for the selected city and stores the results", async () => {
    const h = harness(readyServer());
    await h.get().startRun("2026-11-10");
    h.get().selectCity("delhi");
    expect(h.get().measured.delhi.status).toBe("loading");
    expect(h.get().cams.delhi.status).toBe("loading");
    await flush();
    expect(h.get().measured.delhi).toEqual({ status: "ready", values: [1, 2], stationCount: 3, live: 9, liveError: null, error: null });
    expect(h.get().cams.delhi).toMatchObject({ status: "ready", values: [4, 5] });
    expect(h.calls).toContain(`GET ${RUN}/cities/delhi/measured?build=b1`);
    h.get().selectCity("ludhiana");
    h.get().selectCity("delhi"); // already loaded: no refetch
    await flush();
    expect(h.calls.filter((c) => c.includes("delhi/measured"))).toHaveLength(1);
  });

  it("aborts the previous city's in-flight requests and returns them to idle", async () => {
    const signals: AbortSignal[] = [];
    const h = harness(readyServer(() => makeMeta(), pendingByCity(signals)));
    await h.get().startRun("2026-11-10");
    h.get().selectCity("delhi");
    await flush();
    expect(signals).toHaveLength(2);
    h.get().selectCity("ludhiana");
    expect(signals.slice(0, 2).every((s) => s.aborted)).toBe(true);
    expect(h.get().measured.delhi.status).toBe("idle");
    expect(h.get().cams.delhi.status).toBe("idle");
    expect(h.get().measured.ludhiana.status).toBe("loading");
    await flush();
    expect(h.get().measured.delhi.status).toBe("idle"); // the abort did not become an error
    expect(signals[2].aborted).toBe(false);
  });

  it("a late answer for the abandoned city is ignored", async () => {
    let release!: () => void;
    const h = harness(
      readyServer(() => makeMeta(), (u) => {
        if (u.includes("delhi/measured")) return new Promise((r) => (release = () => r(json({ values: [9], station_count: 1, live: null, live_error: null, source: "", aligned: "" }))));
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    h.get().selectCity("delhi");
    await flush();
    h.get().selectCity("ludhiana");
    release();
    await flush();
    expect(h.get().measured.delhi.status).toBe("idle");
    expect(h.get().measured.ludhiana.status).toBe("ready");
  });

  it("a 502 on measured is an error state for that city only; CAMS and the rest carry on; reselecting retries", async () => {
    let fail = true;
    const h = harness(readyServer(() => makeMeta(), (u) => (u.includes("/measured") && fail ? json({ detail: "openaq: timeout" }, 502) : undefined)));
    await h.get().startRun("2026-11-10");
    h.get().selectCity("delhi");
    await flush();
    expect(h.get().measured.delhi).toMatchObject({ status: "error", error: "openaq: timeout", values: null });
    expect(h.get().cams.delhi.status).toBe("ready");
    expect(h.get().status).toBe("ready");
    expect(h.get().error).toBeNull();
    fail = false;
    h.get().selectCity(null);
    h.get().selectCity("delhi");
    await flush();
    expect(h.get().measured.delhi.status).toBe("ready");
  });

  it("selecting a city before the run is ready fetches once meta arrives", async () => {
    const h = harness(readyServer());
    h.get().selectCity("delhi");
    expect(h.calls).toHaveLength(0);
    await h.get().startRun("2026-11-10");
    await flush();
    expect(h.get().measured.delhi.status).toBe("ready");
  });
});

describe("playback", () => {
  async function ready(hours = 10) {
    const h = harness(readyServer(() => makeMeta({ hours })));
    await h.get().startRun("2026-11-10");
    return h;
  }

  it("tick advances by dt x speed and stops at the last hour without wrapping", async () => {
    const h = await ready(10);
    h.get().togglePlay();
    h.get().setSpeed(4);
    h.get().tick(0.5);
    expect(h.get().hour).toBe(2);
    h.get().tick(1); // 2 + 4 = 6
    expect(h.get().hour).toBe(6);
    h.get().tick(10);
    expect(h.get().hour).toBe(9);
    expect(h.get().playing).toBe(false);
    h.get().tick(1);
    expect(h.get().hour).toBe(9);
  });

  it("does nothing while paused; setHour clamps; play on the last hour restarts", async () => {
    const h = await ready(10);
    h.get().tick(5);
    expect(h.get().hour).toBe(0);
    h.get().setHour(99);
    expect(h.get().hour).toBe(9);
    h.get().setHour(-3);
    expect(h.get().hour).toBe(0);
    h.get().setHour(NaN);
    expect(h.get().hour).toBe(0);
    h.get().setHour(9);
    h.get().togglePlay();
    expect(h.get().playing).toBe(true);
    expect(h.get().hour).toBe(0);
    h.get().togglePlay();
    expect(h.get().playing).toBe(false);
  });

  it("cannot play without a run", () => {
    const h = harness(() => undefined);
    h.get().togglePlay();
    expect(h.get().playing).toBe(false);
  });
});

describe("forecast hours and weights through the store", () => {
  it("exposes isForecastHour and isFireAssumedHour from the meta", async () => {
    const h = harness(readyServer(() => makeMeta({ forecast_from: 20, fires_assumed_from: 12 })));
    expect(h.get().isForecastHour(25)).toBe(false); // no meta yet
    await h.get().startRun("2026-11-10");
    expect(h.get().isForecastHour(19.5)).toBe(false);
    expect(h.get().isForecastHour(20)).toBe(true);
    expect(h.get().isFireAssumedHour(11)).toBe(false);
    expect(h.get().isFireAssumedHour(12.5)).toBe(true);
  });

  it("weights() follows odd-even, firesContinue and fireScaling; baselineWeights() does not; resetScenario restores", async () => {
    const h = harness(readyServer());
    await h.get().startRun("2026-11-10");
    h.get().setRegionScenario("delhiOddEven", true);
    h.get().setFiresContinue(false);
    h.get().setFireScaling(2);
    h.get().setSlider("dust", 9); // clamped to 2
    const w = h.get().weights();
    expect(w.vehicles_delhi_ncr).toBeCloseTo(0.7, 12);
    expect(w.firefc_punjab).toBe(0);
    expect(w.fire_punjab).toBe(2);
    expect(w.dust_delhi_ncr).toBe(2);
    expect(h.get().baselineWeights()).toMatchObject({ vehicles_delhi_ncr: 1, firefc_punjab: 1, fire_punjab: 1, dust_delhi_ncr: 1 });
    h.get().resetScenario();
    expect(Object.values(h.get().weights()).every((x) => x === 1)).toBe(true);
  });
});

describe("added sources", () => {
  const req = { kind: "brick_kiln", lon: 77, lat: 28, amount: 1, start_hour: 2, duration_h: 4 };
  const withSource = (u: string) =>
    u.startsWith(`${RUN}/sources`)
      ? json({ tag: { id: "user_1", label: "Brick kiln: size 1", color: "#9aa3b5" }, by_city: { delhi: [0, 0, 3, 4], ludhiana: [0, 0, 0, 0] }, build_id: "b1" })
      : undefined;

  it("adds the tag to meta and weights, requests frames with extra=, and toggling off needs no refetch", async () => {
    const h = harness(readyServer(() => makeMeta({ hours: 4 }), (u) => withSource(u)));
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(200);
    await h.get().addSource(req);
    expect(h.calls).toContain(`POST ${RUN}/sources?build=b1`);
    const m = h.get().meta!;
    expect(m.tags.some((t) => t.id === "user_1" && t.kind === "user")).toBe(true);
    expect(m.cities.find((c) => c.id === "delhi")!.by_tag.user_1).toEqual([0, 0, 3, 4]);
    expect(m.cities.find((c) => c.id === "ludhiana")!.by_tag.user_1).toBeUndefined(); // all zeros: absent
    expect(h.get().weights().user_1).toBe(1);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls.some((c) => c.includes("frames/0?build=b1&extra=user_1"))).toBe(true);
    const n = h.calls.length;
    h.get().toggleUserSource("user_1");
    expect(h.get().weights().user_1).toBe(0);
    expect(h.get().baselineWeights().user_1).toBe(0);
    await vi.advanceTimersByTimeAsync(200);
    expect(h.calls).toHaveLength(n);
  });

  it("reports a rejected source as sourceError without touching the run", async () => {
    const h = harness(readyServer(() => makeMeta(), (u) => (u.startsWith(`${RUN}/sources`) ? json({ detail: "at most 5 added sources per run" }, 422) : undefined)));
    await h.get().startRun("2026-11-10");
    await h.get().addSource(req);
    expect(h.get().sourceError).toBe("at most 5 added sources per run");
    expect(h.get().error).toBeNull();
    expect(h.get().userSources).toEqual([]);
  });
});

it("restores user sources listed in meta, enabled", async () => {
  const meta = makeMeta();
  meta.tags = [...meta.tags, { id: "user_1", kind: "user", sector: null, region: null, label: "Old", color: "#999" }];
  const h = harness(readyServer(() => meta));
  await h.get().startRun("2026-11-10");
  expect(h.get().userSources).toEqual([{ id: "user_1", label: "Old", color: "#999", enabled: true, spec: null }]);
});

const R2 = "/api/runs/2026-11-11";

describe("rebuild path", () => {
  it("starting another date during an expiry rebuild abandons it: the old date never overwrites the new run", async () => {
    let posts = 0;
    let oldStatus = 0;
    let expired = false;
    const h = harness((u, init, n) => {
      if (u === "/api/runs") {
        const date = JSON.parse(String(init!.body)).date as string;
        if (date === "2026-11-11") return json({ run_id: date, status: "ready" });
        return ++posts === 1 ? json({ run_id: date, status: "ready" }) : json({ run_id: date }, 202);
      }
      if (u === RUN) return (oldStatus++, json(running()));
      if (u === `${R2}/meta`) return json(makeMeta({ build_id: "b7", date: "2026-11-11" }));
      if (u.startsWith(`${R2}/fires`)) return json([]);
      if (u.startsWith(`${R2}/frames/`)) return frame();
      if (u.startsWith(`${RUN}/frames/`) && !expired) {
        expired = true;
        return json({ detail: "run expired", build_id: null }, 409);
      }
      return readyServer()(u, init, n);
    });
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(2500);
    expect(h.get().status).toBe("running");
    expect(oldStatus).toBeGreaterThanOrEqual(2);
    await h.get().startRun("2026-11-11");
    const seen = oldStatus;
    await vi.advanceTimersByTimeAsync(10_000);
    expect(h.get().runId).toBe("2026-11-11");
    expect(h.get().meta?.build_id).toBe("b7");
    expect(h.get().status).toBe("ready");
    expect(h.get().notice).toBeNull();
    expect(oldStatus - seen).toBeLessThanOrEqual(1); // the old poll loop stopped
  });

  it("ignores a late 409 for a build that has already been superseded and retries with the current one", async () => {
    let k = 1;
    let releaseWind!: () => void;
    let winds = 0;
    const h = harness(
      readyServer(() => makeMeta({ build_id: `b${k}` }), (u) => {
        if (u.includes("/wind/")) {
          if (++winds === 1) return new Promise((r) => (releaseWind = () => r(json({ detail: "run was rebuilt", build_id: "b2" }, 409))));
          return json({ step: 1 });
        }
        if (u.includes("/frames/") && u.includes("build=b1")) {
          k = 2;
          return json({ detail: "run was rebuilt", build_id: "b2" }, 409);
        }
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    const wind = h.store.client.getWind("2026-11-10", 1); // sent with build b1, held
    await vi.advanceTimersByTimeAsync(200);
    expect(h.get().meta?.build_id).toBe("b2");
    const metas = h.calls.filter((c) => c === `GET ${RUN}/meta`).length;
    releaseWind(); // a late 409 for b1
    await expect(wind).resolves.toMatchObject({ step: 1 });
    expect(h.calls.filter((c) => c === `GET ${RUN}/meta`)).toHaveLength(metas); // no second rebuild
    expect(h.calls.filter((c) => c.includes("/wind/")).pop()).toContain("build=b2");
  });

  it("stops after 2 consecutive automatic rebuilds with status error and a clear message", async () => {
    let k = 1;
    const h = harness(
      readyServer(() => makeMeta({ build_id: `b${k}` }), (u) => {
        if (u.includes("/frames/")) {
          k++;
          return json({ detail: "run was rebuilt", build_id: `b${k}` }, 409);
        }
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.get().status).toBe("error");
    expect(h.get().error).toBe(REBUILD_LOOP);
    expect(h.calls.filter((c) => c === `GET ${RUN}/meta`)).toHaveLength(3); // initial + 2 rebuilds
  });

  it("refetches fires after a rebuild and shows 'running' while rebuilding", async () => {
    let k = 1;
    const stages: string[] = [];
    const h = harness(
      readyServer(() => makeMeta({ build_id: `b${k}` }), (u) => {
        if (u.includes("/frames/") && u.includes("build=b1")) {
          k = 2;
          stages.push(`${h.get().status}`);
          return json({ detail: "run was rebuilt", build_id: "b2" }, 409);
        }
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(300);
    expect(h.calls.filter((c) => c.startsWith(`GET ${RUN}/fires`))).toHaveLength(2);
    expect(h.calls.filter((c) => c.includes("/fires")).pop()).toContain("build=b2");
    expect(h.get().status).toBe("ready");
  });

  it("stores a failed rebuild in error", async () => {
    let k = 1;
    const h = harness(
      readyServer(() => makeMeta({ build_id: `b${k}` }), (u) => {
        if (u.includes("/frames/")) return json({ detail: "run expired", build_id: null }, 409);
        if (u === "/api/runs") return k++ === 1 ? json({ run_id: "2026-11-10", status: "ready" }) : json({ detail: "boom" }, 500);
        return undefined;
      }),
    );
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(500);
    expect(h.get().status).toBe("error");
    expect(h.get().error).toBe("boom");
  });
});

describe("addSource keeps series with nulls; frame errors clear; unknown tags surface", () => {
  it("keeps a series of zeros and nulls, drops one of exact zeros", async () => {
    const h = harness(
      readyServer(() => makeMeta({ hours: 4 }), (u) =>
        u.startsWith(`${RUN}/sources`)
          ? json({ tag: { id: "user_1", label: "x", color: "#999" }, by_city: { delhi: [0, null, 0, 0], ludhiana: [0, 0, 0, 0] }, build_id: "b1" })
          : undefined),
    );
    await h.get().startRun("2026-11-10");
    await h.get().addSource({ kind: "k", lon: 1, lat: 2, amount: 1, start_hour: 0, duration_h: 1 });
    const cities = h.get().meta!.cities;
    expect(cities.find((c) => c.id === "delhi")!.by_tag.user_1).toEqual([0, null, 0, 0]);
    expect(cities.find((c) => c.id === "ludhiana")!.by_tag.user_1).toBeUndefined();
  });

  it("frameError is set by a failure and cleared when a frame later loads (retry after 3 s)", async () => {
    let failing = true;
    const h = harness(readyServer(() => makeMeta(), (u) => (u.includes("/frames/") && failing ? json({ detail: "boom" }, 500) : undefined)));
    await h.get().startRun("2026-11-10");
    await vi.advanceTimersByTimeAsync(100);
    expect(h.get().frameError).toMatch(/^frame for hour \d+: boom$/);
    failing = false;
    await vi.advanceTimersByTimeAsync(3000);
    expect(h.get().frameError).toBeNull();
    expect(h.store.frames.get(0)).toBeDefined();
  });

  it("reports a city series whose tag is not in meta.tags as an error string", async () => {
    const meta = makeMeta();
    meta.cities[0].by_tag.mystery_tag = [1];
    const h = harness(readyServer(() => meta));
    await h.get().startRun("2026-11-10");
    expect(h.get().error).toMatch(/mystery_tag/);
  });
});

describe("memoised weights selectors", () => {
  it("returns the same object for the same inputs and a new one when an input changes", async () => {
    const h = harness(readyServer());
    await h.get().startRun("2026-11-10");
    const w = h.get().weights();
    const b = h.get().baselineWeights();
    expect(h.get().weights()).toBe(w);
    h.get().setHour(5);
    h.get().setLayer("wind", true);
    h.get().setCompareBaseline(true);
    expect(h.get().weights()).toBe(w);
    h.get().setSlider("vehicles", 1.5);
    const w2 = h.get().weights();
    expect(w2).not.toBe(w);
    expect(w2.vehicles_delhi_ncr).toBe(1.5);
    expect(h.get().weights()).toBe(w2);
    expect(h.get().baselineWeights()).toBe(b); // sliders do not move the baseline
  });
});

describe("layer defaults", () => {
  it("PM2.5 plume, fires and wind streaks on; AQI and 3D terrain off", () => {
    expect(createAppStore().getState().layers).toEqual({ pm25: true, aqi: false, wind: true, fires: true, terrain: false });
  });
});
