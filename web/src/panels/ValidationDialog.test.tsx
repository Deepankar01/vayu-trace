import { fireEvent, render, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { NO_FIT, NO_REPORT, ValidationButton, ValidationDialog, type ValidationReport, type ValidationRow } from "./ValidationDialog";

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
  pooled: [row("all", "All 28 northern cities"), row("ncr", "Delhi NCR (5 cities)")],
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
