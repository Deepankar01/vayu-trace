import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CityMeta } from "../api/types";
import { IDLE_CITY_DATA } from "../state/store";
import { makeMeta } from "../test-utils/meta";
import { flat, measuredReady, renderPanel } from "../test-utils/panels";
import { CityPanel } from "./CityPanel";

const N = 30;
const H = 20;

function delhi(byTag: Record<string, (number | null)[]>, over: Partial<CityMeta> = {}): CityMeta {
  return {
    id: "delhi", name: "Delhi", lat: 28.6, lon: 77.2, region: "delhi_ncr", by_tag: byTag,
    fire_age_h: flat(N, 17),
    met: { wind_ms: flat(N, 3), wind_dir_deg: flat(N, 315), rh: flat(N, 0.68), temp_c: flat(N, 19), blh_m: flat(N, 310) },
    ...over,
  };
}

const sim100 = { vehicles_delhi_ncr: flat(N, 60), fire_punjab: flat(N, 40) };

function setup(byTag: Record<string, (number | null)[]>, measuredValues: (number | null)[] | null, extra = {}) {
  const meta = makeMeta({ hours: N, cities: [delhi(byTag), { ...delhi(byTag), id: "ludhiana", name: "Ludhiana", region: "punjab" }] });
  return renderPanel(<CityPanel />, {
    meta, hour: H, measured: measuredValues ? { delhi: measuredReady(measuredValues) } : {}, ...extra,
  });
}

const legend = () => within(screen.getByRole("list", { name: "Where it came from" }));

