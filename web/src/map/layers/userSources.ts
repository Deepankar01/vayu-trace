/** Rings at the user's added sources, dimmed when the source is switched off. */
import { ScatterplotLayer } from "@deck.gl/layers";
import type { UserSource } from "../../state/store";
import { hexToRgba } from "./rgba";

interface Marker {
  id: string;
  position: [number, number];
  color: string;
  enabled: boolean;
}

/** Only sources whose location is known (restored ones have no spec). */
export function userSourceMarkers(sources: readonly UserSource[]): Marker[] {
  return sources
    .filter((s) => s.spec)
    .map((s) => ({ id: s.id, position: [s.spec!.lon, s.spec!.lat], color: s.color, enabled: s.enabled }));
}

export function userSourcesLayer(sources: readonly UserSource[]) {
  const data = userSourceMarkers(sources);
  return new ScatterplotLayer<Marker>({
    id: "user-sources",
    data,
    getPosition: (d) => d.position,
    radiusUnits: "pixels",
    getRadius: 6,
    filled: true,
    getFillColor: (d) => hexToRgba(d.color, d.enabled ? 60 : 15),
    stroked: true,
    lineWidthUnits: "pixels",
    getLineWidth: 1.5,
    getLineColor: (d) => hexToRgba(d.color, d.enabled ? 235 : 80),
    pickable: false,
  });
}
