import type { Layer } from "@deck.gl/core";
import type { Device } from "@luma.gl/core";
import { MapLibreOverlay } from "@deck.gl/maplibre";
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
  firstSymbolId,
  labelLayerIds,
  softenedOpacity,
} from "./basemapStyle";

// MapLibre 6 locates its worker next to its own module, which breaks under Vite dep pre-bundling.
// Point it at the emitted/served file explicitly.
maplibregl.setWorkerUrl(workerUrl);

export const INITIAL_VIEW = { center: [79, 27] as [number, number], zoom: 4.6, pitch: 35, bearing: 0 };
const MAX_BOUNDS: [[number, number], [number, number]] = [[60, 2], [104, 42]];
const TERRAIN_EXAGGERATION = 1.4;

/** Stable ids of the layers this component adds. */
export const LAYER_IDS = {
  hillshade: "hillshade",
  stateLines: "india-state-lines",
  outline: "india-outline-line",
} as const;

export interface MapReadyInfo {
  /**
   * Id of the first basemap label layer (undefined if the style has none). Use as `beforeId` for
   * layers that should sit under place names; our boundary lines are already placed here.
   */
  labelsBelowId: string | undefined;
}

export interface MapViewProps {
  /** deck.gl layers drawn (interleaved) on top of the basemap. */
  layers?: Layer[];
  /** 3D terrain on/off. Hillshade stays on either way so relief still reads when flat. */
  terrain?: boolean;
  /** Called once the style (and our boundary/terrain layers) are loaded. */
  onMapReady?: (map: maplibregl.Map, info: MapReadyInfo) => void;
  /** Style fetch failures, setup exceptions and map runtime errors, as a message. */
  onError?: (message: string) => void;
  /** The GPU device deck.gl draws with (shared with MapLibre), once it exists: lets layers own
   *  textures that they update in place instead of re-creating them per frame. */
  onDevice?: (device: Device) => void;
}

export const BOUNDARY_ATTRIBUTION = "Boundaries: datta07/INDIAN-SHAPEFILES (MIT)";

const demSource = (): maplibregl.RasterDEMSourceSpecification => ({
  type: "raster-dem",
  tiles: [TERRAIN_TILES],
  encoding: "terrarium",
  tileSize: 256,
  maxzoom: 12,
  attribution: TERRAIN_ATTRIBUTION,
});

function setupMap(map: maplibregl.Map, terrain: boolean): MapReadyInfo {
  const style = map.getStyle();
  const layers = style.layers ?? [];
  const below = firstLineOrSymbolId(layers);
  const labelsBelowId = firstSymbolId(layers);

  // The basemap's own boundaries are hidden; ours (official GoI depiction) replace them.
  for (const id of boundaryLayerIds(layers)) map.setLayoutProperty(id, "visibility", "none");
  // Subdue place names: the data is the subject.
  for (const id of labelLayerIds(layers)) {
    for (const prop of ["text-opacity", "icon-opacity"] as const) {
      map.setPaintProperty(id, prop, softenedOpacity(map.getPaintProperty(id, prop)) as never);
    }
  }

  // Separate DEM sources for hillshade and terrain (MapLibre advises against sharing one).
  map.addSource("terrain-dem", demSource());
  map.addSource("hillshade-dem", demSource());
  map.addLayer(
    {
      id: LAYER_IDS.hillshade,
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

  map.addSource("india-states", { type: "geojson", data: "/india-boundary.geojson", attribution: BOUNDARY_ATTRIBUTION });
  map.addSource("india-outline", { type: "geojson", data: "/india-outline.geojson" });
  map.addLayer(
    {
      id: LAYER_IDS.stateLines,
      type: "line",
      source: "india-states",
      paint: { "line-color": "rgba(255,255,255,0.18)", "line-width": 0.6 },
    },
    labelsBelowId,
  );
  map.addLayer(
    {
      id: LAYER_IDS.outline,
      type: "line",
      source: "india-outline",
      layout: { "line-join": "round" },
      paint: { "line-color": "rgba(255,255,255,0.35)", "line-width": 1 },
    },
    labelsBelowId,
  );

  map.setTerrain(terrain ? { source: "terrain-dem", exaggeration: TERRAIN_EXAGGERATION } : null);
  return { labelsBelowId };
}

export function MapView({ layers = [], terrain = true, onMapReady, onError, onDevice }: MapViewProps) {
  const container = useRef<HTMLDivElement>(null);
  const mapRef = useRef<maplibregl.Map | null>(null);
  const overlayRef = useRef<MapLibreOverlay | null>(null);
  const readyRef = useRef(false);
  // Latest props, readable from the one-time load handler.
  const latest = useRef({ layers, terrain, onMapReady, onError, onDevice });
  latest.current = { layers, terrain, onMapReady, onError, onDevice };

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

    const overlay = new MapLibreOverlay({
      interleaved: true,
      // Every deck.gl layer here is flat and ordered by `beforeId`/array order, so depth testing
      // only hurts: against MapLibre's depth buffer at pitch it clipped flat circles into slivers
      // and hid some text entirely.
      parameters: { depthCompare: "always", depthWriteEnabled: false },
      pickingRadius: 8, // city markers are small: be forgiving
      layers: latest.current.layers,
      onDeviceInitialized: (device: Device) => latest.current.onDevice?.(device),
    });
    map.addControl(overlay);
    mapRef.current = map;
    overlayRef.current = overlay;

    const report = (message: string, err?: unknown) => {
      console.error(`[MapView] ${message}`, err ?? "");
      latest.current.onError?.(message);
    };
    map.on("error", (e) => report(`Map error: ${e.error?.message ?? "unknown"}`, e.error));

    map.once("load", () => {
      try {
        const info = setupMap(map, latest.current.terrain);
        readyRef.current = true;
        latest.current.onMapReady?.(map, info);
      } catch (err) {
        report(`Map setup failed: ${err instanceof Error ? err.message : String(err)}`, err);
      }
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
