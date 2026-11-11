/**
 * The map with the science on it: owns `MapView`, the animation loop and the layer scene.
 * Clicks on a city marker select it; while "Drop source" is armed a map click reports its
 * lon/lat through `onDropPoint` instead (crosshair cursor; Escape disarms).
 */
import type { Layer } from "@deck.gl/core";
import type { Device } from "@luma.gl/core";
import type * as maplibregl from "maplibre-gl";
import { useCallback, useEffect, useRef, useState } from "react";
import { useStore } from "../state/store";
import { useDropStore } from "./dropStore";
import { useMapStatus } from "./mapStatus";
import { INITIAL_VIEW, LAYER_IDS, MapView, type MapReadyInfo } from "./MapView";
import { MapScene, type SceneEnv } from "./mapScene";
import { TransientProblem } from "./transientProblem";
import { useMapAnimation } from "./useMapAnimation";
import "./map.css";

export interface MapContainerProps {
  /** While "Drop source" is armed: the clicked point and its screen position (CSS px, viewport). */
  onDropPoint?: (lon: number, lat: number, x: number, y: number) => void;
  /** Map and layer problems keyed by source ("plume", "wind", "path", "map", ...); null clears. */
  onProblem?: (key: string, message: string | null) => void;
}

export function MapContainer({ onDropPoint, onProblem }: MapContainerProps) {
  const [layers, setLayers] = useState<Layer[]>([]);
  const terrain = useStore((s) => s.layers.terrain);
  const armed = useDropStore((s) => s.armedForDrop);
  const env = useRef<SceneEnv>({
    ready: false, flatBeforeId: undefined, zoom: INITIAL_VIEW.zoom, armedForDrop: false, device: null,
    project: null, viewVersion: 0,
  });
  env.current.armedForDrop = armed;
  const sceneRef = useRef<MapScene | null>(null);
  const latest = useRef({ onDropPoint, onProblem });
  latest.current = { onDropPoint, onProblem };

  useEffect(() => {
    const scene = new MapScene(
      useStore,
      (k, m) => latest.current.onProblem?.(k, m),
      (hour) => useMapStatus.setState({ plumeLoadingHour: hour }),
      (hour) => useMapStatus.setState({ pathHour: hour }),
    );
    sceneRef.current = scene;
    return () => {
      scene.dispose();
      sceneRef.current = null;
    };
  }, []);

  useMapAnimation(
    (dt) => {
      const next = sceneRef.current?.frame(dt, env.current);
      if (next) setLayers(next);
    },
    (message) => latest.current.onProblem?.("animation", message),
  );

  const onMapReady = useCallback((map: maplibregl.Map, _info: MapReadyInfo) => {
    void _info;
    // Our state lines sit just beneath the basemap labels (labelsBelowId), so drawing the flat
    // layers beneath them keeps the plume under both the India boundaries and the place names.
    env.current.flatBeforeId = LAYER_IDS.stateLines;
    env.current.zoom = map.getZoom();
    env.current.project = (ll) => {
      const p = map.project(ll);
      return [p.x, p.y];
    };
    env.current.ready = true;
    map.on("zoom", () => {
      env.current.zoom = map.getZoom();
    });
    const settle = () => {
      env.current.zoom = map.getZoom();
      env.current.viewVersion++;
    };
    map.on("moveend", settle);
    map.on("resize", settle);
    map.on("click", (e) => {
      if (!useDropStore.getState().armedForDrop) return;
      const box = map.getContainer().getBoundingClientRect();
      latest.current.onDropPoint?.(e.lngLat.lng, e.lngLat.lat, box.left + e.point.x, box.top + e.point.y);
    });
  }, []);

  const onDevice = useCallback((device: Device) => {
    env.current.device = device;
  }, []);

  // MapLibre errors (e.g. one failed tile) are transient: shown once, cleared after 10 s
  const mapProblem = useRef<TransientProblem | null>(null);
  useEffect(() => {
    const p = new TransientProblem((m) => latest.current.onProblem?.("map", m));
    mapProblem.current = p;
    return () => p.dispose();
  }, []);
  const onError = useCallback((message: string) => mapProblem.current?.raise(message), []);

  useEffect(() => {
    if (!armed) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") useDropStore.getState().disarm();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [armed]);

  return (
    <div className={armed ? "vayu-map armed" : "vayu-map"}>
      <MapView layers={layers} terrain={terrain} onMapReady={onMapReady} onError={onError} onDevice={onDevice} />
    </div>
  );
}
