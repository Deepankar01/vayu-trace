/**
 * Top bar: product name, run date (a new date starts a new run; typed edits commit on Enter or
 * blur, picker choices at once), IST clock for the playhead, the pollutant in view (PM2.5, PM10
 * or coarse PM), layer chips (the plume as concentration or AQI, wind, fires, terrain), and weather readouts for the selected city (Delhi by default) at the playhead.
 */
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Layers } from "../state/store";
import { DASH, compass16, fmtIST } from "../lib/format";
import { COARSE_LONG, NO_COARSE_AQI, POLLUTANTS, POLLUTANT_INLINE, type Pollutant } from "../lib/pollutant";
import { useApp, useAppStore } from "./storeContext";
import { HourTag, cityOf } from "./ui";

export const FALLBACK_MIN_DATE = "2018-04-01"; // server/vayu/api.py MIN_DATE, until meta arrives
const todayUtc = () => new Date().toISOString().slice(0, 10);

const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;
export const DATE_NOTE =
  "Run date (UTC day). Dates are UTC days: until 05:30 IST the latest date is yesterday's IST date. Times shown in IST.";
export const TERRAIN_NOTE =
  "3D relief is visual only; data layers are drawn flat and can appear offset from peaks when the map is tilted";
const CALM_MS = 0.1;

const POLLUTANT_CHIP: Record<Pollutant, { label: string; title: string }> = {
  pm25: { label: "PM2.5", title: "Fine particles, up to 2.5 µm" },
  pm10: { label: "PM10", title: "PM2.5 plus coarse PM: particles up to 10 µm" },
  coarse: { label: "Coarse", title: `${COARSE_LONG} (PM10 minus PM2.5)` },
};
export const CONCENTRATION_CHIP = "µg/m³";
/** The AQI chip's tooltip: what the mode shows, or why it is unavailable (coarse PM). */
export function aqiChipNote(p: Pollutant): string {
  return p === "coarse" ? NO_COARSE_AQI : `Hourly ${POLLUTANT_INLINE[p]} shown on the 24-hour AQI scale — indicative`;
}

/**
 * The wind readout. A finite direction gives "NW 11 km/h". Without one (null or NaN, the server's
 * calm convention) the speed alone is shown when it is at least 0.1 m/s, else "Calm".
 */
export function windText(speedMs: number | null, dirDeg: number | null): string {
  const kmh = speedMs === null ? null : Math.round(speedMs * 3.6);
  if (dirDeg !== null && Number.isFinite(dirDeg)) return `${compass16(dirDeg)} ${kmh === null ? DASH : kmh} km/h`;
  if (speedMs !== null && speedMs >= CALM_MS) return `${kmh} km/h`;
  return speedMs === null ? DASH : "Calm";
}

/**
 * The run date input. Keyboard edits pass through invalid and intermediate dates ("0002-11-05",
 * "2025-11-01" on the way to "2025-11-15"), so typed values are only committed on Enter or blur;
 * a change without a preceding key press (the picker) commits at once. Values outside
 * [min, max] are not committed and a hint says why. It shows the requested date while that run
 * builds.
 */
function DateInput({ date, min, max, onDate }: { date: string; min: string; max: string; onDate: (d: string) => void }) {
  const [draft, setDraft] = useState(date);
  const [hint, setHint] = useState<string | null>(null);
  const typing = useRef(false);
  useEffect(() => setDraft(date), [date]);

  const commit = (v: string) => {
    typing.current = false;
    if (!ISO_DAY.test(v)) {
      setDraft(date);
      setHint(null);
      return;
    }
    if (v < min || v > max) {
      setHint(`Choose a date from ${min} to ${max}`);
      return;
    }
    setHint(null);
    if (v !== date) onDate(v);
  };

  return (
    <label className="chip date-chip" title={DATE_NOTE}>
      <input
        type="date" aria-label="Run date" aria-description={DATE_NOTE} value={draft} min={min} max={max}
        aria-invalid={hint !== null}
        onKeyDown={(e) => {
          if (e.key === "Enter") commit(e.currentTarget.value);
          else if (e.key === "Escape") {
            typing.current = false;
            setDraft(date);
            setHint(null);
          } else if (e.key !== "Tab") typing.current = true;
        }}
        onChange={(e) => {
          setDraft(e.target.value);
          if (!typing.current && e.target.value) commit(e.target.value);
        }}
        onBlur={(e) => typing.current && commit(e.target.value)}
      />
      {hint && <span className="date-hint" role="alert">{hint}</span>}
    </label>
  );
}

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

