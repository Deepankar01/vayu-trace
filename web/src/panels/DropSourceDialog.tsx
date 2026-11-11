/**
 * The "Drop source" dialog, opened next to the picked map point. The server simulates the source
 * (a few seconds); on success the dialog closes and the source appears under "Added sources", on
 * failure the server's message is shown here. Escape, Cancel or a click outside closes it, except
 * while the request is in flight (`busy` in the drop store). Tab cycles inside the dialog; on
 * close focus returns to the "Drop source" button.
 */
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { useDropStore } from "../map/dropStore";
import { fmtIST, fmtNumber } from "../lib/format";
import { DEFAULT_DURATION_H, DROP_KINDS, FIREWORKS_SIZES, MAX_DURATION_H, validateDrop, type DropErrors } from "./dropKinds";
import { useApp, useAppStore } from "./storeContext";

const DIALOG_W = 320;
const DIALOG_H = 430;
const GAP = 16;

/** Top-left of the dialog: right of the point if it fits, else left; clamped to the viewport. */
function anchor(x: number, y: number) {
  const vw = window.innerWidth || 1440;
  const vh = window.innerHeight || 900;
  const left = x + GAP + DIALOG_W <= vw - 8 ? x + GAP : Math.max(8, x - GAP - DIALOG_W);
  const top = Math.min(Math.max(8, y - 60), Math.max(8, vh - DIALOG_H - 8));
  return { left, top };
}

