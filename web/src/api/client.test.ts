import { describe, expect, it, vi } from "vitest";
import { frameBytes } from "../test-utils/frames";
import { ApiClient } from "./client";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function setup(responses: Response[], build: { id: string | null } = { id: "b1" }) {
  const urls: string[] = [];
  const queue = [...responses];
  const fetchMock = vi.fn(async (url: string | URL | Request) => {
    urls.push(String(url));
    return queue.shift() ?? json({ detail: "no more" }, 500);
  });
  const onRebuilt = vi.fn(async (b: string | null, _sent: string) => {
    void _sent;
    build.id = b ?? "fresh";
  });
  const client = new ApiClient({ fetch: fetchMock as unknown as typeof fetch, getBuild: () => build.id, onRebuilt });
  return { client, urls, onRebuilt, build, fetchMock };
}

describe("ApiClient URLs", () => {
  it("sends ?build= on run-derived requests and extra= on frames, but not on runs or meta", async () => {
    const { client, urls } = setup([
      json({ run_id: "2026-11-10" }, 202), json({ status: "running", progress: 0, stage: "", error: null }),
      json({}), new Response(frameBytes(1, 1, { __haze: { scale: 1, codes: [1] } })), json([]), json({}),
      json([]), json({ values: [] }), json({ values: [] }), json({}),
    ]);
    await client.postRun("2026-11-10");
    await client.getRunStatus("2026-11-10");
    await client.getMeta("2026-11-10");
    await client.getFrame("2026-11-10", 3, ["user_1", "user_2"]);
    await client.getFires("2026-11-10");
    await client.getWind("2026-11-10", 4);
    await client.getPath("2026-11-10", "delhi", 5);
    await client.getMeasured("2026-11-10", "delhi");
    await client.getCams("2026-11-10", "delhi");
    await client.postSource("2026-11-10", { kind: "k", lon: 1, lat: 2, amount: 3, start_hour: 0, duration_h: 1 });
    expect(urls).toEqual([
      "/api/runs",
      "/api/runs/2026-11-10",
      "/api/runs/2026-11-10/meta",
      "/api/runs/2026-11-10/frames/3?build=b1&extra=user_1,user_2",
      "/api/runs/2026-11-10/fires?build=b1",
      "/api/runs/2026-11-10/wind/4?build=b1",
      "/api/runs/2026-11-10/cities/delhi/path/5?build=b1",
      "/api/runs/2026-11-10/cities/delhi/measured?build=b1",
      "/api/runs/2026-11-10/cities/delhi/cams?build=b1",
      "/api/runs/2026-11-10/sources?build=b1",
    ]);
  });

  it("decodes a frame body", async () => {
    const { client } = setup([new Response(frameBytes(2, 1, { a: { scale: 1, codes: [1, 2] } }))]);
    const f = await client.getFrame("2026-11-10", 0);
    expect([...f.tags.get("a")!.data]).toEqual([1, 2]);
  });
});

describe("ApiClient errors and 409", () => {
  it("raises ApiError with the server's detail", async () => {
    const { client } = setup([json({ detail: "2030-01-01 is in the future" }, 422)]);
    await expect(client.getFires("x")).rejects.toMatchObject({ status: 422, message: "2030-01-01 is in the future" });
  });

  it("on 409 (rebuilt) calls onRebuilt once with the new build and retries with it", async () => {
    const { client, urls, onRebuilt } = setup([json({ detail: "run was rebuilt", build_id: "b2" }, 409), json([[1, 2, 3, 4]])]);
    expect(await client.getFires("r")).toEqual([[1, 2, 3, 4]]);
    expect(onRebuilt).toHaveBeenCalledTimes(1);
    expect(onRebuilt).toHaveBeenCalledWith("b2", "b1"); // the build that was sent
    expect(urls).toEqual(["/api/runs/r/fires?build=b1", "/api/runs/r/fires?build=b2"]);
  });

  it("on 409 (expired, build_id null) passes null", async () => {
    const { client, onRebuilt } = setup([json({ detail: "run expired", build_id: null }, 409), json([])]);
    await client.getFires("r");
    expect(onRebuilt).toHaveBeenCalledWith(null, "b1");
  });

  it("treats 404 as an ordinary error (unknown city, bad hour) with no rebuild", async () => {
    const { client, onRebuilt } = setup([json({ detail: "unknown city 'x'" }, 404)]);
    await expect(client.getMeasured("r", "x")).rejects.toMatchObject({ status: 404, message: "unknown city 'x'" });
    expect(onRebuilt).not.toHaveBeenCalled();
  });

  it("does not rebuild when no build was sent (409 before meta, or on run/meta calls)", async () => {
    const a = setup([json({ detail: "x", build_id: "b2" }, 409)], { id: null });
    await expect(a.client.getFires("r")).rejects.toMatchObject({ status: 409 });
    expect(a.onRebuilt).not.toHaveBeenCalled();
  });

  it("gives up after one retry", async () => {
    const { client, onRebuilt } = setup([json({ detail: "run was rebuilt", build_id: "b2" }, 409), json({ detail: "run was rebuilt", build_id: "b3" }, 409)]);
    await expect(client.getFires("r")).rejects.toMatchObject({ status: 409 });
    expect(onRebuilt).toHaveBeenCalledTimes(1);
  });
});
