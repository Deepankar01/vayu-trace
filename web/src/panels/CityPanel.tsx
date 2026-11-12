/**
 * Right panel: the selected city (Delhi by default) as a receptor, for the pollutant in view
 * (PM2.5, PM10 or coarse PM). Simulated AQI next to the measured CPCB value (24 h mean
 * concentrations in the coarse view, which has no AQI), where it came from at the playhead hour,
 * made here vs arrived, smoke travel time, and model vs measured vs Copernicus over the window.
 * Missing data is said, never drawn as 0. Measurements are shown beside the model, never fed
 * into it.
 */
import { useMemo, type ReactNode } from "react";
import { useMapStatus } from "../map/mapStatus";
import { aqiCategory, aqiColor } from "../lib/colors";
import { arrival } from "../lib/breakdown";
import { DASH, fmtError, fmtISTHour, fmtNumber, fmtShare, fmtSharesToWhole } from "../lib/format";
import { COARSE_LONG, NO_COARSE_AQI, POLLUTANT_INLINE, measuredCoarse, type Pollutant } from "../lib/pollutant";
import { fireSeries } from "../map/layers/cities";
import { IDLE_CITY_DATA } from "../state/store";
import { coarseMeasured, measuredAt, noMeasuredInWindow, cityView } from "./cityView";
import { MadeHereBlock } from "./MadeHere";
import { ModelChart } from "./ModelChart";
import { useApp, useAppStore } from "./storeContext";
import { Dot, EstimatedTag, HourTag, cityOf } from "./ui";

export const MODEL_SCOPE_NOTE =
  "The model simulates directly emitted PM2.5 only. Secondary aerosol and non-fire emissions outside India are not simulated (fires there are). " +
  "In the November 2025 validation it read low on average, though individual hours can read high. See Validation.";
/** The same statement for the PM10 and coarse views, which add the coarse tags. */
export const MODEL_SCOPE_NOTE_COARSE =
  "The model simulates directly emitted particles only: PM2.5 and the coarse (2.5–10 µm) part of PM10. Secondary aerosol, " +
  "wind-blown soil and desert dust, and non-fire emissions outside India are not simulated (fires there are). " +
  "Road and construction dust is an estimate. See Validation.";

const stations = (n: number | null) => (n === 1 ? "1 station" : `${n ?? 0} stations`);
const MEASURED_HEAD: Record<Pollutant, string> = {
  pm25: "measured (CPCB)", pm10: "measured (CPCB)", coarse: "measured (CPCB, PM10 − PM2.5)",
};

