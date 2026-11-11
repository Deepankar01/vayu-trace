import { fireEvent, screen, within } from "@testing-library/react";
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
    expect(screen.getByText(/Poor · PM2\.5 100 µg\/m³/)).toBeInTheDocument();
    expect(screen.getByText("PM2.5-based AQI (24 h)")).toBeInTheDocument();
  });

  it("shows a dash and the reason when the 24-hour mean is not available", () => {
    const meta = makeMeta({ hours: N, cities: [delhi(sim100)] });
    renderPanel(<CityPanel />, { meta, hour: 5 });
    expect(screen.getByTestId("sim-aqi")).toHaveTextContent("–");
    expect(screen.getByText("needs 16 h of data")).toBeInTheDocument();
  });

  it("always explains why the model reads low", () => {
    setup(sim100, null);
    expect(screen.getByText(/simulates directly emitted PM2\.5 only/)).toBeInTheDocument();
  });

  it("sim 100 / measured 160: Not explained by model 38% (37.5 rounded), error on 24 h means", () => {
    setup(sim100, flat(N, 160));
    const rows = legend();
    expect(rows.getByText("Not explained by model")).toBeInTheDocument();
    expect(rows.getByTestId("share-unexplained")).toHaveTextContent("38%");
    // measured AQI pm25ToAqi(160) = 330.8 -> 331; model -37.5% -> "−38%"
    expect(screen.getByTestId("measured-aqi")).toHaveTextContent("331");
    expect(screen.getByText("model −38%")).toBeInTheDocument();
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
    expect(screen.getByText("PM2.5 93 µg/m³ this hour")).toBeInTheDocument();
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
    expect(screen.getByText("Shares are uncertain by about ±10 percentage points")).toBeInTheDocument();
  });

  it("states the fire smoke travel time", () => {
    setup(sim100, null);
    expect(screen.getByText(/Fire smoke travel time to Delhi/)).toHaveTextContent("17 h");
  });

  it("draws the model vs measured chart with a now marker", () => {
    setup(sim100, flat(N, 160));
    expect(screen.getByRole("img", { name: /Model vs measured/ })).toBeInTheDocument();
    expect(screen.getByTestId("chart-now")).toBeInTheDocument();
  });
});
