/**
 * Top bar: product name, run date (a new date starts a new run), IST clock for the playhead,
 * layer chips, and weather readouts for the selected city (Delhi by default) at the playhead.
 */
import type { Layers } from "../state/store";
import { DASH, compass16, fmtIST } from "../lib/format";
import { useApp, useAppStore } from "./storeContext";
import { cityOf } from "./ui";

export const FALLBACK_MIN_DATE = "2018-04-01"; // server/vayu/api.py MIN_DATE, until meta arrives
const todayUtc = () => new Date().toISOString().slice(0, 10);

const at = (series: (number | null)[] | undefined, h: number) => {
  const v = series?.[h];
  return v != null && Number.isFinite(v) ? v : null;
};

function Readout({ label, value, id }: { label: string; value: string; id: string }) {
  return (
    <div className="chip readout" data-testid={id}>
      {label} <b className="num">{value}</b>
    </div>
  );
}

function Chip({ label, on, onClick, title }: { label: string; on: boolean; onClick: () => void; title?: string }) {
  return (
    <button type="button" className={`chip chip-btn${on ? " on" : ""}`} aria-pressed={on} onClick={onClick} title={title}>
      {label}
    </button>
  );
}

export function TopBar({ onDate }: { onDate: (date: string) => void }) {
  const store = useAppStore();
  const meta = useApp((s) => s.meta);
  const hour = useApp((s) => Math.floor(s.hour));
  const layers = useApp((s) => s.layers);
  const compare = useApp((s) => s.compareBaseline);
  const selected = useApp((s) => s.selectedCity);
  const date = meta?.date ?? "";

  const city = cityOf(meta, selected);
  const met = city?.met;
  const windMs = at(met?.wind_ms, hour);
  const dir = met ? met.wind_dir_deg[hour] ?? null : null;
  const rh = at(met?.rh, hour);
  const temp = at(met?.temp_c, hour);
  const blh = at(met?.blh_m, hour);
  const est = meta?.notes.blh_estimated ? " est." : "";
  // wind_dir_deg null = calm (the server's convention); speed is still shown when known
  const wind = !met ? DASH : dir === null ? "Calm" : `${compass16(dir)} ${windMs === null ? DASH : Math.round(windMs * 3.6)} km/h`;

  const plume = (mode: "pm25" | "aqi") => {
    const s = store.getState();
    s.setCompareBaseline(false);
    const turnOff = s.layers[mode] && !compare;
    s.setLayer(mode === "pm25" ? "aqi" : "pm25", false);
    s.setLayer(mode, !turnOff);
  };
  const toggle = (name: keyof Layers) => store.getState().setLayer(name, !layers[name]);

  return (
    <header className="panel top" aria-label="Run and layers">
      <div className="brand">VAYU<span>·</span>TRACE</div>
      <label className="chip date-chip">
        <span className="sr-only">Run date</span>
        <input
          type="date" aria-label="Run date" value={date}
          min={meta?.notes.min_date ?? FALLBACK_MIN_DATE} max={todayUtc()}
          onChange={(e) => e.target.value && e.target.value !== date && onDate(e.target.value)}
        />
      </label>
      <div className="chip clock num" data-testid="ist-clock">
        {meta ? fmtIST(meta.hours[hour]) : DASH}
      </div>
      <div className="chip-group" role="group" aria-label="Layers">
        <Chip label="PM2.5" on={layers.pm25 && !layers.aqi && !compare} onClick={() => plume("pm25")} />
        <Chip label="AQI" on={layers.aqi && !compare} onClick={() => plume("aqi")}
          title="Hourly PM2.5 shown on the 24-hour AQI scale — indicative" />
        <Chip label="Wind" on={layers.wind} onClick={() => toggle("wind")} />
        <Chip label="Fires" on={layers.fires} onClick={() => toggle("fires")} />
        <Chip label="Terrain 3D" on={layers.terrain} onClick={() => toggle("terrain")} />
      </div>
      <div className="spacer" />
      <div className="readouts" aria-label={city ? `Weather at ${city.name}` : "Weather"}>
        <Readout id="ro-wind" label="Wind" value={wind} />
        <Readout id="ro-rh" label="Humidity" value={rh === null ? DASH : `${Math.round(rh * 100)}%`} />
        <Readout id="ro-temp" label="Temp" value={temp === null ? DASH : `${Math.round(temp)}°C`} />
        <Readout id="ro-blh" label="Mixing height" value={blh === null ? DASH : `${Math.round(blh)} m${est}`} />
      </div>
    </header>
  );
}