export function CityPanel() {
  const store = useAppStore();
  const meta = useApp((s) => s.meta);
  const selected = useApp((s) => s.selectedCity);
  const hourF = useApp((s) => s.hour);
  const weights = useApp((s) => s.weights());
  const users = useApp((s) => s.userSources);
  const pollutant = useApp((s) => s.pollutant);
  const measuredMap = useApp((s) => s.measured);
  const measuredPm10Map = useApp((s) => s.measuredPm10);
  const camsMap = useApp((s) => s.cams);
  const camsPm10Map = useApp((s) => s.camsPm10);
  const pathHour = useMapStatus((m) => m.pathHour);

  const city = cityOf(meta, selected);
  const h = Math.floor(hourF);
  const nHours = meta?.hours.length ?? 0;
  const cpcb25 = (city && measuredMap[city.id]) || IDLE_CITY_DATA;
  const cpcb10 = (city && measuredPm10Map[city.id]) || IDLE_CITY_DATA;
  // the measurement of the pollutant in view; for coarse PM that is CPCB PM10 − PM2.5
  const measured = useMemo(
    () => (pollutant === "pm25" ? cpcb25 : pollutant === "pm10" ? cpcb10 : coarseMeasured(cpcb10, cpcb25)),
    [pollutant, cpcb25, cpcb10],
  );
  const cams = (city && pollutant !== "coarse" && (pollutant === "pm10" ? camsPm10Map : camsMap)[city.id]) || IDLE_CITY_DATA;
  const m = measuredAt(measured.status === "ready" ? measured.values : null, h, pollutant);
  const labels = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.label])), [users]);
  const view = useMemo(
    () => (city ? cityView(city, weights, h, nHours, m.hourly, labels, pollutant) : null),
    [city, weights, h, nHours, m.hourly, labels, pollutant],
  );

  // smoke status as on the map label: weighted fire PM at or above the 15 ug/m3 threshold
  const smoke = useMemo(() => {
    if (!city) return null;
    try {
      const fire = fireSeries(city, weights);
      if (h < 0 || h >= fire.length) return null;
      return arrival(fire, h, city.fire_age_h[h] ?? null);
    } catch {
      return null; // stale weights: the breakdown section reports the problem
    }
  }, [city, weights, h]);

  if (!meta || !city || !view) return null;

  const retry = () => store.getState().selectCity(city.id);
  const uncertainty = (meta.notes.share_uncertainty_pp as Record<string, number>)[city.id] ?? meta.notes.share_uncertainty_pp.default;
  const hasAqi = pollutant !== "coarse";
  const name = POLLUTANT_INLINE[pollutant];
  const simAqi = view.simAqi === null ? null : Math.round(view.simAqi);
  const err = fmtError(view.simMean, m.mean);
  const dustEstimated = meta.notes.dust_estimated === true;
  // evidence beside the model in the PM10 and coarse views: both CPCB series at this hour
  const cpcbCoarse =
    pollutant === "pm25" || cpcb10.status !== "ready" || cpcb25.status !== "ready"
      ? null
      : measuredCoarse(cpcb10.values?.[h], cpcb25.values?.[h]);
  const noneInWindow = measured.status === "ready" && noMeasuredInWindow(measured.values, measured.stationCount);

  // Right column: just the measured AQI (or a short state message). The details go on a
  // full-width line under both numbers, so long labels never squeeze the header.
  let measuredBody;
  let measuredDetail: ReactNode = null;
  if (measured.status === "loading" || measured.status === "idle") {
    measuredBody = <div className="m-msg">fetching CPCB data…</div>;
  } else if (measured.status === "error") {
    measuredBody = (
      <div className="m-msg err">
        <span>{measured.error}</span>
        <button type="button" className="link-btn" onClick={retry}>Retry</button>
      </div>
    );
  } else if (noneInWindow) {
    measuredBody = <div className="m-msg">No CPCB data for these dates</div>;
  } else if (m.mean === null && m.hourly !== null) {
    // a reading this hour, but too few in the last 24 h for the 24 h mean (and so the AQI)
    measuredBody = <div className="m-aqi num mute" data-testid="measured-aqi-missing">–</div>;
    measuredDetail = (
      <>
        <span className="num">measured {name} {fmtNumber(m.hourly)} µg/m³ this hour</span>
        <span>24 h mean needs 16 h of data</span>
      </>
    );
  } else if (m.mean === null) {
    measuredBody = <div className="m-msg">No CPCB data for this hour</div>;
  } else {
    measuredBody = m.aqi === null
      ? <div className="m-aqi num" data-testid="measured-mean">{fmtNumber(m.mean)}</div>
      : <div className="m-aqi num" data-testid="measured-aqi" style={{ color: aqiColor(m.aqi) }}>{Math.round(m.aqi)}</div>;
    measuredDetail = (
      <>
        {err && <span className="num">model {err} <span className="mute">(24 h means)</span></span>}
        {hasAqi
          ? <span className="num">{stations(measured.stationCount)}</span>
          : <span className="num">PM10: {stations(cpcb10.stationCount)} · PM2.5: {stations(cpcb25.stationCount)}</span>}
      </>
    );
  }

  let camsNote: string | null = null;
  if (!hasAqi) camsNote = null; // no CAMS line in the coarse view
  else if (cams.status === "loading" || cams.status === "idle") camsNote = "loading…";
  else if (!cams.values || cams.values.every((v) => v == null)) camsNote = "n/a for these dates";
  let measuredNote: string | null = null;
  if (measured.status === "loading" || measured.status === "idle") measuredNote = "loading…";
  else if (measured.status === "error" || noneInWindow) measuredNote = "no data";

  const total = view.legend.reduce((a, r) => a + (r.share ?? 0), 0);
  const shareText = fmtSharesToWhole(view.legend.map((r) => r.share));
  const hourLabel = fmtISTHour(meta.hours[h]);

  return (
    <div className="side-inner">
      <div className="city-head">
        <h4 className="h4-tight">{city.name} · receptor</h4>
        <div className="mute small">≈ {meta.notes.city_area_km} km area average</div>
      </div>

      <div className="aqi-row">
        <div className="sim-col">
          <div className="sim-aqi-line">
            {hasAqi ? (
              <div className={simAqi === null ? "big num mute" : "big num"} data-testid="sim-aqi">
                {simAqi === null ? DASH : simAqi}
              </div>
            ) : (
              // coarse PM alone has no AQI: the headline is the 24 h mean concentration itself
              <div className={view.simMean === null ? "big num mute" : "big num"} data-testid="sim-mean">
                {fmtNumber(view.simMean)}
              </div>
            )}
            <HourTag />
          </div>
          {view.simMean === null ? (
            <div className="sev mute">needs 16 h of data</div>
          ) : simAqi === null ? (
            <div className="sev num" data-testid="sim-category">
              <span className="nb">model coarse PM, µg/m³</span>{" "}
              <span className="nb">(24 h mean)</span>
            </div>
          ) : (
            <div className="sev num" data-testid="sim-category" style={{ color: aqiColor(simAqi) }}>
              {aqiCategory(simAqi)} ·{" "}
              <span className="nb">{name} {fmtNumber(view.simMean)} µg/m³</span>{" "}
              <span className="nb">(24 h mean)</span>
            </div>
          )}
          <div className="caption num" data-testid="sim-hourly">this hour: {fmtNumber(view.simHourly)} µg/m³</div>
        </div>
        <div className="measured" aria-label="Measured">
          <div className="mute">{MEASURED_HEAD[pollutant]}</div>
          {measuredBody}
        </div>
      </div>
      <p className="aqi-detail" data-testid="aqi-detail">
        {hasAqi ? <span>{name}-based AQI (24 h)</span> : <span title={NO_COARSE_AQI}>{COARSE_LONG} · 24 h means, no AQI</span>}
        {measuredDetail}
      </p>
      <p className="explain">{pollutant === "pm25" ? MODEL_SCOPE_NOTE : MODEL_SCOPE_NOTE_COARSE}</p>

      <div className="sep" />
      <h4 className="h4-tagged" data-testid="breakdown-title">
        <span className="h4-text">Where it came from · <span className="nocase">{hourLabel} (this hour)</span></span>
        <HourTag />
      </h4>
      {view.problem ? (
        <p className="note warn">{view.problem}</p>
      ) : (
        <>
          <div className="bar" aria-hidden="true">
            {view.legend.map((r) => (
              <div key={r.key} data-testid={`seg-${r.key}`} className={r.kind === "minor" ? "seg minor" : "seg"} style={{ width: `${((r.share ?? 0) / Math.max(1, total)) * 100}%`, background: r.color }} />
            ))}
          </div>
          <ul className="legend" aria-label="Where it came from">
            {view.legend.length === 0 && (
              <li><span className="name mute">No simulated contribution at this hour</span><span className="v num">{fmtShare(null)}</span></li>
            )}
            {view.legend.map((r, i) => (
              <li key={r.key} className={r.kind === "unexplained" ? "gap" : undefined}>
                <span className="name" title={r.label}>
                  <Dot color={r.color} />{r.label}
                  {dustEstimated && r.sector === "dust" && <EstimatedTag source={meta.notes.dust_source} />}
                </span>
                <span className="v num" data-testid={`share-${r.kind === "minor" ? "minor" : r.kind === "unexplained" ? "unexplained" : r.key}`}>
                  {shareText[i]}
                </span>
              </li>
            ))}
          </ul>
          {hasAqi && m.hourly !== null && view.simHourly !== null && (
            <p className="hour-compare num">
              This hour: model {fmtNumber(view.simHourly)} vs measured {fmtNumber(m.hourly)} µg/m³
            </p>
          )}
          {pollutant !== "pm25" && (
            <p className="hour-compare num" data-testid="measured-coarse">
              Measured coarse (PM10 − PM2.5): {fmtNumber(cpcbCoarse)} µg/m³ · model coarse {fmtNumber(view.simCoarseHourly)} µg/m³
              <span className="mute"> · this hour; shown for comparison, not used by the model</span>
            </p>
          )}
          {view.incomplete && <p className="flag">incomplete: some source data missing for this hour</p>}
          <p className="note share-note">Shares are uncertain by about ±{uncertainty} percentage points</p>
        </>
      )}
      {smoke?.kind === "arrives" && (
        <p className="smoke">
          Fire smoke expected at {city.name}: <b className="num">arrives +{smoke.in_h} h</b>
        </p>
      )}
      {smoke?.kind === "present" && (
        <p className="smoke">
          {smoke.age_h === null ? (
            <>Fire smoke present at {city.name}</>
          ) : (
            <>Fire smoke travel time to {city.name}: <b className="num">{Math.round(smoke.age_h)} h</b></>
          )}
          {pathHour !== null && (
            <span className="mute">
              {" "}along dotted path{pathHour !== h ? ` · path traced for ${fmtISTHour(meta.hours[pathHour])}` : ""}
            </span>
          )}
        </p>
      )}

      {!view.problem && (
        <>
          <div className="sep" />
          <MadeHereBlock city={city} weights={weights} hour={h} pollutant={pollutant} notes={meta.notes} />
        </>
      )}

      <div className="sep" />
      <h4>Model vs measured · <span className="nocase">hourly {name}, µg/m³</span></h4>
      <ModelChart
        hours={meta.hours} sim={view.totals} pollutant={name}
        measuredLabel={hasAqi ? "CPCB" : "CPCB (PM10 − PM2.5)"} showCams={hasAqi}
        measured={measured.status === "ready" ? measured.values : null}
        cams={cams.status === "ready" ? cams.values : null}
        camsNote={camsNote} camsError={cams.status === "error" ? (cams.error ?? "error") : null}
        measuredNote={measuredNote}
        hour={hourF} forecastFrom={meta.forecast_from} firesAssumedFrom={meta.fires_assumed_from}
        onSeek={(x) => store.getState().setHour(x)}
      />
    </div>
  );
}
