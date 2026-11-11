import { fireEvent, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeMeta } from "../test-utils/meta";
import { renderPanel } from "../test-utils/panels";
import { TopBar } from "./TopBar";

describe("TopBar", () => {
  it("bounds the date input by the meta's min date and today (UTC)", () => {
    renderPanel(<TopBar onDate={() => {}} />);
    const input = screen.getByLabelText("Run date");
    expect(input).toHaveAttribute("min", "2018-04-01");
    expect(input).toHaveAttribute("max", new Date().toISOString().slice(0, 10));
    expect(input).toHaveValue("2026-11-10");
  });
  it("changing the date starts a new run", () => {
    const onDate = vi.fn();
    renderPanel(<TopBar onDate={onDate} />);
    fireEvent.change(screen.getByLabelText("Run date"), { target: { value: "2025-11-05" } });
    expect(onDate).toHaveBeenCalledWith("2025-11-05");
  });
  it("shows the IST clock for the playhead", () => {
    renderPanel(<TopBar onDate={() => {}} />, { hour: 12 });
    expect(screen.getByTestId("ist-clock")).toHaveTextContent("10 Nov 2026 · 17:30 IST");
  });
  it("PM2.5 and AQI are exclusive plume modes", () => {
    const { store } = renderPanel(<TopBar onDate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^AQI/ }));
    expect(store.getState().layers).toMatchObject({ aqi: true, pm25: false });
    fireEvent.click(screen.getByRole("button", { name: "PM2.5" }));
    expect(store.getState().layers).toMatchObject({ aqi: false, pm25: true });
  });
  it("readouts for the selected city (Delhi by default)", () => {
    const meta = makeMeta();
    const d = meta.cities[0];
    d.met = { ...d.met, wind_ms: d.met.wind_ms.map(() => 3.05), wind_dir_deg: d.met.wind_dir_deg.map(() => 315), rh: d.met.rh.map(() => 0.68), temp_c: d.met.temp_c.map(() => 19.2), blh_m: d.met.blh_m.map(() => 310) };
    renderPanel(<TopBar onDate={() => {}} />, { meta });
    expect(screen.getByTestId("ro-wind")).toHaveTextContent("NW 11 km/h");
    expect(screen.getByTestId("ro-rh")).toHaveTextContent("68%");
    expect(screen.getByTestId("ro-temp")).toHaveTextContent("19°C");
    expect(screen.getByTestId("ro-blh")).toHaveTextContent("310 m");
    expect(screen.getByTestId("ro-blh")).not.toHaveTextContent("est.");
  });
  it("marks an estimated mixing height and calm wind", () => {
    const meta = makeMeta({ notes: { ...makeMeta().notes, blh_estimated: true } });
    renderPanel(<TopBar onDate={() => {}} />, { meta });
    expect(screen.getByTestId("ro-blh")).toHaveTextContent("500 m est.");
    expect(screen.getByTestId("ro-wind")).toHaveTextContent("Calm");
  });
});
