import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { renderPanel } from "../test-utils/panels";
import { NO_COARSE_AQI } from "../lib/pollutant";
import { CITY_NOTE, PlumeLegend, cityNote } from "./PlumeLegend";

const layers = (over: Partial<{ pm25: boolean; aqi: boolean }>) => ({
  pm25: true, aqi: false, wind: true, fires: true, terrain: false, ...over,
});

describe("PlumeLegend", () => {
  it("PM2.5 mode: the simulated ramp with ticks and the city note", () => {
    renderPanel(<PlumeLegend />);
    expect(screen.getByText("PM2.5 · µg/m³ (simulated)")).toBeInTheDocument();
    expect(screen.getByText("400")).toBeInTheDocument();
    expect(screen.getByText(CITY_NOTE)).toBeInTheDocument();
  });
  it("AQI mode: the six categories, marked indicative", () => {
    renderPanel(<PlumeLegend />, { layers: layers({ pm25: false, aqi: true }) });
    expect(screen.getByText("AQI (PM2.5-based) · indicative")).toBeInTheDocument();
    expect(screen.getAllByRole("listitem")).toHaveLength(6);
    expect(screen.getByText(CITY_NOTE)).toBeInTheDocument();
  });
  it("compare mode wins over the plume toggles: the difference scale", () => {
    renderPanel(<PlumeLegend />, { compareBaseline: true, layers: layers({ aqi: true }) });
    expect(screen.getByText("Difference from baseline · PM2.5 µg/m³")).toBeInTheDocument();
    expect(screen.getByText("lower than baseline")).toBeInTheDocument();
    expect(screen.getByText(CITY_NOTE)).toBeInTheDocument();
  });
  it("names the pollutant in view in every mode", () => {
    const { unmount } = renderPanel(<PlumeLegend />, { pollutant: "pm10" });
    expect(screen.getByText("PM10 · µg/m³ (simulated)")).toBeInTheDocument();
    expect(screen.getByTestId("legend-note")).toHaveTextContent(cityNote("pm10"));
    expect(cityNote("pm10")).toBe("City labels and markers: simulated PM2.5-based AQI");
    unmount();
    const aqi = renderPanel(<PlumeLegend />, { pollutant: "pm10", layers: layers({ pm25: false, aqi: true }) });
    expect(screen.getByText("AQI (PM10-based) · indicative")).toBeInTheDocument();
    aqi.unmount();
    renderPanel(<PlumeLegend />, { pollutant: "coarse", compareBaseline: true });
    expect(screen.getByText("Difference from baseline · Coarse PM µg/m³")).toBeInTheDocument();
  });
  it("coarse view: the concentration ramp; with AQI mode on it says there is no AQI", () => {
    const { unmount } = renderPanel(<PlumeLegend />, { pollutant: "coarse" });
    expect(screen.getByText("Coarse PM, 2.5–10 µm · µg/m³ (simulated)")).toBeInTheDocument();
    expect(screen.queryByTestId("legend-no-aqi")).toBeNull();
    unmount();
    renderPanel(<PlumeLegend />, { pollutant: "coarse", layers: layers({ pm25: false, aqi: true }) });
    expect(screen.getByText("Coarse PM, 2.5–10 µm · µg/m³ (simulated)")).toBeInTheDocument();
    expect(screen.getByTestId("legend-no-aqi")).toHaveTextContent(`${NO_COARSE_AQI}; showing concentration`);
    expect(screen.queryByText(/indicative/)).toBeNull();
  });
  it("nothing without a plume or without a run", () => {
    const { unmount } = renderPanel(<PlumeLegend />, { layers: layers({ pm25: false }) });
    expect(screen.queryByLabelText("Plume legend")).toBeNull();
    unmount();
    renderPanel(<PlumeLegend />, { meta: null });
    expect(screen.queryByLabelText("Plume legend")).toBeNull();
  });
});
