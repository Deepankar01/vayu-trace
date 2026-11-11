import { fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useDropStore } from "../map/dropStore";
import type { UserSource } from "../state/store";
import { makeMeta } from "../test-utils/meta";
import { renderPanel } from "../test-utils/panels";
import { SourcesPanel } from "./SourcesPanel";

const notes = (over: Partial<ReturnType<typeof makeMeta>["notes"]>) => ({ ...makeMeta().notes, ...over });
const user = (id: string, enabled = true): UserSource => ({
  id, label: `Custom source: 10 kg PM2.5 per hour`, color: "#9aa3b5", enabled,
  spec: { kind: "custom", lon: 77, lat: 28, amount: 10, start_hour: 0, duration_h: 6 },
});

afterEach(() => useDropStore.setState({ armedForDrop: false, pending: null }));

describe("SourcesPanel", () => {
  it("lists the sources with the agreed labels", () => {
    renderPanel(<SourcesPanel />);
    for (const name of ["Fires (satellite)", "Vehicles", "Industry and power", "Road and construction dust", "Residential"]) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    expect(screen.getByText("Includes road-dust resuspension reported with road transport in the inventory")).toBeInTheDocument();
  });

  it("disables the dust slider and the construction ban with a note when there is no dust data", () => {
    renderPanel(<SourcesPanel />, { meta: makeMeta({ notes: notes({ dust_available: false }) }) });
    expect(screen.getByRole("slider", { name: "Road and construction dust" })).toBeDisabled();
    expect(screen.getAllByText("No baseline dust data — add sites with Drop source").length).toBeGreaterThan(0);
    expect(screen.getByRole("switch", { name: /Construction ban, Delhi NCR/ })).toBeDisabled();
  });

  it("dust slider is enabled with no note when dust data exists", () => {
    renderPanel(<SourcesPanel />);
    expect(screen.getByRole("slider", { name: "Road and construction dust" })).toBeEnabled();
    expect(screen.queryByText("No baseline dust data — add sites with Drop source")).toBeNull();
  });

  it("hides 'Fires stop now' when no fire hours are assumed, shows it otherwise", () => {
    const { unmount } = renderPanel(<SourcesPanel />);
    expect(screen.queryByText("Fires stop now")).toBeNull();
    unmount();
    const { store } = renderPanel(<SourcesPanel />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }) });
    fireEvent.click(screen.getByRole("switch", { name: /Fires stop now/ }));
    expect(store.getState().firesContinue).toBe(false);
  });

  it("slider change updates the store and shows the percent", () => {
    const { store } = renderPanel(<SourcesPanel />);
    const s = screen.getByRole("slider", { name: "Vehicles" });
    fireEvent.change(s, { target: { value: "150" } });
    expect(store.getState().sliders.vehicles).toBe(1.5);
    expect(screen.getByTestId("pct-vehicles")).toHaveTextContent("150%");
    fireEvent.doubleClick(s);
    expect(store.getState().sliders.vehicles).toBe(1);
  });

  it("fires are 'observed', or say from when they are assumed", () => {
    const { unmount } = renderPanel(<SourcesPanel />);
    expect(screen.getByText("observed")).toBeInTheDocument();
    unmount();
    // hour 20 of the test window = 2026-11-10 20:00 UTC = 11 Nov 01:30 IST
    renderPanel(<SourcesPanel />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }) });
    expect(screen.getByText("observed; assumed after 11 Nov · 01:30 IST")).toBeInTheDocument();
  });

  it("fire scaling tooltip states the run's default", () => {
    const { unmount } = renderPanel(<SourcesPanel />);
    expect(screen.getByText(/Default 1× means no correction\./)).toBeInTheDocument();
    unmount();
    renderPanel(<SourcesPanel />, { meta: makeMeta({ notes: notes({ fire_scaling_default: 1.5 }) }) });
    expect(screen.getByText(/Default 1\.5×\./)).toBeInTheDocument();
    expect(screen.queryByText(/means no correction/)).toBeNull();
  });

  it("removes an added source", async () => {
    const { store } = renderPanel(<SourcesPanel />, { userSources: [user("user_1")] });
    const removed: string[] = [];
    store.setState({ removeSource: async (id) => void removed.push(id) });
    fireEvent.click(screen.getByRole("button", { name: /Remove 1\. Custom source/ }));
    expect(removed).toEqual(["user_1"]);
  });

  it("fire scaling control sets the store and explains itself", () => {
    const { store } = renderPanel(<SourcesPanel />);
    fireEvent.change(screen.getByRole("slider", { name: "Fire scaling" }), { target: { value: "2.5" } });
    expect(store.getState().fireScaling).toBe(2.5);
    expect(screen.getByText(/Satellites miss small and short-lived fires/)).toBeInTheDocument();
  });

  it("odd-even shows its effect when on", () => {
    const { store } = renderPanel(<SourcesPanel />);
    fireEvent.click(screen.getByRole("switch", { name: /Odd-even traffic, Delhi NCR/ }));
    expect(store.getState().regionScenario.delhiOddEven).toBe(true);
    expect(screen.getByText("−30% vehicles")).toBeInTheDocument();
  });

  it("reset restores sliders, scenarios, fire scaling and disables added sources", () => {
    const meta = makeMeta({ notes: notes({ fire_scaling_default: 1.5 }) });
    const { store } = renderPanel(<SourcesPanel />, {
      meta, sliders: { vehicles: 0.2, industry: 2, dust: 1, residential: 0 }, fireScaling: 3, firesContinue: false,
      regionScenario: { delhiOddEven: true, delhiConstructionBan: true }, userSources: [user("user_1"), user("user_2", false)],
    });
    fireEvent.click(screen.getByRole("button", { name: "Reset" }));
    const s = store.getState();
    expect(s.sliders).toEqual({ vehicles: 1, industry: 1, dust: 1, residential: 1 });
    expect(s.fireScaling).toBe(1.5);
    expect(s.firesContinue).toBe(true);
    expect(s.regionScenario).toEqual({ delhiOddEven: false, delhiConstructionBan: false });
    expect(s.userSources.map((u) => u.enabled)).toEqual([false, false]);
  });

  it("lists added sources with an enable toggle", () => {
    const { store } = renderPanel(<SourcesPanel />, { userSources: [user("user_1")] });
    expect(screen.getByText("Added sources")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("switch", { name: /Custom source: 10 kg PM2.5 per hour/ }));
    expect(store.getState().userSources[0].enabled).toBe(false);
  });

  it("arms the map for a drop and shows the hint", () => {
    renderPanel(<SourcesPanel />);
    fireEvent.click(screen.getByRole("button", { name: /Drop source on map/ }));
    expect(useDropStore.getState().armedForDrop).toBe(true);
    expect(screen.getByText("Click the map to place the source")).toBeInTheDocument();
  });

  it("caps added sources at 5", () => {
    renderPanel(<SourcesPanel />, { userSources: ["user_1", "user_2", "user_3", "user_4", "user_5"].map((id) => user(id)) });
    expect(screen.getByRole("button", { name: /Drop source on map/ })).toBeDisabled();
    expect(screen.getByText("At most 5 added sources per run")).toBeInTheDocument();
  });

  it("compare with baseline toggles the diff mode", () => {
    const { store } = renderPanel(<SourcesPanel />);
    fireEvent.click(screen.getByRole("button", { name: "Compare with baseline" }));
    expect(store.getState().compareBaseline).toBe(true);
  });

  it("weather readout: inversion from mixing height, rain not available, terrain on", () => {
    renderPanel(<SourcesPanel />); // test meta: Delhi blh 500 m
    expect(screen.getByTestId("inversion")).toHaveTextContent("weak");
    expect(screen.getByTestId("rain")).toHaveTextContent("—");
    expect(screen.getByTestId("terrain")).toHaveTextContent("on");
  });
});
