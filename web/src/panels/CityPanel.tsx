/**
 * Right panel: the selected city (Delhi by default) as a receptor. Simulated PM2.5-based AQI next
 * to the measured CPCB value, where the PM2.5 came from at the playhead hour, smoke travel time,
 * and model vs measured vs Copernicus over the window. Missing data is said, never drawn as 0.
 */
import { useMemo } from "react";
import { useMapStatus } from "../map/mapStatus";
import { aqiCategory, aqiColor } from "../lib/colors";
import { DASH, fmtError, fmtISTHour, fmtNumber, fmtShare } from "../lib/format";
import { IDLE_CITY_DATA } from "../state/store";
import { measuredAt, noMeasuredInWindow, cityView } from "./cityView";
import { ModelChart } from "./ModelChart";
import { useApp, useAppStore } from "./storeContext";
import { Dot, cityOf } from "./ui";

export const LOW_EXPLANATION =
  "The model simulates directly emitted PM2.5 only. Secondary aerosol and inflow from outside India are not simulated, so it usually reads low.";

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

  if (!meta || !city || !view) return null;

  const retry = () => store.getState().selectCity(city.id);
  const uncertainty = (meta.notes.share_uncertainty_pp as Record<string, number>)[city.id] ?? meta.notes.share_uncertainty_pp.default;
  const simAqi = view.simAqi === null ? null : Math.round(view.simAqi);
  const age = city.fire_age_h[h];
  const err = fmtError(view.simMean, m.mean);
  const noneInWindow = measured.status === "ready" && noMeasuredInWindow(measured.values, measured.stationCount);

  let measuredBody;
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
    measuredBody = (
      <>
        <div className="m-aqi num mute" data-testid="measured-aqi-missing">–</div>
        <div className="num">PM2.5 {fmtNumber(m.hourly)} µg/m³ this hour</div>
        <div className="mute">24 h mean needs 16 h of data</div>
      </>
    );
  } else if (m.aqi === null) {
    measuredBody = <div className="m-msg">No CPCB data for this hour</div>;
  } else {
    measuredBody = (
      <>
        <div className="m-aqi num" data-testid="measured-aqi" style={{ color: aqiColor(m.aqi) }}>{Math.round(m.aqi)}</div>
        {err && <div className="num">model {err}</div>}
        <div className="mute">{measured.stationCount === 1 ? "1 station" : `${measured.stationCount} stations`}</div>
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

  return (
    <div className="side-inner">
      <div className="city-head">
        <h4 className="h4-tight">{city.name} · receptor</h4>
        <div className="mute small">≈ {meta.notes.city_area_km} km area average</div>
      </div>

      <div className="aqi-row">
        <div>
          <div className={simAqi === null ? "big num mute" : "big num"} data-testid="sim-aqi">
            {simAqi === null ? DASH : simAqi}
          </div>
          {simAqi === null ? (
            <div className="sev mute">needs 16 h of data</div>
          ) : (
            <div className="sev num" style={{ color: aqiColor(simAqi) }}>
              {aqiCategory(simAqi)} · PM2.5 {fmtNumber(view.simHourly)} µg/m³
            </div>
          )}
          <div className="caption">PM2.5-based AQI (24 h)</div>
        </div>
        <div className="measured" aria-label="Measured">
          <div className="mute">measured (CPCB)</div>
          {measuredBody}
        </div>
      </div>
      <p className="explain">{LOW_EXPLANATION}</p>

      <div className="sep" />
      <h4>Where it came from</h4>
      {view.problem ? (
        <p className="note warn">{view.problem}</p>
      ) : (
        <>
          <div className="bar" aria-hidden="true">
            {view.legend.map((r) => (
              <div key={r.key} className={r.kind === "minor" ? "seg minor" : "seg"} style={{ width: `${((r.share ?? 0) / Math.max(1, total)) * 100}%`, background: r.color }} />
            ))}
          </div>
          <ul className="legend" aria-label="Where it came from">
            {view.legend.length === 0 && (
              <li><span className="name mute">No simulated contribution at this hour</span><span className="v num">{fmtShare(null)}</span></li>
            )}
            {view.legend.map((r) => (
              <li key={r.key} className={r.kind === "unexplained" ? "gap" : undefined}>
                <span className="name"><Dot color={r.color} />{r.label}</span>
                <span className="v num" data-testid={`share-${r.kind === "minor" ? "minor" : r.kind === "unexplained" ? "unexplained" : r.key}`}>
                  {fmtShare(r.share)}
                </span>
              </li>
            ))}
          </ul>
          {view.incomplete && <p className="flag">incomplete: some source data missing for this hour</p>}
          <p className="note">Shares are uncertain by about ±{uncertainty} percentage points</p>
        </>
      )}
      {age != null && Number.isFinite(age) && (
        <p className="smoke">
          Fire smoke travel time to {city.name}: <b className="num">{Math.round(age)} h</b>
          {pathHour !== null && (
            <span className="mute">
              {" "}along dotted path{pathHour !== h ? ` · path traced for ${fmtISTHour(meta.hours[pathHour])}` : ""}
            </span>
          )}
        </p>
      )}

      <div className="sep" />
      <h4>Model vs measured · <span className="nocase">PM2.5 µg/m³</span></h4>
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
