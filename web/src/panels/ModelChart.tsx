/**
 * "Model vs measured" over the run window, hourly PM2.5 (µg/m³): our model (accent; dashed in
 * forecast hours), CPCB (white dots), Copernicus CAMS (thin blue line), the playhead, and a
 * shaded band where fire emissions are assumed. Hover reads the three values at an hour; a click
 * moves the playhead there. Plain SVG; the scale maths is in chartScale.ts.
 */
import { useState, type MouseEvent } from "react";
import { DASH, fmtISTShort, fmtNumber } from "../lib/format";
import { hourFromX, istDayStarts, linear, pathD, runs, seriesMax, yTicks } from "./chartScale";

const W = 288;
const H = 150;
const L = 24; // y labels
const R = 4;
const T = 10;
const B = 14; // date labels
const PW = W - L - R;
const PH = H - T - B;

type Series = (number | null)[];

export interface ModelChartProps {
  hours: string[];
  sim: Series;
  measured: Series | null;
  cams: Series | null;
  /** Text shown for CAMS instead of values when it is missing, loading or failed. */
  camsNote: string | null;
  /** CAMS failed to load: the legend says so, with this error as its tooltip. */
  camsError?: string | null;
  measuredNote: string | null;
  hour: number;
  forecastFrom: number | null;
  firesAssumedFrom: number | null;
  onSeek: (h: number) => void;
}

const val = (s: Series | null, h: number) => {
  const v = s?.[h];
  return v != null && Number.isFinite(v) ? v : null;
};

export function ModelChart(p: ModelChartProps) {
  const [hover, setHover] = useState<number | null>(null);
  const n = p.hours.length;
  const last = Math.max(1, n - 1);
  const { ticks, top } = yTicks(seriesMax([p.sim, p.measured, p.cams]));
  const x = linear(0, last, L, L + PW);
  const y = linear(0, top, T + PH, T);
  const ff = p.forecastFrom;
  const solid = runs(p.sim, 0, ff ?? n - 1);
  // solid through forecast_from, dashed from it: the two meet at the first forecast hour
  const dashed = ff === null ? [] : runs(p.sim, ff, n - 1);
  const cams = p.cams ? runs(p.cams, 0, n - 1) : [];
  const h = hover ?? Math.floor(p.hour);

  const hourAt = (e: MouseEvent<SVGSVGElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    const px = ((e.clientX - r.left) / Math.max(1, r.width)) * W - L;
    return hourFromX(px, PW, n);
  };

  const days = istDayStarts(p.hours);
  const dayLabels = days.filter((_, k) => days.length <= 4 || k % 2 === 0);

  return (
    <figure className="chart">
      <div className="chart-readout num" aria-live="polite">
        <span className="mute">{n ? `${fmtISTShort(p.hours[h])} IST` : DASH}</span>
        <span><i className="key key-model" />{fmtNumber(val(p.sim, h))}</span>
        <span><i className="key key-cpcb" />{fmtNumber(val(p.measured, h))}</span>
        <span><i className="key key-cams" />{fmtNumber(val(p.cams, h))}</span>
      </div>
      <svg
        viewBox={`0 0 ${W} ${H}`} width="100%" role="img"
        aria-label="Model vs measured: hourly PM2.5 over the run window. Click to move the playhead."
        onPointerMove={(e) => setHover(hourAt(e))} onPointerLeave={() => setHover(null)}
        onClick={(e) => p.onSeek(hourAt(e))}
      >
        {p.firesAssumedFrom !== null && (
          <g className="fires-band">
            <rect x={x(p.firesAssumedFrom)} y={T} width={Math.max(0, L + PW - x(p.firesAssumedFrom))} height={PH} />
            <text x={x(p.firesAssumedFrom) + 3} y={T + 8}>fires assumed</text>
          </g>
        )}
        <line x1={L} x2={L + PW} y1={y(0)} y2={y(0)} className="axis" />
        {ticks.map((t) => (
          <g key={t}>
            <line x1={L} x2={L + PW} y1={y(t)} y2={y(t)} className="grid" />
            <text x={L - 4} y={y(t) + 3} className="tick" textAnchor="end">{fmtNumber(t)}</text>
          </g>
        ))}
        {dayLabels.map((d) => (
          <text key={d.pos} x={x(d.pos)} y={H - 3} className="tick" textAnchor="middle">{d.label}</text>
        ))}
        {ff !== null && (
          <g className="now-real">
            <line x1={x(ff)} x2={x(ff)} y1={T} y2={T + PH} />
            <text x={x(ff) + 3} y={T + PH - 3}>now</text>
          </g>
        )}
        {cams.map((r, k) => <path key={k} d={pathD(r, x, y)} className="line-cams" />)}
        {solid.map((r, k) => <path key={k} d={pathD(r, x, y)} className="line-model" />)}
        {dashed.map((r, k) => <path key={k} d={pathD(r, x, y)} className="line-model forecast" />)}
        {p.measured && (
          <g className="dots-cpcb">
            {p.measured.map((v, i) => (v != null && Number.isFinite(v) ? <circle key={i} cx={x(i)} cy={y(v)} r={1.5} /> : null))}
          </g>
        )}
        <g data-testid="chart-now" className="playhead">
          <line x1={x(p.hour)} x2={x(p.hour)} y1={T - 4} y2={T + PH} />
        </g>
        {hover !== null && <line className="hover" x1={x(hover)} x2={x(hover)} y1={T} y2={T + PH} />}
        <rect x={L} y={0} width={PW} height={H} fill="transparent" />
      </svg>
      <figcaption className="chart-legend">
        <span><i className="key key-model" />our model</span>
        <span><i className="key key-cpcb" />CPCB{p.measuredNote ? <em> {p.measuredNote}</em> : null}</span>
        {p.camsError ? (
          <span title={p.camsError} data-testid="cams-failed"><i className="key key-cams" />Copernicus: failed to load</span>
        ) : (
          <span><i className="key key-cams" />Copernicus CAMS{p.camsNote ? <em> {p.camsNote}</em> : null}</span>
        )}
      </figcaption>
    </figure>
  );
}
