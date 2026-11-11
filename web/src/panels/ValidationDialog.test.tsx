import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FIT, NO_REPORT, STALE_REPORT, ValidationButton, ValidationDialog, type ValidationReport, type ValidationRow } from "./ValidationDialog";

const split = (day: number | null, night: number | null) => ({
  day: { n: 56, bias: day, nmb: null }, night: { n: 56, bias: night, nmb: null },
});
const row = (id: string, name: string, over: Partial<ValidationRow> = {}): ValidationRow => ({
  id, name, stations: 5,
  model: { n: 160, r: 0.41, bias: -60.4, nmb: -0.38, rmse: 90, fac2: 0.52 },
  cams: { n: 166, r: 0.55, bias: -20, nmb: -0.12, rmse: 60, fac2: 0.71 },
  mean_sim: 98.6, mean_measured: 159, split: { model: split(-90, 35), cams: split(-10, -30) },
  ...over,
});

const REPORT: ValidationReport = {
  episode: { start: "2025-11-03T00:00:00+00:00", end: "2025-11-09T23:00:00+00:00", hours: 168 },
  min_n: 24,
  generated_at: "2026-11-11T09:30:00+00:00",
  runs: [{ date: "2025-11-05", build_id: "20261111T083034Z-87c28ccb" }, { date: "2025-11-06", build_id: "20261111T090356Z-61c44bb0" }],
  pooled: [
    row("all", "All 28 northern cities", {
      r_per_city: {
        cities: 28, model_r_gt_cams_r: 4,
        model: { median: 0.178, mean: 0.148, min: -0.18, max: 0.51 },
        cams: { median: 0.383, mean: 0.376, min: 0.01, max: 0.72 },
      },
    }),
    row("ncr", "Delhi NCR (5 cities)"),
  ],
  cities: [
    row("delhi", "Delhi"),
    row("gaya", "Gaya", {
      model: { n: 10, r: null, bias: null, nmb: null, rmse: null, fac2: null },
      mean_sim: null, mean_measured: null, split: { model: split(null, null), cams: split(null, null) },
    }),
  ],
};

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("ValidationDialog", () => {
  it("shows per-city r statistics for pooled rows that have them, and the provenance", async () => {
    const f = vi.fn(async () => json(REPORT));
    render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    const all = await screen.findByTestId("rstats-all");
    expect(all.textContent).toContain("median per-city r 0.18 model, 0.38 CAMS");
    expect(all.textContent).toContain("model r above CAMS r in 4 of 28");
    expect(screen.queryByTestId("rstats-ncr")).toBeNull(); // old-shape row: no stats, no crash
    const prov = screen.getByTestId("vd-provenance").textContent!;
    expect(prov).toContain("generated 2026-11-11T09:30:00+00:00");
    expect(prov).toContain("2025-11-05 (20261111T083034Z-87c28ccb)");
  });

  it("says the report is stale when the server marks it so, and nothing otherwise", async () => {
    const f = vi.fn(async () => json({ ...REPORT, stale: true }));
    const { unmount } = render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    expect(await screen.findByText(STALE_REPORT)).toBeInTheDocument();
    unmount();
    const g = vi.fn(async () => json({ ...REPORT, stale: false }));
    render(<ValidationDialog onClose={() => {}} fetchImpl={g as unknown as typeof fetch} />);
    await screen.findByTestId("vd-provenance");
    expect(screen.queryByTestId("vd-stale")).toBeNull();
  });

  it("renders a report without r_per_city, runs or generated_at (older shape)", async () => {
    const old = { ...REPORT, generated_at: undefined, runs: undefined, pooled: [row("all", "All 28 northern cities")] };
    const f = vi.fn(async () => json(old));
    render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    expect(await screen.findByText("All 28 northern cities")).toBeInTheDocument();
    expect(screen.queryByTestId("rstats-all")).toBeNull();
    expect(screen.getByTestId("vd-provenance").textContent).toBe("Episode 2025-11-03 to 2025-11-09");
  });

  it("shows a fetch error", async () => {
    const f = vi.fn(async () => json({ detail: "boom" }, 500));
    render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    expect(await screen.findByText("Could not load the validation report: HTTP 500")).toBeInTheDocument();
    const g = vi.fn(async () => { throw new TypeError("Failed to fetch"); });
    render(<ValidationDialog onClose={() => {}} fetchImpl={g as unknown as typeof fetch} />);
    expect(await screen.findByText(/Could not load the validation report: TypeError: Failed to fetch/)).toBeInTheDocument();
  });

  it("keeps Tab focus inside the dialog", async () => {
    const f = vi.fn(async () => json({ detail: "none" }, 404));
    render(<><button type="button">outside</button><ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} /></>);
    await screen.findByText(NO_REPORT);
    const close = screen.getByRole("button", { name: "Close validation" });
    expect(close).toHaveFocus(); // the only focusable element
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(close).toHaveFocus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab", shiftKey: true });
    expect(close).toHaveFocus();
    screen.getByRole("button", { name: "outside" }).focus();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Tab" });
    expect(close).toHaveFocus();
  });

  it("renders the episode, the no-fitting statement, pooled and per-city rows", async () => {
    const f = vi.fn(async () => json(REPORT));
    render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    expect(f).toHaveBeenCalledWith("/api/validation", expect.anything());
    expect(await screen.findByText("Delhi NCR (5 cities)")).toBeInTheDocument();
    expect(screen.getByText(NO_FIT)).toBeInTheDocument();
    expect(screen.getByText("2025-11-03")).toBeInTheDocument();
    expect(screen.getByText("2025-11-09")).toBeInTheDocument();
    const delhi = screen.getAllByRole("row").find((r) => within(r).queryByRole("rowheader", { name: "Delhi" }))!;
    for (const v of ["159", "99", "160", "0.41", "-0.38", "0.52", "-90", "+35", "0.55", "-0.12", "0.71"]) {
      expect(within(delhi).getByText(v)).toBeInTheDocument();
    }
  });

  it("shows null metrics as –", async () => {
    const f = vi.fn(async () => json(REPORT));
    render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    const gaya = await screen.findByRole("row", { name: /^Gaya/ });
    const cells = within(gaya).getAllByRole("cell").map((c) => c.textContent);
    expect(cells.slice(0, 8)).toEqual(["–", "–", "10", "–", "–", "–", "–", "–"]);
  });

  it("says how to make a report when the server has none (404)", async () => {
    const f = vi.fn(async () => json({ detail: "no validation results yet" }, 404));
    render(<ValidationDialog onClose={() => {}} fetchImpl={f as unknown as typeof fetch} />);
    expect(await screen.findByText(NO_REPORT)).toBeInTheDocument();
    expect(screen.queryByRole("table")).toBeNull();
  });

  it("closes on Escape and on the close button", async () => {
    const onClose = vi.fn();
    const f = vi.fn(async () => json(REPORT));
    render(<ValidationDialog onClose={onClose} fetchImpl={f as unknown as typeof fetch} />);
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    fireEvent.click(screen.getByRole("button", { name: "Close validation" }));
    expect(onClose).toHaveBeenCalledTimes(2);
    await screen.findByText("Delhi");
  });

  it("the Validation button opens and closes the dialog", async () => {
    const f = vi.fn(async () => json(REPORT));
    render(<ValidationButton fetchImpl={f as unknown as typeof fetch} />);
    expect(screen.queryByRole("dialog")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Validation" }));
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    await screen.findByText("Delhi");
    fireEvent.click(screen.getByRole("button", { name: "Close validation" }));
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
