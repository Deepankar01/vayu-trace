import { act, fireEvent, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { CityMeta } from "../api/types";
import { IDLE_CITY_DATA } from "../state/store";
import { makeMeta } from "../test-utils/meta";
import { flat, measuredReady, renderPanel } from "../test-utils/panels";
import { CityPanel, MODEL_SCOPE_NOTE_COARSE } from "./CityPanel";
import { cityView, coarseMeasured } from "./cityView";

const N = 30;
const H = 20;

function delhi(byTag: Record<string, (number | null)[]>, over: Partial<CityMeta> = {}): CityMeta {
  return {
    id: "delhi", name: "Delhi", lat: 28.6, lon: 77.2, region: "delhi_ncr", by_tag: byTag, by_tag_local: {},
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
    // header, breakdown title, made-here title
    expect(tags.map((t) => t.textContent)).toEqual(["fires assumed", "fires assumed", "fires assumed"]);
    expect(within(screen.getByTestId("breakdown-title")).getByTestId("hour-tag")).toBeInTheDocument();
    act(() => store.getState().setHour(25));
    expect(screen.getAllByTestId("hour-tag").map((t) => t.textContent)).toEqual(["forecast", "forecast", "forecast"]);
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

// --- PM10 and coarse PM ---

// fine 100 (60 local vehicles + 40 Punjab fires), coarse 50 (30 local dust + 20 local vehicles)
const simBoth = {
  ...sim100, coarse_dust_delhi_ncr: flat(N, 30), coarse_vehicles_delhi_ncr: flat(N, 20),
};
const local = { vehicles_delhi_ncr: flat(N, 54), coarse_dust_delhi_ncr: flat(N, 27), coarse_vehicles_delhi_ncr: flat(N, 6) };

function setupPollutant(pollutant: "pm25" | "pm10" | "coarse", pm10: (number | null)[] | null, pm25: (number | null)[] | null, extra = {}) {
  const meta = makeMeta({ hours: N, cities: [delhi(simBoth, { by_tag_local: local })] });
  return renderPanel(<CityPanel />, {
    meta, hour: H, pollutant,
    measured: pm25 ? { delhi: measuredReady(pm25, 6) } : {},
    measuredPm10: pm10 ? { delhi: measuredReady(pm10, 4) } : {},
    ...extra,
  });
}

describe("CityPanel: PM2.5 view with coarse tags in the run", () => {
  it("is unchanged by them: fine tags only, no measured-coarse row", () => {
    setupPollutant("pm25", flat(N, 300), flat(N, 160));
    expect(screen.getByTestId("sim-aqi")).toHaveTextContent("233");
    expect(screen.getByTestId("sim-hourly").textContent).toBe("this hour: 100 µg/m³");
    expect(screen.getByTestId("measured-aqi")).toHaveTextContent("331"); // CPCB PM2.5, not PM10
    expect(screen.getByTestId("seg-local:vehicles").style.width).toBe("37.5%"); // 60 of 160
    expect(legend().queryByText(/dust/)).toBeNull();
    expect(screen.queryByTestId("measured-coarse")).toBeNull();
    expect(screen.getByText("PM2.5-based AQI (24 h)")).toBeInTheDocument();
  });
});

describe("CityPanel: PM10 view", () => {
  it("numbers, labels and AQI are PM10's", () => {
    setupPollutant("pm10", flat(N, 300), flat(N, 160));
    // pm10ToAqi(150) = 133.3; measured pm10ToAqi(300) = 250
    expect(screen.getByTestId("sim-aqi")).toHaveTextContent("133");
    expect(screen.getByTestId("sim-category")).toHaveTextContent(/Moderate · PM10 150 µg\/m³ \(24 h mean\)/);
    expect(screen.getByTestId("sim-hourly").textContent).toBe("this hour: 150 µg/m³");
    expect(screen.getByTestId("measured-aqi")).toHaveTextContent("250");
    expect(screen.getByTestId("aqi-detail")).toHaveTextContent("PM10-based AQI (24 h)model −50% (24 h means)4 stations");
    expect(screen.getByText(/hourly PM10, µg\/m³/)).toBeInTheDocument();
    expect(screen.getByRole("img", { name: /hourly PM10 over the run window/ })).toBeInTheDocument();
    expect(screen.getByText(MODEL_SCOPE_NOTE_COARSE)).toBeInTheDocument();
  });

  it("breakdown: coarse folded into the fine rows, shares of measured PM10", () => {
    setupPollutant("pm10", flat(N, 300), flat(N, 160));
    // local vehicles 60 + 20 = 80, fires 40, local dust 30, gap 150 of 300
    expect(parseFloat(screen.getByTestId("seg-local:vehicles").style.width)).toBeCloseTo((80 / 300) * 100, 3);
    expect(legend().getByTestId("share-fire:punjab")).toHaveTextContent("13%");
    expect(legend().getByTestId("share-local:dust")).toHaveTextContent("10%");
    expect(legend().getByTestId("share-unexplained")).toHaveTextContent("50%");
    expect(screen.getByText("This hour: model 150 vs measured 300 µg/m³")).toBeInTheDocument();
  });

  it("marks the dust row 'estimated' with the source; not when the run's dust is not an estimate", () => {
    const { unmount } = setupPollutant("pm10", null, null);
    const row = legend().getByText("Local road and construction dust").closest("li")!;
    const tag = within(row).getByTestId("estimated-tag");
    expect(tag).toHaveTextContent("estimated");
    expect(tag).toHaveAttribute("title", makeMeta().notes.dust_source);
    expect(tag).toHaveAttribute("aria-description", makeMeta().notes.dust_source);
    expect(within(legend().getByText("Local vehicles").closest("li")!).queryByTestId("estimated-tag")).toBeNull();
    unmount();
    const meta = makeMeta({ hours: N, cities: [delhi(simBoth)], notes: { ...makeMeta().notes, dust_estimated: false } });
    renderPanel(<CityPanel />, { meta, hour: H, pollutant: "pm10" });
    expect(screen.queryByTestId("estimated-tag")).toBeNull();
  });

  it("measured coarse row: PM10 − PM2.5 at this hour beside the model's coarse value", () => {
    setupPollutant("pm10", flat(N, 300), flat(N, 160));
    expect(screen.getByTestId("measured-coarse")).toHaveTextContent(
      "Measured coarse (PM10 − PM2.5): 140 µg/m³ · model coarse 50 µg/m³ · this hour; shown for comparison, not used by the model",
    );
  });

  it("measured coarse row: a dash when either series is missing at this hour, 0 when PM10 reads below PM2.5", () => {
    const gap = flat(N, 160);
    gap[H] = null;
    const a = setupPollutant("pm10", flat(N, 300), gap);
    expect(screen.getByTestId("measured-coarse")).toHaveTextContent("Measured coarse (PM10 − PM2.5): – µg/m³ · model coarse 50 µg/m³");
    a.unmount();
    const b = setupPollutant("pm10", flat(N, 300), null); // PM2.5 not loaded
    expect(screen.getByTestId("measured-coarse")).toHaveTextContent("Measured coarse (PM10 − PM2.5): – µg/m³");
    b.unmount();
    setupPollutant("pm10", flat(N, 120), flat(N, 160));
    expect(screen.getByTestId("measured-coarse")).toHaveTextContent("Measured coarse (PM10 − PM2.5): 0 µg/m³ · model coarse 50 µg/m³");
  });

  it("the measurement never changes the model's numbers", () => {
    const a = setupPollutant("pm10", flat(N, 300), flat(N, 160));
    const model = () => [screen.getByTestId("sim-aqi").textContent, screen.getByTestId("sim-hourly").textContent, screen.getByTestId("mh-local").textContent];
    const withData = model();
    a.unmount();
    setupPollutant("pm10", null, null);
    expect(model()).toEqual(withData);
  });

  it("uses the PM10 Copernicus series, not the PM2.5 one", () => {
    setupPollutant("pm10", null, null, {
      cams: { delhi: { ...IDLE_CITY_DATA, status: "error", error: "pm25 failed" } },
      camsPm10: { delhi: { ...IDLE_CITY_DATA, status: "ready", values: flat(N, 210) } },
    });
    expect(screen.queryByTestId("cams-failed")).toBeNull();
    expect(screen.getByText("Copernicus CAMS")).toBeInTheDocument();
    expect(screen.getByText("210")).toBeInTheDocument(); // the chart readout at the playhead
  });

  it("made here vs arrived follows the pollutant, with the PM2.5 vs coarse line", () => {
    setupPollutant("pm10", null, null);
    expect(screen.getByTestId("made-here-title")).toHaveTextContent("Made here vs arrived · PM10 (this hour)");
    expect(screen.getByTestId("mh-local")).toHaveTextContent("87 µg/m³58%"); // 54 + 27 + 6 of 150
    expect(screen.getByTestId("made-here-compare")).toHaveTextContent("Made here: PM2.5 54% · coarse 66%");
    expect(screen.getByTestId("deposition-note")).toHaveTextContent("5× faster");
  });
});

describe("CityPanel: coarse view", () => {
  it("shows 24 h mean concentrations and no AQI anywhere", () => {
    setupPollutant("coarse", flat(N, 300), flat(N, 160));
    expect(screen.queryByTestId("sim-aqi")).toBeNull();
    expect(screen.queryByTestId("measured-aqi")).toBeNull();
    expect(screen.getByTestId("sim-mean")).toHaveTextContent("50");
    expect(screen.getByTestId("sim-category")).toHaveTextContent("model coarse PM, µg/m³ (24 h mean)");
    expect(screen.getByTestId("measured-mean")).toHaveTextContent("140");
    expect(screen.getByText("measured (CPCB, PM10 − PM2.5)")).toBeInTheDocument();
    expect(screen.getByTestId("aqi-detail")).toHaveTextContent(
      "Coarse PM, 2.5–10 µm · 24 h means, no AQImodel −64% (24 h means)PM10: 4 stations · PM2.5: 6 stations",
    );
    expect(screen.queryByText(/-based AQI/)).toBeNull();
    expect(screen.queryByText(/Poor|Moderate|Severe|Satisfactory|Good/)).toBeNull();
  });

  it("breakdown: coarse tags only under the fine row names, shares of measured coarse", () => {
    setupPollutant("coarse", flat(N, 300), flat(N, 200)); // measured coarse 100
    expect(screen.getByTestId("seg-local:dust").style.width).toBe("30%");
    expect(screen.getByTestId("seg-local:vehicles").style.width).toBe("20%");
    expect(legend().getByTestId("share-unexplained")).toHaveTextContent("50%");
    expect(legend().queryByText(/Fires/)).toBeNull(); // the run has no coarse fire PM here
    expect(screen.getByTestId("measured-coarse")).toHaveTextContent("Measured coarse (PM10 − PM2.5): 100 µg/m³ · model coarse 50 µg/m³");
    expect(screen.queryByText(/^This hour: model/)).toBeNull(); // the row above already says it
  });

  it("no Copernicus line, readout or legend entry; the dots are CPCB PM10 − PM2.5", () => {
    const { container } = setupPollutant("coarse", flat(N, 300), flat(N, 160), {
      cams: { delhi: { ...IDLE_CITY_DATA, status: "ready", values: flat(N, 999) } },
    });
    expect(screen.queryByText(/Copernicus/)).toBeNull();
    expect(container.querySelector(".line-cams")).toBeNull();
    expect(container.querySelectorAll(".chart-readout .key-cams")).toHaveLength(0);
    expect(screen.getByText("CPCB (PM10 − PM2.5)")).toBeInTheDocument();
    expect(screen.getByText(/hourly coarse PM, µg\/m³/)).toBeInTheDocument();
  });

  it("waits for both CPCB series, and reports which one failed", () => {
    const a = setupPollutant("coarse", flat(N, 300), null);
    expect(screen.getByText("fetching CPCB data…")).toBeInTheDocument();
    a.unmount();
    setupPollutant("coarse", null, flat(N, 160), {
      measuredPm10: { delhi: { ...IDLE_CITY_DATA, status: "error", error: "OpenAQ timed out" } },
    });
    expect(screen.getByText("PM10: OpenAQ timed out")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Retry" })).toBeInTheDocument();
  });

  it("a user-added source is not part of coarse PM", () => {
    const meta = makeMeta({ hours: N, cities: [delhi({ ...simBoth, user_1: flat(N, 500) })] });
    meta.tags = [...meta.tags, { id: "user_1", kind: "user", sector: null, region: null, label: "Kiln", color: "#999", size: "fine" }];
    renderPanel(<CityPanel />, { meta, hour: H, pollutant: "coarse" });
    expect(screen.getByTestId("sim-hourly").textContent).toBe("this hour: 50 µg/m³");
    expect(legend().queryByText("Kiln")).toBeNull();
  });
});

describe("cityView and coarseMeasured", () => {
  const city = delhi(simBoth);
  const w = { vehicles_delhi_ncr: 1, fire_punjab: 1, coarse_dust_delhi_ncr: 1, coarse_vehicles_delhi_ncr: 1 };
  it("defaults to PM2.5 and ignores the coarse tags there", () => {
    const v = cityView(city, w, H, N, null, {});
    expect(v.simHourly).toBe(100);
    expect(v.simCoarseHourly).toBeNull();
    expect(v.legend.map((r) => r.key)).toEqual(["fire:punjab", "local:vehicles"]);
  });
  it("weights reach the folded rows through the fine id's coarse twin weight", () => {
    const v = cityView(city, { ...w, coarse_dust_delhi_ncr: 0, dust_delhi_ncr: 0 } as never, H, N, null, {}, "coarse");
    expect(v.simHourly).toBe(20);
    expect(v.simAqi).toBeNull();
    expect(v.legend.map((r) => [r.key, r.sector])).toEqual([["local:vehicles", "vehicles"]]);
  });
  it("coarseMeasured: loading until both are ready, then the difference and the smaller station count", () => {
    const ready = (values: (number | null)[], n: number) => measuredReady(values, n);
    expect(coarseMeasured(ready([1], 2), IDLE_CITY_DATA).status).toBe("loading");
    expect(coarseMeasured(ready([180, null, 90], 4), ready([100, 50, 100], 6))).toEqual({
      status: "ready", values: [80, null, 0], stationCount: 4, error: null,
    });
    expect(coarseMeasured(ready([1], 2), { ...IDLE_CITY_DATA, status: "error", error: "x" })).toMatchObject({ status: "error", error: "PM2.5: x" });
  });
});
