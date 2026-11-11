/**
 * The validation report (`GET /api/validation`, written by `make validate`): model and CAMS
 * against CPCB measurements at the northern cities over one episode. Read-only; the numbers are
 * shown as the server computed them, null as "–". `ValidationButton` opens the dialog.
 */
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import "./ValidationDialog.css";

export const NO_FIT = "No parameter was fitted to these measurements.";
export const NO_REPORT = "No validation report yet. Run `make validate`.";

export interface Metrics {
  n: number;
  r: number | null;
  bias: number | null;
  nmb: number | null;
  rmse: number | null;
  fac2: number | null;
}

interface Split {
  day: { n: number; bias: number | null; nmb: number | null };
  night: { n: number; bias: number | null; nmb: number | null };
}

export interface ValidationRow {
  id: string;
  name: string;
  stations?: number;
  cities?: string[];
  model: Metrics;
  cams: Metrics;
  mean_sim: number | null;
  mean_measured: number | null;
  split: { model: Split; cams: Split };
}

export interface ValidationReport {
  episode: { start: string; end: string; hours: number };
  min_n: number;
  generated_at?: string;
  cities: ValidationRow[];
  pooled: ValidationRow[];
}

const DASH = "–";
const fix = (v: number | null | undefined, d: number, sign = false) =>
  v == null || !Number.isFinite(v) ? DASH : `${sign && v > 0 ? "+" : ""}${v.toFixed(d)}`;

type Load = { state: "loading" } | { state: "missing" } | { state: "error"; message: string } | { state: "ready"; report: ValidationReport };

export function useValidationReport(fetchImpl: typeof fetch = (...a) => fetch(...a)): Load {
  const [load, setLoad] = useState<Load>({ state: "loading" });
  useEffect(() => {
    const ctrl = new AbortController();
    fetchImpl("/api/validation", { signal: ctrl.signal })
      .then(async (res) => {
        if (res.status === 404) return setLoad({ state: "missing" });
        if (!res.ok) return setLoad({ state: "error", message: `HTTP ${res.status}` });
        setLoad({ state: "ready", report: (await res.json()) as ValidationReport });
      })
      .catch((e: unknown) => {
        if (!(e instanceof Error && e.name === "AbortError")) setLoad({ state: "error", message: String(e) });
      });
    return () => ctrl.abort();
  }, []); // fetched once per opening
  return load;
}

function Table({ rows, caption }: { rows: ValidationRow[]; caption: string }) {
  return (
    <table className="vd-table num">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          <th scope="col" rowSpan={2}>City</th>
          <th scope="colgroup" colSpan={2}>Mean µg/m³</th>
          <th scope="colgroup" colSpan={4}>Model vs measured</th>
          <th scope="colgroup" colSpan={2}>Model bias</th>
          <th scope="colgroup" colSpan={3}>CAMS vs measured</th>
        </tr>
        <tr>
          <th scope="col">meas.</th><th scope="col">model</th>
          <th scope="col">n</th><th scope="col">r</th><th scope="col">NMB</th><th scope="col">FAC2</th>
          <th scope="col">day</th><th scope="col">night</th>
          <th scope="col">r</th><th scope="col">NMB</th><th scope="col">FAC2</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r) => (
          <tr key={r.id}>
            <th scope="row">{r.name}</th>
            <td>{fix(r.mean_measured, 0)}</td>
            <td>{fix(r.mean_sim, 0)}</td>
            <td>{r.model.n}</td>
            <td>{fix(r.model.r, 2)}</td>
            <td>{fix(r.model.nmb, 2, true)}</td>
            <td>{fix(r.model.fac2, 2)}</td>
            <td>{fix(r.split.model.day.bias, 0, true)}</td>
            <td>{fix(r.split.model.night.bias, 0, true)}</td>
            <td>{fix(r.cams.r, 2)}</td>
            <td>{fix(r.cams.nmb, 2, true)}</td>
            <td>{fix(r.cams.fac2, 2)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function ValidationDialog({ onClose, fetchImpl }: { onClose: () => void; fetchImpl?: typeof fetch }) {
  const load = useValidationReport(fetchImpl);
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => closeRef.current?.focus(), []);
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onClose();
    }
  };

  return (
    <div className="vd-layer" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="panel vd" role="dialog" aria-modal="true" aria-labelledby={titleId} onKeyDown={onKey}>
        <div className="vd-head">
          <h4 id={titleId}>Validation · model vs CPCB measurements</h4>
          <button ref={closeRef} type="button" className="vd-close" aria-label="Close validation" onClick={onClose}>×</button>
        </div>
        <p className="vd-nofit">{NO_FIT}</p>
        {load.state === "loading" && <p className="mute">Loading…</p>}
        {load.state === "missing" && <p className="mute">{NO_REPORT}</p>}
        {load.state === "error" && <p className="vd-error">Could not load the validation report: {load.message}</p>}
        {load.state === "ready" && (
          <>
            <p className="vd-episode">
              Episode <b className="num">{load.report.episode.start.slice(0, 10)}</b> to{" "}
              <b className="num">{load.report.episode.end.slice(0, 10)}</b> (UTC hours), default weights. Directly
              emitted PM2.5 only: secondary aerosol and inflow from outside India are not simulated. NMB = Σ(model −
              measured) / Σ measured; FAC2 = share of hours within a factor of two; bias in µg/m³, day 10:00–17:59 IST,
              night 22:00–05:59 IST. “{DASH}” means fewer than {load.report.min_n} paired hours.
            </p>
            <h4 className="h4-sub">Pooled</h4>
            <Table rows={load.report.pooled} caption="Pooled metrics" />
            <h4 className="h4-sub">Per city</h4>
            <div className="vd-scroll">
              <Table rows={load.report.cities} caption="Per-city metrics" />
            </div>
            <p className="note">Full method and reading: docs/validation/ in the repository.</p>
          </>
        )}
      </div>
    </div>
  );
}

/** A top-bar style chip that opens the validation dialog. */
export function ValidationButton({ fetchImpl }: { fetchImpl?: typeof fetch }) {
  const [open, setOpen] = useState(false);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const close = () => {
    setOpen(false);
    buttonRef.current?.focus();
  };
  return (
    <>
      <button ref={buttonRef} type="button" className="panel chip chip-btn vd-launch" aria-haspopup="dialog"
        aria-expanded={open} onClick={() => setOpen(true)}>
        Validation
      </button>
      {open && <ValidationDialog onClose={close} fetchImpl={fetchImpl} />}
    </>
  );
}
