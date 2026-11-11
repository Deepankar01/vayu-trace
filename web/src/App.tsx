import { useCallback, useEffect, useState } from "react";
import { MapContainer } from "./map/MapContainer";
import { useDropStore } from "./map/dropStore";
import { useStore } from "./state/store";

/** `?date=YYYY-MM-DD`, else today's UTC date. */
function runDate(): string {
  const q = new URLSearchParams(window.location.search).get("date");
  return q && /^\d{4}-\d{2}-\d{2}$/.test(q) ? q : new Date().toISOString().slice(0, 10);
}

/**
 * TEMPORARY until the panels exist (next task): keyboard controls for verifying the map.
 * Space play/pause, Left/Right one hour, 1/2/3 plume mode PM2.5 / AQI / difference from
 * baseline, W wind on/off, D arm "drop source".
 */
function useDevKeys() {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement || e.metaKey || e.ctrlKey || e.altKey) return;
      const s = useStore.getState();
      switch (e.key) {
        case " ":
          e.preventDefault();
          s.togglePlay();
          break;
        case "ArrowRight":
          s.setHour(Math.floor(s.hour) + 1);
          break;
        case "ArrowLeft":
          s.setHour(Math.ceil(s.hour) - 1);
          break;
        case "1":
          s.setCompareBaseline(false);
          s.setLayer("aqi", false);
          s.setLayer("pm25", true);
          break;
        case "2":
          s.setCompareBaseline(false);
          s.setLayer("pm25", false);
          s.setLayer("aqi", true);
          break;
        case "3":
          s.setCompareBaseline(true);
          break;
        case "w":
        case "W":
          s.setLayer("wind", !s.layers.wind);
          break;
        case "d":
        case "D":
          useDropStore.getState().arm();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}

/** TEMPORARY status text (the next task replaces it with panels). */
function DevStatus({ problems, drop }: { problems: Record<string, string>; drop: [number, number] | null }) {
  const s = useStore();
  const armed = useDropStore((d) => d.armedForDrop);
  const lines = [
    `${s.status}${s.stage ? ` · ${s.stage}` : ""}${s.status === "running" ? ` · ${Math.round(s.progress * 100)}%` : ""}`,
    s.meta ? `hour ${s.hour.toFixed(2)} / ${s.meta.hours.length - 1} · ${s.meta.hours[Math.floor(s.hour)]} UTC · ${s.playing ? `playing ${s.speed}×` : "paused"}` : null,
    s.meta ? `plume ${s.compareBaseline ? "difference from baseline" : s.layers.aqi ? "AQI (indicative: hourly PM2.5 on the 24 h scale)" : "PM2.5"} · wind ${s.layers.wind ? "on" : "off"}` : null,
    s.selectedCity ? `selected ${s.selectedCity}` : null,
    armed ? "drop source: click the map (Esc cancels)" : null,
    drop ? `drop point ${drop[0].toFixed(2)}, ${drop[1].toFixed(2)}` : null,
    s.error, s.notice, s.frameError, s.firesError,
    ...Object.values(problems),
    "space play · ←/→ hour · 1/2/3 PM2.5/AQI/diff · W wind · D drop",
  ].filter(Boolean);
  return (
    <div
      className="panel"
      style={{ position: "absolute", left: 12, bottom: 12, padding: "8px 10px", fontSize: 11, color: "var(--mute)", maxWidth: 520, pointerEvents: "none" }}
    >
      {lines.map((l, i) => <div key={i}>{l}</div>)}
    </div>
  );
}

export default function App() {
  const [problems, setProblems] = useState<Record<string, string>>({});
  const [drop, setDrop] = useState<[number, number] | null>(null);
  useDevKeys();

  useEffect(() => {
    void useStore.getState().startRun(runDate());
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

  const onDropPoint = useCallback((lon: number, lat: number) => {
    setDrop([lon, lat]);
    useDropStore.getState().disarm(); // the dialog (next task) opens here
  }, []);

  return (
    <>
      <MapContainer onDropPoint={onDropPoint} onProblem={onProblem} />
      <DevStatus problems={problems} drop={drop} />
    </>
  );
}
