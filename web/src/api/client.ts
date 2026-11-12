/**
 * Typed HTTP client for server/vayu/api.py.
 *
 * Build rule: every run-derived request (frames, wind, fires, path, cams, measured, sources,
 * source removal)
 * carries `?build={current build id}`. When the server answers 409 ("run was rebuilt", with the
 * new `build_id`; or "run expired", `build_id` null) the client calls `onRebuilt` ONCE (the store drops its cached frames and refetches meta there, so the next
 * `getBuild()` returns the new id) and then repeats the request a single time. This is the only
 * place that handles 409.
 */
import { decodeFrame, type Frame } from "./decode";
import type {
  CamsResponse, DataPollutant, Fire, MeasuredResponse, Meta, PostRunResponse, RunStatus, SourceRequest,
  SourceResponse, WindField,
} from "./types";

export class ApiError extends Error {
  readonly status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.status = status;
  }
}

export interface ClientOptions {
  fetch?: typeof fetch;
  baseUrl?: string;
  /** The build id of the loaded meta (null before it is loaded: no `build` is sent). */
  getBuild?: () => string | null;
  /**
   * Called after a 409, before the retry: `newBuildId` is the new build (run rebuilt) or null
   * (run expired or gone); `sentBuild` is the build id that the failed request carried, captured
   * before it was sent. Must leave `getBuild()` returning the new build.
   */
  onRebuilt?: (newBuildId: string | null, sentBuild: string) => Promise<void>;
}

interface Req {
  method?: "GET" | "POST" | "DELETE";
  body?: unknown;
  signal?: AbortSignal;
  /** Send ?build= and handle 409 (default true). */
  build?: boolean;
  /** Extra query text, already encoded, e.g. "extra=user_1". */
  query?: string;
}

async function detailOf(res: Response): Promise<string> {
  try {
    const j = (await res.json()) as { detail?: unknown };
    if (typeof j.detail === "string") return j.detail;
    if (j.detail != null) return JSON.stringify(j.detail);
  } catch {
    /* fall through */
  }
  return res.statusText || `HTTP ${res.status}`;
}

export class ApiClient {
  private readonly fetchImpl: typeof fetch;
  private readonly baseUrl: string;
  private readonly opts: ClientOptions;

  constructor(opts: ClientOptions = {}) {
    this.opts = opts;
    this.fetchImpl = opts.fetch ?? ((...a) => fetch(...a));
    this.baseUrl = opts.baseUrl ?? "/api";
  }

  private url(path: string, req: Req, build: string | null): string {
    const q: string[] = [];
    if (build) q.push(`build=${encodeURIComponent(build)}`);
    if (req.query) q.push(req.query);
    return `${this.baseUrl}${path}${q.length ? `?${q.join("&")}` : ""}`;
  }

  private async send(path: string, req: Req): Promise<Response> {
    const withBuild = req.build !== false;
    for (let attempt = 0; ; attempt++) {
      const sentBuild = withBuild ? (this.opts.getBuild?.() ?? null) : null; // captured before sending
      const res = await this.fetchImpl(this.url(path, req, sentBuild), {
        method: req.method ?? "GET",
        signal: req.signal,
        ...(req.body !== undefined
          ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(req.body) }
          : {}),
      });
      if (res.status === 409 && sentBuild !== null && attempt === 0 && this.opts.onRebuilt) {
        let newBuild: string | null = null;
        try {
          const id = ((await res.json()) as { build_id?: unknown }).build_id;
          newBuild = typeof id === "string" ? id : null;
        } catch {
          /* unreadable body: treat as expired */
        }
        await this.opts.onRebuilt(newBuild, sentBuild);
        continue;
      }
      if (!res.ok) throw new ApiError(res.status, await detailOf(res));
      return res;
    }
  }

  private async json<T>(path: string, req: Req = {}): Promise<T> {
    return (await this.send(path, req)).json() as Promise<T>;
  }

  private run(runId: string): string {
    return `/runs/${encodeURIComponent(runId)}`;
  }

  /** POST /runs: 202 `{run_id}` while building, 200 `{run_id, status: "ready"}` when already built. */
  postRun(date: string, signal?: AbortSignal): Promise<PostRunResponse> {
    return this.json("/runs", { method: "POST", body: { date }, signal, build: false });
  }

  /** Poll status. A 404 (ApiError.status) means the server lost the run. */
  getRunStatus(runId: string, signal?: AbortSignal): Promise<RunStatus> {
    return this.json(this.run(runId), { signal, build: false });
  }

  /** Meta carries no `build`: it is how the client learns the current build. */
  getMeta(runId: string, signal?: AbortSignal): Promise<Meta> {
    return this.json(`${this.run(runId)}/meta`, { signal, build: false });
  }

  async getFrame(runId: string, hour: number, extras: readonly string[] = [], signal?: AbortSignal): Promise<Frame> {
    const query = extras.length ? `extra=${extras.join(",")}` : undefined;
    const res = await this.send(`${this.run(runId)}/frames/${hour}`, { signal, query });
    return decodeFrame(await res.arrayBuffer());
  }

  getWind(runId: string, hour: number, signal?: AbortSignal): Promise<WindField> {
    return this.json(`${this.run(runId)}/wind/${hour}`, { signal });
  }

  getFires(runId: string, signal?: AbortSignal): Promise<Fire[]> {
    return this.json(`${this.run(runId)}/fires`, { signal });
  }

  getPath(runId: string, cityId: string, hour: number, signal?: AbortSignal): Promise<[number, number][]> {
    return this.json(`${this.run(runId)}/cities/${encodeURIComponent(cityId)}/path/${hour}`, { signal });
  }

  /** CPCB city mean. PM2.5 sends no `pollutant` (the server default), so its URL is unchanged. */
  getMeasured(runId: string, cityId: string, signal?: AbortSignal, pollutant: DataPollutant = "pm25"): Promise<MeasuredResponse> {
    return this.json(`${this.run(runId)}/cities/${encodeURIComponent(cityId)}/measured`, { signal, query: pollutantQuery(pollutant) });
  }

  getCams(runId: string, cityId: string, signal?: AbortSignal, pollutant: DataPollutant = "pm25"): Promise<CamsResponse> {
    return this.json(`${this.run(runId)}/cities/${encodeURIComponent(cityId)}/cams`, { signal, query: pollutantQuery(pollutant) });
  }

  postSource(runId: string, source: SourceRequest, signal?: AbortSignal): Promise<SourceResponse> {
    return this.json(`${this.run(runId)}/sources`, { method: "POST", body: source, signal });
  }

  /** DELETE an added source (404 if the server does not know it). */
  deleteSource(runId: string, tagId: string, signal?: AbortSignal): Promise<{ removed: string; build_id: string }> {
    return this.json(`${this.run(runId)}/sources/${encodeURIComponent(tagId)}`, { method: "DELETE", signal });
  }
}

const pollutantQuery = (p: DataPollutant) => (p === "pm25" ? undefined : `pollutant=${p}`);

export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function isAbort(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}
