/**
 * Right panel: the selected city (Delhi by default) as a receptor. Simulated PM2.5-based AQI next
 * to the measured CPCB value, where the PM2.5 came from at the playhead hour, smoke travel time,
 * and model vs measured vs Copernicus over the window. Missing data is said, never drawn as 0.
 */
import { useMemo, type ReactNode } from "react";
import { useMapStatus } from "../map/mapStatus";
import { aqiCategory, aqiColor } from "../lib/colors";
import { arrival } from "../lib/breakdown";
import { DASH, fmtError, fmtISTHour, fmtNumber, fmtShare, fmtSharesToWhole } from "../lib/format";
import { fireSeries } from "../map/layers/cities";
import { IDLE_CITY_DATA } from "../state/store";
import { measuredAt, noMeasuredInWindow, cityView } from "./cityView";
import { ModelChart } from "./ModelChart";
import { useApp, useAppStore } from "./storeContext";
import { Dot, HourTag, cityOf } from "./ui";

export const MODEL_SCOPE_NOTE =
  "The model simulates directly emitted PM2.5 only. Secondary aerosol and inflow from outside India are not simulated. " +
  "In the November 2025 validation it read low on average, though individual hours can read high. See Validation.";

export function CityPanel() {
  const store = useAppStore();
  const meta = useApp((s) => s.meta);
  const selected = useApp((s) => s.selectedCity);
  const hourF = useApp((s) => s.hour);
  const weights = useApp((s) => s.weights());
  const users = useApp((s) => s.userSources);
  const measuredMap = useApp((s) => s.measured);
  const camsMap = useApp((s) => s.cams);
  const pathHour = useMapStatus((m) => m.pathHour);

  const city = cityOf(meta, selected);
  const h = Math.floor(hourF);
  const nHours = meta?.hours.length ?? 0;
  const measured = (city && measuredMap[city.id]) || IDLE_CITY_DATA;
  const cams = (city && camsMap[city.id]) || IDLE_CITY_DATA;
  const m = measuredAt(measured.status === "ready" ? measured.values : null, h);
  const labels = useMemo(() => Object.fromEntries(users.map((u) => [u.id, u.label])), [users]);
  const view = useMemo(
    () => (city ? cityView(city, weights, h, nHours, m.hourly, labels) : null),
    [city, weights, h, nHours, m.hourly, labels],
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
  const simAqi = view.simAqi === null ? null : Math.round(view.simAqi);
  const err = fmtError(view.simMean, m.mean);
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
  } else if (m.aqi === null && m.hourly !== null) {
    // a reading this hour, but too few in the last 24 h for the AQI
    measuredBody = <div className="m-aqi num mute" data-testid="measured-aqi-missing">–</div>;
    measuredDetail = (
      <>
        <span className="num">measured PM2.5 {fmtNumber(m.hourly)} µg/m³ this hour</span>
        <span>24 h mean needs 16 h of data</span>
      </>
    );
  } else if (m.aqi === null) {
    measuredBody = <div className="m-msg">No CPCB data for this hour</div>;
  } else {
    measuredBody = <div className="m-aqi num" data-testid="measured-aqi" style={{ color: aqiColor(m.aqi) }}>{Math.round(m.aqi)}</div>;
    measuredDetail = (
      <>
        {err && <span className="num">model {err} <span className="mute">(24 h means)</span></span>}
        <span className="num">{measured.stationCount === 1 ? "1 station" : `${measured.stationCount} stations`}</span>
      </>
    );
  }

  let camsNote: string | null = null;
  if (cams.status === "loading" || cams.status === "idle") camsNote = "loading…";
  else if (cams.status === "error") camsNote = "n/a";
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
            <div className={simAqi === null ? "big num mute" : "big num"} data-testid="sim-aqi">
              {simAqi === null ? DASH : simAqi}
            </div>
            <HourTag />
          </div>
          {simAqi === null ? (
            <div className="sev mute">needs 16 h of data</div>
          ) : (
            <div className="sev num" data-testid="sim-category" style={{ color: aqiColor(simAqi) }}>
              {aqiCategory(simAqi)} · PM2.5 {fmtNumber(view.simMean)} µg/m³ (24 h mean)
            </div>
          )}
          <div className="caption num" data-testid="sim-hourly">this hour: {fmtNumber(view.simHourly)} µg/m³</div>
        </div>
        <div className="measured" aria-label="Measured">
          <div className="mute">measured (CPCB)</div>
          {measuredBody}
        </div>
      </div>
      <p className="aqi-detail" data-testid="aqi-detail">
        <span>PM2.5-based AQI (24 h)</span>
        {measuredDetail}
      </p>
      <p className="explain">{MODEL_SCOPE_NOTE}</p>

      <div className="sep" />
      <h4 data-testid="breakdown-title">Where it came from · <span className="nocase">{hourLabel} (this hour)</span> <HourTag /></h4>
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
                <span className="name"><Dot color={r.color} />{r.label}</span>
                <span className="v num" data-testid={`share-${r.kind === "minor" ? "minor" : r.kind === "unexplained" ? "unexplained" : r.key}`}>
                  {shareText[i]}
                </span>
              </li>
            ))}
          </ul>
          {m.hourly !== null && view.simHourly !== null && (
            <p className="hour-compare num">
              This hour: model {fmtNumber(view.simHourly)} vs measured {fmtNumber(m.hourly)} µg/m³
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

      <div className="sep" />
      <h4>Model vs measured · <span className="nocase">hourly PM2.5, µg/m³</span></h4>
      <ModelChart
        hours={meta.hours} sim={view.totals}
        measured={measured.status === "ready" ? measured.values : null}
        cams={cams.status === "ready" ? cams.values : null}
        camsNote={camsNote} measuredNote={measuredNote}
        hour={hourF} forecastFrom={meta.forecast_from} firesAssumedFrom={meta.fires_assumed_from}
        onSeek={(x) => store.getState().setHour(x)}
      />
    </div>
  );
}