describe("CityPanel", () => {
  it("defaults to Delhi with header and area note", () => {
    setup(sim100, null);
    expect(screen.getByText("Delhi · receptor")).toBeInTheDocument();
    expect(screen.getByText("≈ 30 km area average")).toBeInTheDocument();
  });

  it("shows the simulated PM2.5-based AQI, category and hourly PM2.5", () => {
    setup(sim100, null);
    // pm25ToAqi(100) = 233.3
    expect(screen.getByTestId("sim-aqi")).toHaveTextContent("233");
    expect(screen.getByTestId("sim-category")).toHaveTextContent(/Poor · PM2\.5 100 µg\/m³/);
    // number and unit stay together on one line
    expect(screen.getByText(/PM2\.5 100 µg\/m³/)).toHaveClass("nb");
    expect(screen.getByText("PM2.5-based AQI (24 h)")).toBeInTheDocument();
  });

  it("shows a dash and the reason when the 24-hour mean is not available", () => {
    const meta = makeMeta({ hours: N, cities: [delhi(sim100)] });
    renderPanel(<CityPanel />, { meta, hour: 5 });
    expect(screen.getByTestId("sim-aqi")).toHaveTextContent("–");
    expect(screen.getByText("needs 16 h of data")).toBeInTheDocument();
  });

  it("always states what the model simulates and how it compared in validation", () => {
    setup(sim100, null);
    expect(screen.getByText(
      "The model simulates directly emitted PM2.5 only. Secondary aerosol and non-fire emissions outside India are not simulated (fires there are). " +
      "In the November 2025 validation it read low on average, though individual hours can read high. See Validation.",
    )).toBeInTheDocument();
  });

  it("labels the hourly breakdown and the 24-hour figures", () => {
    setup(sim100, flat(N, 160));
    // test meta starts 2026-11-10 00:00 UTC; hour 20 = 01:30 IST
    expect(screen.getByTestId("breakdown-title")).toHaveTextContent("Where it came from · 01:30 IST (this hour)");
    expect(screen.getByText("This hour: model 100 vs measured 160 µg/m³")).toBeInTheDocument();
    expect(screen.getByTestId("aqi-detail")).toHaveTextContent("PM2.5-based AQI (24 h)model −38% (24 h means)4 stations");
    expect(screen.getByText(/hourly PM2\.5, µg\/m³/)).toBeInTheDocument();
  });

  it("no hourly comparison line without a measurement this hour", () => {
    setup(sim100, null);
    expect(screen.queryByText(/^This hour:/)).toBeNull();
  });

  it("sim 100 / measured 160: Not explained by model 38% (37.5 rounded), error on 24 h means", () => {
    setup(sim100, flat(N, 160));
    const rows = legend();
    expect(rows.getByText("Not explained by model")).toBeInTheDocument();
    expect(rows.getByTestId("share-unexplained")).toHaveTextContent("38%");
    // measured AQI pm25ToAqi(160) = 330.8 -> 331; model -37.5% -> "−38%"
    expect(screen.getByTestId("measured-aqi")).toHaveTextContent("331");
    expect(screen.getByText((_, el) => el?.textContent === "model \u221238% (24 h means)")).toBeInTheDocument();
    expect(screen.getByText("4 stations")).toBeInTheDocument();
  });

  it("missing measured at this hour: no gap row, no error figure, the right message", () => {
    const values: (number | null)[] = flat(N, null);
    for (let h = 0; h < 6; h++) values[h] = 150;
    setup(sim100, values);
    expect(screen.getByText("No CPCB data for this hour")).toBeInTheDocument();
    expect(screen.queryByText("Not explained by model")).toBeNull();
    expect(screen.queryByText(/^model /)).toBeNull();
    expect(screen.queryByTestId("measured-aqi")).toBeNull();
  });

  it("a reading this hour without a 24-hour mean shows the reading, not an AQI", () => {
    const values: (number | null)[] = flat(N, null);
    values[H] = 93;
    setup(sim100, values);
    expect(screen.getByText("measured PM2.5 93 µg/m³ this hour")).toBeInTheDocument();
    expect(screen.getByText("24 h mean needs 16 h of data")).toBeInTheDocument();
    expect(screen.queryByTestId("measured-aqi")).toBeNull();
    expect(screen.queryByText(/^model /)).toBeNull();
    // the hourly reading still feeds the breakdown: 93 < 100 simulated, so no gap row
    expect(screen.queryByText("Not explained by model")).toBeNull();
  });

  it("no measured data in the window: says so (never 0)", () => {
    setup(sim100, flat(N, null));
    expect(screen.getByText("No CPCB data for these dates")).toBeInTheDocument();
    expect(screen.queryByText("Not explained by model")).toBeNull();
  });

  it("zero stations reads as no data for these dates", () => {
    const meta = makeMeta({ hours: N, cities: [delhi(sim100)] });
    renderPanel(<CityPanel />, { meta, hour: H, measured: { delhi: measuredReady(flat(N, null), 0) } });
    expect(screen.getByText("No CPCB data for these dates")).toBeInTheDocument();
  });

  it("folds minor rows into one entry with their combined share", () => {
    setup({ vehicles_delhi_ncr: flat(N, 90), fire_punjab: flat(N, 4), dust_delhi_ncr: flat(N, 3), industry_delhi_ncr: flat(N, 3) }, null);
    const rows = legend();
    expect(rows.getByText("Local vehicles")).toBeInTheDocument();
    expect(rows.getByText("Minor sources (each under 5%)")).toBeInTheDocument();
    expect(rows.getByTestId("share-minor")).toHaveTextContent("10%");
    expect(rows.queryByText(/Fires \(satellite\)/)).toBeNull();
  });

  it("renders a dash when everything is zero", () => {
    setup({ vehicles_delhi_ncr: flat(N, 0) }, null);
    expect(legend().getByText("–")).toBeInTheDocument();
  });

  it("flags an incomplete breakdown", () => {
    const veh = flat(N, 60);
    veh[H] = null;
    setup({ vehicles_delhi_ncr: veh, fire_punjab: flat(N, 40) }, null);
    expect(screen.getByText(/incomplete: some source data missing for this hour/)).toBeInTheDocument();
  });

  it("shows loading and error states for CPCB data, with Retry", () => {
    const meta = makeMeta({ hours: N, cities: [delhi(sim100)] });
    const { unmount } = renderPanel(<CityPanel />, { meta, hour: H, measured: { delhi: { ...IDLE_CITY_DATA, status: "loading" } } });
    expect(screen.getByText("fetching CPCB data…")).toBeInTheDocument();
    unmount();
    const { store } = renderPanel(<CityPanel />, {
      meta, hour: H, measured: { delhi: { ...IDLE_CITY_DATA, status: "error", error: "OpenAQ timed out" } },
    });
    expect(screen.getByText("OpenAQ timed out")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect(store.getState().measured.delhi.status).toBe("loading");
  });

  it("uncertainty line uses the city key, else the default", () => {
    const { unmount } = setup(sim100, null);
    expect(screen.getByText("Shares are uncertain by about ±5 percentage points")).toBeInTheDocument();
    unmount();
    setup(sim100, null, { selectedCity: "ludhiana" });
    expect(screen.getByText("Shares are uncertain by about ±15 percentage points")).toBeInTheDocument();
  });

  it("states the fire smoke travel time when fire PM is at or above 15 ug/m3", () => {
    setup(sim100, null);
    expect(screen.getByText(/Fire smoke travel time to Delhi/)).toHaveTextContent("17 h");
  });

  it("no travel time when fire PM is negligible", () => {
    setup({ vehicles_delhi_ncr: flat(N, 60), fire_punjab: flat(N, 5) }, null);
    expect(screen.queryByText(/Fire smoke/)).toBeNull();
  });

  it("no travel time when the fire tags are weighted out", () => {
    const meta = makeMeta({ hours: N, cities: [delhi({ vehicles_delhi_ncr: flat(N, 60), firefc_punjab: flat(N, 40) })] });
    renderPanel(<CityPanel />, { meta, hour: H, firesContinue: false });
    expect(screen.queryByText(/Fire smoke/)).toBeNull();
  });

  it("says when smoke arrives, as the map label does", () => {
    const fire = flat(N, 0);
    fire[H + 3] = 20;
    setup({ vehicles_delhi_ncr: flat(N, 60), fire_punjab: fire }, null);
    expect(screen.getByText(/Fire smoke expected at Delhi/)).toHaveTextContent("arrives +3 h");
  });

  it("bar segment widths are proportional to the shares", () => {
    setup(sim100, null);
    expect(screen.getByTestId("seg-local:vehicles").style.width).toBe("60%");
    expect(screen.getByTestId("seg-fire:punjab").style.width).toBe("40%");
  });

  it("displayed shares sum to 100", () => {
    const third = flat(N, 30);
    setup({ vehicles_delhi_ncr: third, industry_delhi_ncr: third, residential_delhi_ncr: third }, null);
    const shares = within(screen.getByRole("list", { name: "Where it came from" })).getAllByText(/%$/).map((e) => parseInt(e.textContent!, 10));
    expect(shares.reduce((a, b) => a + b, 0)).toBe(100);
  });

  it("switching city while measured data is in flight shows the new city's loading state", () => {
    const { store } = setup(sim100, flat(N, 160));
    expect(screen.getByTestId("measured-aqi")).toBeInTheDocument();
    act(() => store.getState().selectCity("ludhiana"));
    expect(screen.getByText("Ludhiana · receptor")).toBeInTheDocument();
    expect(screen.getByText("fetching CPCB data…")).toBeInTheDocument();
  });

  it("clicking the chart moves the playhead to that hour", () => {
    const { store } = setup(sim100, null);
    const svg = screen.getByRole("img", { name: /Model vs measured/ });
    svg.getBoundingClientRect = () => ({ left: 0, top: 0, width: 288, height: 150, right: 288, bottom: 150, x: 0, y: 0, toJSON: () => ({}) });
    // plot spans x 24..284 (260 px) over hours 0..29: hour 10 sits at 24 + 10/29*260
    fireEvent.click(svg, { clientX: 24 + (10 / 29) * 260, clientY: 50 });
    expect(store.getState().hour).toBe(10);
  });

  it("dashes the model from forecast_from and shades from fires_assumed_from", () => {
    const meta = makeMeta({ hours: N, forecast_from: 24, fires_assumed_from: 20, cities: [delhi(sim100)] });
    const { container } = renderPanel(<CityPanel />, { meta, hour: H });
    const x = (h: number) => Math.round((24 + (h / 29) * 260) * 10) / 10;
    const dashed = container.querySelector("path.line-model.forecast")!;
    expect(dashed.getAttribute("d")!.startsWith(`M${x(24)},`)).toBe(true);
    const band = container.querySelector(".fires-band rect")!;
    expect(Number(band.getAttribute("x"))).toBeCloseTo(24 + (20 / 29) * 260, 6);
    expect(within(screen.getByRole("img", { name: /Model vs measured/ })).getByText("fires assumed")).toBeInTheDocument();
  });

  it("tags the header and breakdown title 'fires assumed' or 'forecast' at the playhead hour", () => {
    const meta = makeMeta({ hours: N, forecast_from: 24, fires_assumed_from: 20, cities: [delhi(sim100)] });
    const { store } = renderPanel(<CityPanel />, { meta, hour: 19 });
    expect(screen.queryAllByTestId("hour-tag")).toHaveLength(0);
    act(() => store.getState().setHour(20));
    const tags = screen.getAllByTestId("hour-tag");
    expect(tags.map((t) => t.textContent)).toEqual(["fires assumed", "fires assumed"]);
    expect(within(screen.getByTestId("breakdown-title")).getByTestId("hour-tag")).toBeInTheDocument();
    act(() => store.getState().setHour(25));
    expect(screen.getAllByTestId("hour-tag").map((t) => t.textContent)).toEqual(["forecast", "forecast"]);
  });

  it("labels the 24 h mean beside the category and the hourly value beneath", () => {
    const veh = flat(N, 60).map((v, h) => (h === H ? 300 : v)); // hour H: 340, others 100
    const meta = makeMeta({ hours: N, cities: [delhi({ vehicles_delhi_ncr: veh, fire_punjab: flat(N, 40) })] });
    renderPanel(<CityPanel />, { meta, hour: H });
    // 24 h mean over hours 0..20: (20 x 100 + 340) / 21 = 111.4
    expect(screen.getByTestId("sim-category").textContent).toMatch(/· PM2\.5 111 µg\/m³ \(24 h mean\)$/);
    expect(screen.getByTestId("sim-hourly").textContent).toBe("this hour: 340 µg/m³");
  });

  it("CAMS failure: 'Copernicus: failed to load' with the error as tooltip", () => {
    const meta = makeMeta({ hours: N, cities: [delhi(sim100)] });
    renderPanel(<CityPanel />, { meta, hour: H, cams: { delhi: { ...IDLE_CITY_DATA, status: "error", error: "HTTP 502" } } });
    const legend = screen.getByTestId("cams-failed");
    expect(legend.textContent).toBe("Copernicus: failed to load");
    expect(legend.getAttribute("title")).toBe("HTTP 502");
    expect(screen.queryByText("n/a")).toBeNull();
  });

  it("draws the model vs measured chart with a now marker", () => {
    setup(sim100, flat(N, 160));
    expect(screen.getByRole("img", { name: /Model vs measured/ })).toBeInTheDocument();
    expect(screen.getByTestId("chart-now")).toBeInTheDocument();
  });
});
