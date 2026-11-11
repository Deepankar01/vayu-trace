import { act, fireEvent, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useMapStatus } from "../map/mapStatus";
import { makeMeta } from "../test-utils/meta";
import { renderPanel } from "../test-utils/panels";
import { Timeline } from "./Timeline";

const CONTINUE = "forecast assumes fires continue at recent levels";
const STOP = "forecast assumes fires stop now";

afterEach(() => useMapStatus.setState({ plumeLoadingHour: null, pathHour: null }));

describe("Timeline", () => {
  it("no caption when no fire hours are assumed", () => {
    renderPanel(<Timeline />);
    expect(screen.queryByText(CONTINUE)).toBeNull();
    expect(screen.queryByText(STOP)).toBeNull();
  });
  it("legend: solid = past hours, dashed = forecast only when there is a forecast", () => {
    const { unmount } = renderPanel(<Timeline />);
    expect(screen.getByText("solid = past hours (observed weather and fires)")).toBeInTheDocument();
    expect(screen.queryByText("dashed = forecast")).toBeNull();
    unmount();
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }) });
    expect(screen.getByText("dashed = forecast")).toBeInTheDocument();
  });
  it("solid legend says fires are observed only until the marker when assumed hours precede the forecast", () => {
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }) });
    expect(screen.getByText("solid = past hours (observed weather; fires observed until the marker)")).toBeInTheDocument();
    expect(screen.queryByText("solid = past hours (observed weather and fires)")).toBeNull();
  });
  it("tags the big clock 'fires assumed' or 'forecast' at the playhead hour", () => {
    const meta = makeMeta({ fires_assumed_from: 20, forecast_from: 24 });
    const { unmount } = renderPanel(<Timeline />, { meta, hour: 10 });
    expect(screen.queryByTestId("hour-tag")).toBeNull();
    unmount();
    renderPanel(<Timeline />, { meta, hour: 21 });
    expect(screen.getByTestId("clock")).toContainElement(screen.getByTestId("hour-tag"));
    expect(screen.getByTestId("hour-tag").textContent).toBe("fires assumed");
  });
  it("an hour the frame cache gave up on says so with a retry button; retry fetches it again", () => {
    const { store } = renderPanel(<Timeline />);
    useMapStatus.setState({ plumeLoadingHour: 7 });
    const gaveUp = vi.spyOn(store.frames, "gaveUp").mockImplementation((h) => h === 7);
    const retry = vi.spyOn(store.frames, "retry").mockImplementation(() => {});
    act(() => store.setState({ frameFailures: 1 }));
    expect(screen.getByText(/hour 7 failed to load/)).toBeInTheDocument();
    expect(screen.queryByText("loading hour 7…")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "retry" }));
    expect(retry).toHaveBeenCalledWith(7);
    gaveUp.mockReturnValue(false);
    act(() => store.setState({ frameFailures: 2 }));
    expect(screen.getByText("loading hour 7…")).toBeInTheDocument();
  });
  it("caption whenever fires are assumed (continue by default)", () => {
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }) });
    expect(screen.getByText(CONTINUE)).toBeInTheDocument();
  });
  it("caption says fires stop when that scenario is on", () => {
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }), firesContinue: false });
    expect(screen.getByText(STOP)).toBeInTheDocument();
    expect(screen.queryByText(CONTINUE)).toBeNull();
  });
  it("marks where fires are assumed when that is before the forecast part", () => {
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: 24 }) });
    expect(screen.getByText("fires assumed from here")).toBeInTheDocument();
    expect(screen.getByTestId("forecast-part")).toBeInTheDocument();
  });
  it("marks fires assumed when there is no forecast part", () => {
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 20, forecast_from: null }) });
    expect(screen.getByText("fires assumed from here")).toBeInTheDocument();
    expect(screen.queryByTestId("forecast-part")).toBeNull();
  });
  it("no fires-assumed marker when it coincides with the forecast start", () => {
    renderPanel(<Timeline />, { meta: makeMeta({ fires_assumed_from: 24, forecast_from: 24 }) });
    expect(screen.queryByText("fires assumed from here")).toBeNull();
  });
  it("speed control sets hours per second", () => {
    const { store } = renderPanel(<Timeline />);
    fireEvent.click(screen.getByRole("radio", { name: "4×" }));
    expect(store.getState().speed).toBe(4);
    expect(screen.getByRole("radio", { name: "4×" })).toBeChecked();
  });
  it("play button toggles playback", () => {
    const { store } = renderPanel(<Timeline />);
    fireEvent.click(screen.getByRole("button", { name: "Play" }));
    expect(store.getState().playing).toBe(true);
    expect(screen.getByRole("button", { name: "Pause" })).toBeInTheDocument();
  });
  it("scrubber sets the playhead and shows the IST time", () => {
    const { store } = renderPanel(<Timeline />);
    fireEvent.change(screen.getByRole("slider", { name: "Playhead" }), { target: { value: "13" } });
    expect(store.getState().hour).toBe(13);
    // test meta starts 2026-11-10 00:00 UTC; hour 13 = 18:30 IST
    expect(screen.getByTestId("clock")).toHaveTextContent("10 Nov · 18:30");
  });
  it("shows the hour the map is loading", () => {
    useMapStatus.setState({ plumeLoadingHour: 7 });
    renderPanel(<Timeline />);
    expect(screen.getByText("loading hour 7…")).toBeInTheDocument();
  });
});
