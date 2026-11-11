/**
 * The whole app with the map mocked out (MapLibre is never imported): the run starts on mount for
 * `?date=`, the playhead opens on the date's evening, and problems reach the problems panel.
 */
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { MapContainerProps } from "./map/MapContainer";
import { frameBytes } from "./test-utils/frames";
import { makeMeta } from "./test-utils/meta";

let mapProps: MapContainerProps | null = null;
vi.mock("./map/MapContainer", () => ({
  MapContainer: (props: MapContainerProps) => {
    mapProps = props;
    return null;
  },
}));

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

const calls: string[] = [];
const RUN = "/api/runs/2026-11-10";

beforeAll(() => {
  window.history.replaceState(null, "", "/?date=2026-11-10");
  vi.stubGlobal("fetch", vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    calls.push(`${init?.method ?? "GET"} ${u}${init?.body ? ` ${String(init.body)}` : ""}`);
    if (u === "/api/runs") return json({ run_id: "2026-11-10", status: "ready" });
    if (u.startsWith(`${RUN}/meta`)) return json(makeMeta({ hours: 48 }));
    if (u.startsWith(`${RUN}/fires`)) return json([]);
    if (u.startsWith(`${RUN}/frames/`)) {
      return new Response(frameBytes(2, 2, { vehicles_delhi_ncr: { scale: 1, codes: [1, 1, 1, 1] }, __haze: { scale: 1, codes: [1, 1, 1, 1] } }));
    }
    if (u.includes("/measured")) return json({ values: [], station_count: 0, source: "s", aligned: "a" });
    if (u.includes("/cams")) return json({ values: [] });
    return json({ detail: "unhandled" }, 500);
  }));
});

afterAll(() => vi.unstubAllGlobals());

describe("App", () => {
  it("starts the run for ?date= on mount, opens on the date's evening, and shows and dismisses map problems", async () => {
    const { default: App } = await import("./App");
    const { useStore } = await import("./state/store");
    render(<App />);
    expect(calls[0]).toBe('POST /api/runs {"date":"2026-11-10"}');
    await waitFor(() => expect(useStore.getState().status).toBe("ready"));
    // the date's evening: 13:00 UTC (18:30 IST) is hour 13 of a window starting at 00:00 UTC
    await waitFor(() => expect(useStore.getState().hour).toBe(13));
    expect(calls).toContain(`GET ${RUN}/cities/delhi/measured?build=b1`);

    act(() => mapProps!.onProblem!("map", "Map error: tile 404"));
    expect(screen.getByText("Map error: tile 404")).toBeInTheDocument();
    act(() => mapProps!.onProblem!("path", "back-trajectory: HTTP 500"));
    expect(screen.getByText("back-trajectory: HTTP 500")).toBeInTheDocument();
    const problems = screen.getByText("Map error: tile 404").closest(".problems")!;
    // only the map error is dismissible
    expect(problems.querySelectorAll("button[aria-label='Dismiss']")).toHaveLength(1);
    fireEvent.click(screen.getByRole("button", { name: "Dismiss" }));
    expect(screen.queryByText("Map error: tile 404")).toBeNull();
    expect(screen.getByText("back-trajectory: HTTP 500")).toBeInTheDocument();
    // The first import of the whole app (map libraries included) can take longer than the
    // default 5 s on a cold cache or a busy machine.
  }, 20_000);
});
