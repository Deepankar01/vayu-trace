/** Small shared controls for the panels: info tooltip, switch, labelled range slider. */
import { useId, type CSSProperties, type ReactNode } from "react";
import type { CityMeta, Meta } from "../api/types";

/** The selected city, or Delhi, or the first city. */
export function cityOf(meta: Meta | null, selected: string | null): CityMeta | null {
  if (!meta || meta.cities.length === 0) return null;
  return meta.cities.find((c) => c.id === selected) ?? meta.cities.find((c) => c.id === "delhi") ?? meta.cities[0];
}

/** An "i" button that reveals its text on hover and keyboard focus. */
export function Info({ label, children, align = "left" }: { label: string; children: ReactNode; align?: "left" | "right" }) {
  const id = useId();
  return (
    <span className={`info info-${align}`}>
      <button type="button" className="info-btn" aria-label={label} aria-describedby={id}>i</button>
      <span role="tooltip" id={id} className="info-tip">{children}</span>
    </span>
  );
}

export function Switch({
  label, checked, onChange, disabled, children,
}: { label: string; checked: boolean; onChange: (on: boolean) => void; disabled?: boolean; children?: ReactNode }) {
  return (
    <button
      type="button" role="switch" aria-checked={checked} aria-label={label} disabled={disabled}
      className={`switch${checked ? " on" : ""}`} onClick={() => onChange(!checked)}
    >
      <span className="switch-track" aria-hidden="true"><span className="switch-knob" /></span>
      {children}
    </button>
  );
}

export interface SliderProps {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  color: string;
  disabled?: boolean;
  onChange: (v: number) => void;
  /** Double-click returns to this value. */
  resetTo?: number;
}

/** Native range input styled as the mockup's thin track with a filled part in the source colour. */
export function Slider({ label, value, min, max, step, color, disabled, onChange, resetTo }: SliderProps) {
  const pct = ((value - min) / (max - min)) * 100;
  const mark = resetTo === undefined ? null : ((resetTo - min) / (max - min)) * 100;
  return (
    <div className="slider-wrap" style={{ "--pct": `${pct}%`, "--fill": color } as CSSProperties}>
      {mark !== null && <span className="slider-mark" style={{ left: `${mark}%` }} aria-hidden="true" />}
      <input
        type="range" className="slider" aria-label={label} min={min} max={max} step={step} value={value}
        disabled={disabled}
        onChange={(e) => onChange(Number(e.target.value))}
        onDoubleClick={() => resetTo !== undefined && onChange(resetTo)}
      />
    </div>
  );
}

export function Dot({ color, muted }: { color: string; muted?: boolean }) {
  return <i className={`dot${muted ? " dot-muted" : ""}`} style={{ background: color }} aria-hidden="true" />;
}
