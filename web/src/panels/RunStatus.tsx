/**
 * Run lifecycle overlay: a centred progress panel while the run builds, the error with Retry when
 * it fails, and the store's `notice` as a dismissible toast. Renders nothing while ready.
 */
import { useApp, useAppStore } from "./storeContext";

export function RunStatus({ onRetry }: { onRetry: () => void }) {
  const store = useAppStore();
  const status = useApp((s) => s.status);
  const stage = useApp((s) => s.stage);
  const progress = useApp((s) => s.progress);
  const error = useApp((s) => s.error);
  const notice = useApp((s) => s.notice);
  const hasMeta = useApp((s) => s.meta !== null);
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);

  return (
    <>
      {(status === "running" || status === "loading") && (
        <div className="panel run-status" role="status" aria-live="polite">
          <h4>{hasMeta ? "Refreshing run" : "Preparing run"}</h4>
          <div className="stage">{stage || "starting"}</div>
          <div className="progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct} aria-label="Run progress">
            <i style={{ width: `${pct}%` }} />
          </div>
          <div className="mute small num">
            {pct}% · The first run for a date fetches weather and fires and simulates them: one to a few minutes. Recent dates are refreshed when reopened after an hour; older dates open at once.
          </div>
        </div>
      )}
      {status === "error" && (
        <div className="panel run-status error" role="alert">
          <h4>The run failed</h4>
          <p>{error}</p>
          <button type="button" className="btn primary" onClick={onRetry}>Retry</button>
        </div>
      )}
      {notice && (
        <div className="toast panel" role="status">
          <span>{notice}</span>
          <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => store.getState().clearNotice()}>×</button>
        </div>
      )}
    </>
  );
}
