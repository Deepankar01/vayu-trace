/**
 * Small map legend for the plume: the PM2.5 ramp, the six CPCB categories (AQI mode, indicative:
 * hourly values on the 24-hour scale) or the diverging difference from baseline. Every colour has
 * a text label next to it.
 */
import { AQI_BANDS, pm25Ramp } from "../lib/colors";
import { MINUS } from "../lib/format";
import { useApp } from "./storeContext";

const PM_TICKS = [5, 60, 120, 250, 400];
const DIFF_SAT = 100; // map/layers/plume.ts DIFF_SATURATION
const DIFF_DEAD = 2; // map/layers/plume.ts DIFF_DEAD_BAND

function rampGradient(): string {
  const stops: string[] = [];
  for (let k = 0; k <= 20; k++) {
    const v = 5 + (k / 20) * 395;
    const [r, g, b] = pm25Ramp(v + 0.01);
    stops.push(`rgb(${r},${g},${b}) ${(k / 20) * 100}%`);
  }
  return `linear-gradient(90deg, ${stops.join(", ")})`;
}
const RAMP = rampGradient();
export const CITY_NOTE = "City labels and markers: simulated";
const Note = () => <div className="lg-note mute" data-testid="legend-note">{CITY_NOTE}</div>;

export function PlumeLegend() {
  const compare = useApp((s) => s.compareBaseline);
  const aqi = useApp((s) => s.layers.aqi);
  const pm25 = useApp((s) => s.layers.pm25);
  const ready = useApp((s) => s.meta !== null);
  if (!ready) return null;

  if (compare) {
    return (
      <div className="panel legend-box" aria-label="Plume legend">
        <div className="lg-title">Difference from baseline · PM2.5 µg/m³</div>
        <div className="lg-bar" style={{ background: "linear-gradient(90deg, #6aa8ff, rgba(106,168,255,0) 48%, rgba(255,90,90,0) 52%, #ff5a5a)" }} />
        <div className="lg-ticks num">
          <span>{MINUS}{DIFF_SAT}</span><span>±{DIFF_DEAD}</span><span>+{DIFF_SAT}</span>
        </div>
        <div className="lg-ticks small"><span className="cool">lower than baseline</span><span className="warm">higher</span></div>
        <Note />
      </div>
    );
  }
  if (aqi) {
    return (
      <div className="panel legend-box" aria-label="Plume legend">
        <div className="lg-title" title="Hourly PM2.5 shown on the 24-hour AQI scale — indicative">AQI (PM2.5-based) · indicative</div>
        <ul className="lg-cats">
          {AQI_BANDS.map((b) => (
            <li key={b.name}><i style={{ background: b.color }} />{b.name}</li>
          ))}
        </ul>
        <Note />
      </div>
    );
  }
  if (!pm25) return null;
  return (
    <div className="panel legend-box" aria-label="Plume legend">
      <div className="lg-title">PM2.5 · µg/m³ (simulated)</div>
      <div className="lg-bar" style={{ background: RAMP }} />
      <div className="lg-ticks num pm">
        {PM_TICKS.map((t) => <span key={t} style={{ left: `${((t - 5) / 395) * 100}%` }}>{t}</span>)}
      </div>
      <Note />
    </div>
  );
}
