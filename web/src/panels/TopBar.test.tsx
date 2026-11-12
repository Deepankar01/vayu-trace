import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { makeMeta } from "../test-utils/meta";
import { renderPanel } from "../test-utils/panels";
import { NO_COARSE_AQI } from "../lib/pollutant";
import { CONCENTRATION_CHIP, DATE_NOTE, TERRAIN_NOTE, TopBar, aqiChipNote, windText } from "./TopBar";

describe("TopBar", () => {
  it("bounds the date input by the meta's min date and today (UTC)", () => {
    renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />);
    const input = screen.getByLabelText("Run date");
    expect(input).toHaveAttribute("min", "2018-04-01");
    expect(input).toHaveAttribute("max", new Date().toISOString().slice(0, 10));
    expect(input).toHaveValue("2026-11-10");
  });
  it("a picker choice (a change with no key press) starts a new run", () => {
    const onDate = vi.fn();
    renderPanel(<TopBar date="2026-11-10" onDate={onDate} />);
    fireEvent.change(screen.getByLabelText("Run date"), { target: { value: "2025-11-05" } });
    expect(onDate).toHaveBeenCalledWith("2025-11-05");
  });
  it("typing intermediate values does not start runs; Enter commits", () => {
    const onDate = vi.fn();
    renderPanel(<TopBar date="2026-11-10" onDate={onDate} />);
    const input = screen.getByLabelText("Run date");
    for (const v of ["0002-11-10", "2025-11-10", "2025-11-01", "2025-11-15"]) {
      fireEvent.keyDown(input, { key: "1" });
      fireEvent.change(input, { target: { value: v } });
    }
    expect(onDate).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDate).toHaveBeenCalledTimes(1);
    expect(onDate).toHaveBeenCalledWith("2025-11-15");
  });
  it("blur commits a typed date", () => {
    const onDate = vi.fn();
    renderPanel(<TopBar date="2026-11-10" onDate={onDate} />);
    const input = screen.getByLabelText("Run date");
    fireEvent.keyDown(input, { key: "2" });
    fireEvent.change(input, { target: { value: "2024-11-02" } });
    fireEvent.blur(input);
    expect(onDate).toHaveBeenCalledWith("2024-11-02");
  });
  it("ignores dates outside [min, max] with a hint", () => {
    const onDate = vi.fn();
    renderPanel(<TopBar date="2026-11-10" onDate={onDate} />);
    const input = screen.getByLabelText("Run date");
    fireEvent.change(input, { target: { value: "2010-01-01" } });
    fireEvent.keyDown(input, { key: "3" });
    fireEvent.change(input, { target: { value: "2999-01-01" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onDate).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(/Choose a date from 2018-04-01 to/);
  });
  it("shows the requested date while its run builds, with the UTC note", () => {
    renderPanel(<TopBar date="2025-11-05" onDate={() => {}} />, { meta: null, status: "running" });
    expect(screen.getByLabelText("Run date")).toHaveValue("2025-11-05");
    expect(screen.getByTitle(DATE_NOTE)).toBeInTheDocument();
    expect(DATE_NOTE).toContain("Dates are UTC days");
    expect(screen.getByRole("button", { name: "Terrain 3D" }).getAttribute("title")).toBe(TERRAIN_NOTE);
  });
  it("shows the IST clock for the playhead", () => {
    renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />, { hour: 12 });
    expect(screen.getByTestId("ist-clock")).toHaveTextContent("10 Nov 2026 · 17:30 IST");
  });
  it("tags the IST clock 'forecast' on a forecast hour, nothing on an observed one", () => {
    const meta = makeMeta({ fires_assumed_from: 20, forecast_from: 24 });
    const { store } = renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />, { meta, hour: 5 });
    expect(screen.queryByTestId("hour-tag")).toBeNull();
    act(() => store.getState().setHour(26));
    expect(screen.getByTestId("ist-clock")).toContainElement(screen.getByTestId("hour-tag"));
    expect(screen.getByTestId("hour-tag").textContent).toBe("forecast");
  });
  it("concentration and AQI are exclusive plume modes", () => {
    const { store } = renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />);
    fireEvent.click(screen.getByRole("button", { name: /^AQI/ }));
    expect(store.getState().layers).toMatchObject({ aqi: true, pm25: false });
    fireEvent.click(screen.getByRole("button", { name: CONCENTRATION_CHIP }));
    expect(store.getState().layers).toMatchObject({ aqi: false, pm25: true });
  });
  it("pollutant control: PM2.5 by default; one chip pressed; a click sets the store", () => {
    const { store } = renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />);
    const group = within(screen.getByRole("group", { name: "Pollutant" }));
    const pressed = () => group.getAllByRole("button").map((b) => [b.textContent, b.getAttribute("aria-pressed")]);
    expect(pressed()).toEqual([["PM2.5", "true"], ["PM10", "false"], ["Coarse", "false"]]);
    fireEvent.click(group.getByRole("button", { name: "PM10" }));
    expect(store.getState().pollutant).toBe("pm10");
    expect(pressed()).toEqual([["PM2.5", "false"], ["PM10", "true"], ["Coarse", "false"]]);
    fireEvent.click(group.getByRole("button", { name: "Coarse" }));
    expect(store.getState().pollutant).toBe("coarse");
    expect(group.getByRole("button", { name: "Coarse" })).toHaveAttribute("title", "Coarse PM, 2.5–10 µm (PM10 minus PM2.5)");
    // switching pollutant leaves the plume mode alone
    expect(store.getState().layers).toMatchObject({ pm25: true, aqi: false });
  });
  it("the AQI chip names the pollutant; in the coarse view it is disabled and says why", () => {
    const { store } = renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />, {
      layers: { pm25: false, aqi: true, wind: true, fires: true, terrain: false },
    });
    const aqi = () => screen.getByRole("button", { name: "AQI" });
    const conc = () => screen.getByRole("button", { name: CONCENTRATION_CHIP });
    expect(aqi()).toHaveAttribute("title", "Hourly PM2.5 shown on the 24-hour AQI scale — indicative");
    expect(aqi()).toHaveAttribute("aria-pressed", "true");
    act(() => store.getState().setPollutant("pm10"));
    expect(aqi()).toHaveAttribute("title", aqiChipNote("pm10"));
    expect(aqi().getAttribute("title")).toContain("PM10");
    expect(aqi()).toBeEnabled();
    act(() => store.getState().setPollutant("coarse"));
    expect(aqi()).toBeDisabled();
    expect(aqi()).toHaveAttribute("title", NO_COARSE_AQI);
    expect(aqi()).toHaveAttribute("aria-description", NO_COARSE_AQI);
    // the plume falls back to concentration, and the chips show that
    expect(aqi()).toHaveAttribute("aria-pressed", "false");
    expect(conc()).toHaveAttribute("aria-pressed", "true");
    // the AQI choice is kept: back in PM2.5 it is on again
    act(() => store.getState().setPollutant("pm25"));
    expect(aqi()).toHaveAttribute("aria-pressed", "true");
    expect(conc()).toHaveAttribute("aria-pressed", "false");
  });
  it("readouts for the selected city (Delhi by default)", () => {
    const meta = makeMeta();
    const d = meta.cities[0];
    d.met = { ...d.met, wind_ms: d.met.wind_ms.map(() => 3.05), wind_dir_deg: d.met.wind_dir_deg.map(() => 315), rh: d.met.rh.map(() => 0.68), temp_c: d.met.temp_c.map(() => 19.2), blh_m: d.met.blh_m.map(() => 310) };
    renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />, { meta });
    expect(screen.getByTestId("ro-wind")).toHaveTextContent("NW 11 km/h");
    expect(screen.getByTestId("ro-rh")).toHaveTextContent("68%");
    expect(screen.getByTestId("ro-temp")).toHaveTextContent("19°C");
    expect(screen.getByTestId("ro-blh")).toHaveTextContent("310 m");
    expect(screen.getByTestId("ro-blh")).not.toHaveTextContent("est.");
  });
  it("wind without a direction: speed alone, or Calm under 0.1 m/s", () => {
    expect(windText(3.05, null)).toBe("11 km/h");
    expect(windText(3.05, NaN)).toBe("11 km/h");
    expect(windText(0.05, null)).toBe("Calm");
    expect(windText(3.05, 315)).toBe("NW 11 km/h");
    expect(windText(null, null)).toBe("–");
  });
  it("marks an estimated mixing height; no direction shows the speed alone", () => {
    const meta = makeMeta({ notes: { ...makeMeta().notes, blh_estimated: true } });
    renderPanel(<TopBar date="2026-11-10" onDate={() => {}} />, { meta });
    expect(screen.getByTestId("ro-blh")).toHaveTextContent("500 m est.");
    expect(screen.getByTestId("ro-wind")).toHaveTextContent("Wind 7 km/h"); // 2 m/s, no direction
  });
});
