import { useCallback, useEffect, useState } from "react";
import { MapContainer } from "./map/MapContainer";
import { useDropStore } from "./map/dropStore";
import { CityPanel } from "./panels/CityPanel";
import { DropSourceDialog } from "./panels/DropSourceDialog";
import { initialHour } from "./panels/initialHour";
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

/** `?date=YYYY-MM-DD`, else today's UTC date. */
function runDate(): string {
  const q = new URLSearchParams(window.location.search).get("date");
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
}

function startRun(date: string) {
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
    startRun(runDate());
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

  const shownProblems = [frameError, firesError, ...Object.values(problems)].filter(Boolean);

  return (
    <>
      <MapContainer onDropPoint={onDropPoint} onProblem={onProblem} />
      <div className="app-ui">
        <TopBar onDate={startRun} />
        {/* Validation report (Task 16): mounted here, not in TopBar.tsx; may move into the top bar */}
        <ValidationButton />
        {ready && (
          <>
            <button type="button" className="panel left-toggle" aria-label={leftOpen ? "Hide sources" : "Show sources"}
              aria-expanded={leftOpen} onClick={() => setLeftOpen((o) => !o)}>
              <svg viewBox="0 0 16 16" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.5" aria-hidden="true">
                <path d="M2 4h12M2 8h12M2 12h12" /><circle cx="5" cy="4" r="1.6" fill="#11151d" /><circle cx="11" cy="8" r="1.6" fill="#11151d" /><circle cx="7" cy="12" r="1.6" fill="#11151d" />
              </svg>
            </button>
            <aside className={`panel side left${leftOpen ? " open" : ""}`} aria-label="Sources">
              <div className="side-scroll"><SourcesPanel /></div>
            </aside>
            <aside className="panel side right" aria-label="Selected city">
              <div className="side-scroll"><CityPanel /></div>
            </aside>
            <PlumeLegend />
          </>
        )}
        {shownProblems.length > 0 && (
          <div className="panel problems" role="status">
            {shownProblems.map((m, i) => <div key={i}>{m}</div>)}
          </div>
        )}
        <Timeline />
        <RunStatus onRetry={() => startRun(useStore.getState().meta?.date ?? runDate())} />
        <DropSourceDialog />
      </div>
    </>
  );
}