function Chip({ label, on, onClick, title, disabled }: {
  label: string; on: boolean; onClick: () => void; title?: string; disabled?: boolean;
}) {
  return (
    <button
      type="button" className={`chip chip-btn${on ? " on" : ""}`} aria-pressed={on} onClick={onClick} title={title}
      // a disabled chip says why to assistive technology too, not only on hover
      disabled={disabled} aria-description={disabled ? title : undefined}
    >
      {label}
    </button>
  );
}

export interface TopBarProps {
  /** The requested run date (shown while that run builds). */
  date: string;
  onDate: (date: string) => void;
  /** Extra controls at the right end of the bar (the Validation button). */
  actions?: ReactNode;
}

export function TopBar({ date: requested, onDate, actions }: TopBarProps) {
  const store = useAppStore();
  const meta = useApp((s) => s.meta);
  const hour = useApp((s) => Math.floor(s.hour));
  const layers = useApp((s) => s.layers);
  const compare = useApp((s) => s.compareBaseline);
  const pollutant = useApp((s) => s.pollutant);
  const selected = useApp((s) => s.selectedCity);
  const date = meta?.date ?? requested;

  const city = cityOf(meta, selected);
  const met = city?.met;
  const windMs = at(met?.wind_ms, hour);
  const dir = at(met?.wind_dir_deg, hour);
  const rh = at(met?.rh, hour);
  const temp = at(met?.temp_c, hour);
  const blh = at(met?.blh_m, hour);
  const est = meta?.notes.blh_estimated ? " est." : "";
  const wind = met ? windText(windMs, dir) : DASH;

  const plume = (mode: "pm25" | "aqi") => {
    const s = store.getState();
    s.setCompareBaseline(false);
    const turnOff = s.layers[mode] && !compare;
    s.setLayer(mode === "pm25" ? "aqi" : "pm25", false);
    s.setLayer(mode, !turnOff);
  };
  const toggle = (name: keyof Layers) => store.getState().setLayer(name, !layers[name]);
  // coarse PM alone has no AQI: the AQI chip is disabled there and the plume is drawn as
  // concentration (see plumeModeOf), so the concentration chip is the one that reads "on"
  const noAqi = pollutant === "coarse";
  const plumeOn = !compare && (layers.pm25 || layers.aqi);

  return (
    <header className="panel top" aria-label="Run and layers">
      <div className="brand">VAYU<span>·</span>TRACE</div>
      <DateInput date={date} min={meta?.notes.min_date ?? FALLBACK_MIN_DATE} max={todayUtc()} onDate={onDate} />
      <div className="chip clock num" data-testid="ist-clock">
        {meta ? fmtIST(meta.hours[hour]) : DASH} <HourTag />
      </div>
      <div className="chip-group joined" role="group" aria-label="Pollutant">
        {POLLUTANTS.map((p) => (
          <Chip key={p} label={POLLUTANT_CHIP[p].label} title={POLLUTANT_CHIP[p].title} on={pollutant === p}
            onClick={() => store.getState().setPollutant(p)} />
        ))}
      </div>
      <div className="chip-group" role="group" aria-label="Layers">
        <Chip label={CONCENTRATION_CHIP} on={plumeOn && (noAqi || !layers.aqi)} onClick={() => plume("pm25")}
          title={`${POLLUTANT_CHIP[pollutant].label} concentration plume`} />
        <Chip label="AQI" on={plumeOn && layers.aqi && !noAqi} onClick={() => plume("aqi")} disabled={noAqi}
          title={aqiChipNote(pollutant)} />
        <Chip label="Wind" on={layers.wind} onClick={() => toggle("wind")} />
        <Chip label="Fires" on={layers.fires} onClick={() => toggle("fires")} />
        <Chip label="Terrain 3D" on={layers.terrain} onClick={() => toggle("terrain")} title={TERRAIN_NOTE} />
      </div>
      <div className="spacer" />
      <div className="readouts" aria-label={city ? `Weather at ${city.name}` : "Weather"}>
        <Readout id="ro-wind" label="Wind" value={wind} />
        {/* Order matters: when the bar is too narrow the LAST readouts are dropped, so the
            ones that drive the physics (wind, mixing height) come first. */}
        <Readout id="ro-blh" label="Mixing height" value={blh === null ? DASH : `${Math.round(blh)} m${est}`} />
        <Readout id="ro-rh" label="Humidity" value={rh === null ? DASH : `${Math.round(rh * 100)}%`} />
        <Readout id="ro-temp" label="Temp" value={temp === null ? DASH : `${Math.round(temp)}°C`} />
      </div>
      {actions}
    </header>
  );
}
