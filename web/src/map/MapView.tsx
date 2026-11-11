import type { Layer } from "@deck.gl/core";
import { MapboxOverlay } from "@deck.gl/mapbox";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import workerUrl from "maplibre-gl/dist/maplibre-gl-worker.mjs?worker&url";
import { useEffect, useRef } from "react";
import {
  BASEMAP_STYLE_URL,
  TERRAIN_ATTRIBUTION,
  TERRAIN_TILES,
  boundaryLayerIds,
  firstLineOrSymbolId,
  labelLayerIds,
} from "./basemapStyle";

// MapLibre 6 locates its worker next to its own module, which breaks under Vite dep pre-bundling.
// Point it at the emitted/served file explicitly.
maplibregl.setWorkerUrl(workerUrl);

export const INITIAL_VIEW = { center: [79, 27] as [number, number], zoom: 4.6, pitch: 35, bearing: 0 };
const MAX_BOUNDS: [[number, number], [number, number]] = [[60, 2], [104, 42]];
const TERRAIN_EXAGGERATION = 1.4;

export interface MapViewProps {
  /** deck.gl layers drawn (interleaved) on top of the basemap. */
  layers?: Layer[];
  /** 3D terrain on/off. Hillshade stays on either way so relief still reads when flat. */
  terrain?: boolean;
  /** Called once the style (and our boundary/terrain layers) are loaded. */
  onMapReady?: (map: maplibregl.Map) => void;
}

const demSource = (): maplibregl.RasterDEMSourceSpecification => ({
  type: "raster-dem",
  tiles: [TERRAIN_TILES],
  encoding: "terrarium",
  tileSize: 256,
  maxzoom: 12,
  attribution: TERRAIN_ATTRIBUTION,
});

function setupMap(map: maplibregl.Map, terrain: boolean) {
  const style = map.getStyle();
  const layers = style.layers ?? [];
  const below = firstLineOrSymbolId(layers);

  // The basemap's own boundaries are hidden; ours (official GoI depiction) replace them.
  for (const id of boundaryLayerIds(layers)) map.setLayoutProperty(id, "visibility", "none");
  // Subdue place names: the data is the subject.
  for (const id of labelLayerIds(layers)) {
    map.setPaintProperty(id, "text-opacity", 0.55);
    map.setPaintProperty(id, "icon-opacity", 0.55);
  }

  // Separate DEM sources for hillshade and terrain (MapLibre advises against sharing one).
  map.addSource("terrain-dem", demSource());
  map.addSource("hillshade-dem", { ...demSource(), attribution: undefined });
  map.addLayer(
    {
      id: "hillshade",
      type: "hillshade",
      source: "hillshade-dem",
      paint: {
        "hillshade-exaggeration": 0.35,
        "hillshade-shadow-color": "#000000",
        "hillshade-highlight-color": "rgba(255,255,255,0.10)",
        "hillshade-accent-color": "#000000",
      },
    },
    below,
  );

  map.addSource("india-states", { type: "geojson", data: "/india-boundary.geojson" });
  map.addSource("india-outline", { type: "geojson", data: "/india-outline.geojson" });
  map.addLayer({
    id: "india-state-lines",
    type: "line",
    source: "india-states",
    paint: { "line-color": "rgba(255,255,255,0.18)", "line-width": 0.6 },
  });
  map.addLayer({
    id: "india-outline-line",
    type: "line",
    source: "india-outline",
    layout: { "line-join": "round" },
    paint: { "line-color": "rgba(255,255,255,0.35)", "line-width": 1 },
  });

  map.setTerrain(terrain ? { source: "terrain-dem", exaggeration: TERRAIN_EXAGGERATION } : null);
}

export function MapView({ layers = [], terrain = true, onMapReady }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapboxOverlay | null>(null);
  const readyRef = useRef(false);
  // Latest props, readable from the one-time load handler.
  const latest = useRef({ layers, terrain, onMapReady });
  latest.current = { layers, terrain, onMapReady };

  useEffect(() => {
    const map = new maplibregl.Map({
      container: container.current!,
      style: BASEMAP_STYLE_URL,
      ...INITIAL_VIEW,
      minZoom: 3.5,
      maxZoom: 9,
      maxBounds: MAX_BOUNDS,
      attributionControl: { compact: true },
    });
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "bottom-right");

    const overlay = new MapboxOverlay({ interleaved: true, layers: latest.current.layers });
    map.addControl(overlay as unknown as maplibregl.IControl);
    mapRef.current = map;
    overlayRef.current = overlay;

    map.once("load", () => {
      setupMap(map, latest.current.terrain);
      readyRef.current = true;
      latest.current.onMapReady?.(map);
    });

    return () => {
      readyRef.current = false;
      overlayRef.current = null;
      mapRef.current = null;
      map.remove();
    };
  }, []);

  useEffect(() => {
    overlayRef.current?.setProps({ layers });
  }, [layers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !readyRef.current) return;
    map.setTerrain(terrain ? { source: "terrain-dem", exaggeration: TERRAIN_EXAGGERATION } : null);
  }, [terrain]);

  return <div ref={container} style={{ position: "absolute", inset: 0 }} />;
}
