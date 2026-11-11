/** Keyless dark vector basemap (CARTO Dark Matter, Protomaps/OSM data). */
export const BASEMAP_STYLE_URL =
  "https://basemaps.cartocdn.com/gl/dark-matter-gl-style/style.json";

export const TERRAIN_TILES = "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const TERRAIN_ATTRIBUTION = "Terrain: Mapzen / AWS Open Data";

export interface StyleLayerLike {
  id: string;
  type: string;
  "source-layer"?: string;
}

/**
 * Basemap layers carrying international/internal boundaries. We hide them all so that the only
 * boundary drawn around India is the official Government of India depiction (our own layers).
 * In the CARTO style these are the `boundaries` source-layer (country outline/inner, state, county).
 */
export function boundaryLayerIds(layers: StyleLayerLike[]): string[] {
  return layers
    .filter(
      (l) =>
        l.type === "line" &&
        (l["source-layer"] === "boundaries" || /boundar|disputed/i.test(l.id)),
    )
    .map((l) => l.id);
}

/** Place-name layers, to be subdued so the data is the subject. */
export function labelLayerIds(layers: StyleLayerLike[]): string[] {
  return layers.filter((l) => l.type === "symbol").map((l) => l.id);
}

/** Id of the first line/symbol layer: our fills and hillshade go beneath it. */
export function firstLineOrSymbolId(layers: StyleLayerLike[]): string | undefined {
  return layers.find((l) => l.type === "line" || l.type === "symbol")?.id;
}
