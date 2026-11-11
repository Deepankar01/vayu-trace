/**
 * Bottom bar: play/pause, IST time of the playhead hour, a scrubber over the run window (solid
 * replay, dashed forecast, IST day ticks, fires-assumed marker) and the speed in simulated hours
 * per second. The caption states the fire assumption whenever fire hours are assumed.
 */
import { useMapStatus } from "../map/mapStatus";
import { DASH, fmtISTShort } from "../lib/format";
import { SPEEDS } from "../state/store";
import { istDayStarts } from "./chartScale";
import { useApp, useAppStore } from "./storeContext";

export const CAPTION_CONTINUE = "forecast assumes fires continue at recent levels";
export const CAPTION_STOP = "forecast assumes fires stop now";

export function Timeline() {
  const store = useAppStore();
  const meta = useApp((s) => s.meta);
  const hour = useApp((s) => s.hour);
  const playing = useApp((s) => s.playing);
  const speed = useApp((s) => s.speed);
  const firesContinue = useApp((s) => s.firesContinue);
  const loadingHour = useMapStatus((m) => m.plumeLoadingHour);

  const n = meta?.hours.length ?? 0;
  const last = Math.max(1, n - 1);
  const pos = (h: number) => `${(Math.min(Math.max(h, 0), last) / last) * 100}%`;
  const ff = meta?.forecast_from ?? null;
  const fa = meta?.fires_assumed_from ?? null;
  const showFa = fa !== null && (ff === null || fa < ff);
  const h = Math.floor(hour);
  const days = meta ? istDayStarts(meta.hours) : [];
  const caption = fa === null ? null : firesContinue ? CAPTION_CONTINUE : CAPTION_STOP;

  return (
    <footer className="panel bottom" aria-label="Timeline">
      <button
        type="button" className="play" aria-label={playing ? "Pause" : "Play"} disabled={!meta}
        onClick={() => store.getState().togglePlay()}
      >
        {playing ? (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><rect x="3" y="2" width="3.5" height="12" rx="1" /><rect x="9.5" y="2" width="3.5" height="12" rx="1" /></svg>
        ) : (
          <svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4 2.5v11a.6.6 0 0 0 .9.5l9-5.5a.6.6 0 0 0 0-1l-9-5.5a.6.6 0 0 0-.9.5z" /></svg>
        )}
      </button>
      <div className="time-block">
        <div className="clock-big num" data-testid="clock">{meta ? fmtISTShort(meta.hours[h]) : DASH}</div>
        <div className="mute small">
          {loadingHour !== null ? <span className="loading">loading hour {loadingHour}…</span> : `IST · 1 h steps · ${speed}× speed`}
        </div>
      </div>

      <div className="track">
        <div className="rail" />
        <div className="replay" style={{ left: 0, width: ff === null ? "100%" : pos(ff) }} />
        <div className="played" style={{ width: pos(Math.min(hour, ff ?? last)) }} />
        {ff !== null && <div className="fc" data-testid="forecast-part" style={{ left: pos(ff), right: 0 }} />}
        {ff !== null && <div className="mark now-mark" style={{ left: pos(ff) }}><span>now</span></div>}
        {showFa && <div className="mark fa-mark" style={{ left: pos(fa!) }}><span>fires assumed from here</span></div>}
        {days.map((d) => (
          <div key={d.pos} className="day" style={{ left: pos(d.pos) }}><span>{d.label}</span></div>
        ))}
        <input
          type="range" className="scrub" aria-label="Playhead" min={0} max={last} step={1} value={h} disabled={!meta}
          aria-valuetext={meta ? `${fmtISTShort(meta.hours[h])} IST` : undefined}
          onChange={(e) => store.getState().setHour(Number(e.target.value))}
        />
        <div className="knob" style={{ left: pos(hour) }} />
      </div>

      <div className="right-block">
        <div className="speeds" role="radiogroup" aria-label="Speed, simulated hours per second">
          {SPEEDS.map((s) => (
            <label key={s} className={s === speed ? "on" : undefined}>
              <input type="radio" name="speed" value={s} checked={s === speed} onChange={() => store.getState().setSpeed(s)} />
              {s}×
            </label>
          ))}
        </div>
        <div className="caption-line">
          {caption ? <span className="accent">{caption}</span> : <span className="mute">solid = replay of real data</span>}
        </div>
      </div>
    </footer>
  );
}
