import { useCallback, useEffect, useState } from "react";
import { MapContainer } from "./map/MapContainer";
import { useDropStore } from "./map/dropStore";
import { CityPanel } from "./panels/CityPanel";
import { DropSourceDialog } from "./panels/DropSourceDialog";
import { initialHour } from "./panels/initialHour";
import { PanelBoundary } from "./panels/PanelBoundary";
import { useKeyboard } from "./panels/keyboard";
import { PlumeLegend } from "./panels/PlumeLegend";
import { RunStatus } from "./panels/RunStatus";
import { SourcesPanel } from "./panels/SourcesPanel";
import { Timeline } from "./panels/Timeline";
import { TopBar } from "./panels/TopBar";
import { ValidationButton } from "./panels/ValidationDialog";
import "./panels/panels.css";
import { useStore } from "./state/store";

const DEFAULT_CITY = "delhi";
/** Map-scene problems the user can dismiss (map errors also clear themselves after 10 s). */
const DISMISSIBLE = new Set(["map"]);

/** `?date=YYYY-MM-DD`, else today's UTC date. */
function runDate(): string {
  const q = new URLSearchParams(window.location.search).get("date");
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
}

function startRunFor(date: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("date", date);
  window.history.replaceState(null, "", url);
  void useStore.getState().startRun(date);
}

export default function App() {
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [leftOpen, setLeftOpen] = useState(false);
  const frameError = useStore((s) => s.frameError);
  const firesError = useStore((s) => s.firesError);
  const ready = useStore((s) => s.status === "ready");
  const build = useStore((s) => s.meta?.build_id ?? s.runId);
  // an added-source failure whose dialog is gone (or a failed removal) still has to be seen
  const sourceError = useStore((s) => s.sourceError);
  const dialogOpen = useDropStore((d) => d.pending !== null);
  const [requested, setRequested] = useState(runDate);
  const startRun = useCallback((date: string) => {
    setRequested(date);
    startRunFor(date);
  }, []);
  useKeyboard(useStore);

  // a newly loaded run opens on its date's evening (a refresh of the same date keeps the playhead)
  useEffect(
    () =>
      useStore.subscribe((s, prev) => {
        // deferred: the store installs a meta in several steps (frame cache configured after `meta`
        // is set); moving the playhead inside that would leave the cache centred on the old hour
        const meta = s.meta;
        if (meta && meta.date !== prev.meta?.date) queueMicrotask(() => useStore.getState().setHour(initialHour(meta)));
      }),
    [],
  );

  useEffect(() => {
    useStore.getState().selectCity(DEFAULT_CITY); // measured / CAMS load once the run is ready
    startRunFor(runDate());
  }, []);

  const onProblem = useCallback((key: string, message: string | null) => {
    setProblems((p) => {
      if ((p[key] ?? null) === message) return p;
      const next = { ...p };
      if (message === null) delete next[key];
      else next[key] = message;
      return next;
    });
  }, []);

  const onDropPoint = useCallback((lon: number, lat: number, x: number, y: number) => {
    useDropStore.getState().place({ lon, lat, x, y });
  }, []);

  const shownProblems: { key: string; message: string }[] = [
    { key: "frame", message: frameError },
    { key: "fires", message: firesError },
    { key: "source", message: !dialogOpen && sourceError ? `added source: ${sourceError}` : null },
    ...Object.entries(problems).map(([key, message]) => ({ key: `p:${key}`, message })),
  ].filter((p): p is { key: string; message: string } => Boolean(p.message));

  return (
    <>
      <MapContainer onDropPoint={onDropPoint} onProblem={onProblem} />
      <div className="app-ui">
        {/* Validation report, at the right end of the top bar */}
        <PanelBoundary name="Top bar" resetKey={build}><TopBar date={requested} onDate={startRun} actions={<ValidationButton />} /></PanelBoundary>
        {ready && (
          <>
            <button type="button" className="panel left-toggle" aria-label={leftOpen ? "Hide sources" : "Show sources"}
              aria-expanded={leftOpen} onClick={() => setLeftOpen((o) => !o)}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h12" /><circle cx="5" cy="4" r="1.6" fill="#11151d" /><circle cx="11" cy="8" r="1.6" fill="#11151d" /><circle cx="7" cy="12" r="1.6" fill="#11151d" />
              </svg>
            </button>
            <aside className={`panel side left${leftOpen ? " open" : ""}`} aria-label="Sources">
              <div className="side-scroll"><PanelBoundary name="Sources panel" resetKey={build}><SourcesPanel /></PanelBoundary></div>
            </aside>
            <aside className="panel side right" aria-label="Selected city">
              <div className="side-scroll"><PanelBoundary name="City panel" resetKey={build}><CityPanel /></PanelBoundary></div>
            </aside>
            <PanelBoundary name="Legend" resetKey={build}><PlumeLegend /></PanelBoundary>
          </>
        )}
        {shownProblems.length > 0 && (
          <div className="panel problems" role="status">
            {shownProblems.map((p) => (
              <div key={p.key}>
                {p.message}
                {DISMISSIBLE.has(p.key.slice(2)) && p.key.startsWith("p:") && (
                  <button type="button" className="toast-x" aria-label="Dismiss" onClick={() => onProblem(p.key.slice(2), null)}>×</button>
                )}
              </div>
            ))}
          </div>
        )}
        <PanelBoundary name="Timeline" resetKey={build}><Timeline /></PanelBoundary>
        <RunStatus onRetry={() => startRun(useStore.getState().meta?.date ?? requested)} />
        <PanelBoundary name="Drop source dialog" resetKey={build}
          onError={() => useDropStore.setState({ pending: null, busy: false, armedForDrop: false })}><DropSourceDialog /></PanelBoundary>
      </div>
    </>
  );
}