export function DropSourceDialog() {
  const store = useAppStore();
  const point = useDropStore((d) => d.pending);
  const meta = useApp((s) => s.meta);
  const playhead = useApp((s) => Math.floor(s.hour));
  const n = meta?.hours.length ?? 0;

  const [kind, setKind] = useState<string>(DROP_KINDS[0].id);
  const [amountText, setAmountText] = useState(String(DROP_KINDS[0].defaultAmount));
  const [size, setSize] = useState(2);
  const [start, setStart] = useState(playhead);
  const [durText, setDurText] = useState(String(DEFAULT_DURATION_H));
  const [errors, setErrors] = useState<DropErrors>({});
  const busy = useDropStore((d) => d.busy);
  const [serverError, setServerError] = useState<string | null>(null);
  const firstField = useRef<HTMLSelectElement>(null);
  const formRef = useRef<HTMLFormElement>(null);
  const wasOpen = useRef(false);
  const titleId = useId();

  // a new point resets the form to the playhead hour (deliberately not on playhead changes)
  useEffect(() => {
    setStart(playhead);
    setErrors({});
    setServerError(null);
    if (point) {
      wasOpen.current = true;
      firstField.current?.focus();
    } else if (wasOpen.current) {
      wasOpen.current = false;
      document.querySelector<HTMLElement>("[data-drop-button]")?.focus();
    }
  }, [point]);

  if (!point || !meta) return null;
  const spec = DROP_KINDS.find((k) => k.id === kind)!;
  const fireworks = kind === "fireworks";
  const amount = fireworks ? size : Number(amountText);
  const durationH = Number(durText);
  const truncated = Number.isInteger(durationH) && start + durationH > n;

  const close = () => useDropStore.getState().close(); // no-op while busy

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const errs = validateDrop({ kind, amount, startHour: start, durationH }, n);
    setErrors(errs);
    if (Object.keys(errs).length > 0) return;
    const drop = useDropStore.getState();
    drop.setBusy(true);
    setServerError(null);
    try {
      await store.getState().addSource({ kind, lon: point.lon, lat: point.lat, amount, start_hour: start, duration_h: durationH });
    } finally {
      drop.setBusy(false);
    }
    const err = store.getState().sourceError;
    if (err) setServerError(err);
    else useDropStore.getState().close();
  };

  /** Focus trap: Tab and Shift+Tab cycle through the dialog's enabled controls. */
  const trap = (e: KeyboardEvent<HTMLFormElement>) => {
    if (e.key !== "Tab" || !formRef.current) return;
    const items = [...formRef.current.querySelectorAll<HTMLElement>("button, input, select, textarea, [tabindex]")]
      .filter((el) => !(el as HTMLButtonElement).disabled && el.tabIndex >= 0);
    if (items.length === 0) return;
    const first = items[0];
    const last = items[items.length - 1];
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  };

  const pos = anchor(point.x, point.y);
  return (
    <div className="dialog-layer" onPointerDown={(e) => e.target === e.currentTarget && close()}>
      <span className="drop-pin" style={{ left: point.x, top: point.y }} aria-hidden="true" />
      <form
        ref={formRef} onKeyDown={trap}
        className="panel dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} aria-busy={busy}
        style={{ left: pos.left, top: pos.top, width: DIALOG_W }} onSubmit={submit} noValidate
      >
        <h4 id={titleId}>Add a source</h4>
        <div className="mute small num">at {point.lat.toFixed(2)}° N, {point.lon.toFixed(2)}° E</div>

        <label className="field">
          <span>Kind</span>
          <select ref={firstField} aria-label="Kind" value={kind} disabled={busy}
            onChange={(e) => {
              const k = DROP_KINDS.find((d) => d.id === e.target.value)!;
              setKind(k.id);
              if (k.id !== "fireworks") setAmountText(String(k.defaultAmount));
              setErrors({});
            }}
          >
            {DROP_KINDS.map((k) => <option key={k.id} value={k.id}>{k.label}</option>)}
          </select>
        </label>

        {fireworks ? (
          <fieldset className="field">
            <legend>Event size</legend>
            <div className="seg-choice">
              {FIREWORKS_SIZES.map((f) => (
                <label key={f.amount} className={size === f.amount ? "on" : undefined}>
                  <input type="radio" name="fw-size" value={f.amount} checked={size === f.amount} disabled={busy} onChange={() => setSize(f.amount)} />
                  {f.name}
                </label>
              ))}
            </div>
          </fieldset>
        ) : (
          <label className="field">
            <span>Amount</span>
            <span className="with-unit">
              <input type="number" aria-label={`Amount (${spec.unit})`} min={0} step="any" value={amountText} disabled={busy}
                onChange={(e) => setAmountText(e.target.value)} aria-invalid={!!errors.amount} />
              <span className="unit">{spec.unit}</span>
            </span>
          </label>
        )}
        {errors.amount && <p className="field-err">{errors.amount}</p>}

        <div className="field-row">
          <label className="field grow">
            <span>Start</span>
            <select aria-label="Start" value={start} disabled={busy} onChange={(e) => setStart(Number(e.target.value))} aria-invalid={!!errors.startHour}>
              {meta.hours.map((t, i) => <option key={i} value={i}>{fmtIST(t)}</option>)}
            </select>
          </label>
          <label className="field dur">
            <span>Duration (hours)</span>
            <input type="number" aria-label="Duration (hours)" min={1} max={MAX_DURATION_H} step={1} value={durText} disabled={busy}
              onChange={(e) => setDurText(e.target.value)} aria-invalid={!!errors.durationH} />
          </label>
        </div>
        {errors.startHour && <p className="field-err">{errors.startHour}</p>}
        {errors.durationH && <p className="field-err">{errors.durationH}</p>}
        {truncated && !errors.durationH && (
          <p className="note">Ends after the run window; only the first {fmtNumber(n - start)} h are simulated.</p>
        )}

        <p className="assumption">{spec.assumption} Order-of-magnitude scenario, not an inventory.</p>

        {busy && (
          <div className="sim-progress" role="status">
            <div className="progress indeterminate"><i /></div>
            <span>Simulating the source over the run window… this takes a few seconds</span>
          </div>
        )}
        {serverError && <p className="dialog-error" role="alert">{serverError}</p>}

        <div className="dialog-actions">
          <button type="button" className="btn" onClick={close} disabled={busy}>Cancel</button>
          <button type="submit" className="btn primary" disabled={busy}>Add source</button>
        </div>
      </form>
    </div>
  );
}
