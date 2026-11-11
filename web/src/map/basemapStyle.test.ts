import { boundaryLayerIds, firstLineOrSymbolId, labelLayerIds } from "./basemapStyle";

const layers = [
  { id: "background", type: "background" },
  { id: "landcover", type: "fill", "source-layer": "landuse" },
  { id: "boundary_county", type: "line", "source-layer": "boundaries" },
  { id: "boundary_state", type: "line", "source-layer": "boundaries" },
  { id: "road_minor_fill", type: "line", "source-layer": "roads" },
  { id: "boundary_country_outline", type: "line", "source-layer": "boundaries" },
  { id: "disputed_line", type: "line", "source-layer": "other" },
  { id: "place_city_r6", type: "symbol", "source-layer": "places" },
];

describe("basemap layer selection", () => {
  it("hides every boundary and disputed line layer, nothing else", () => {
    expect(boundaryLayerIds(layers)).toEqual([
      "boundary_county",
      "boundary_state",
      "boundary_country_outline",
      "disputed_line",
    ]);
  });

  it("returns symbol layers for subduing", () => {
    expect(labelLayerIds(layers)).toEqual(["place_city_r6"]);
  });

  it("finds the first line or symbol layer", () => {
    expect(firstLineOrSymbolId(layers)).toBe("boundary_county");
    expect(firstLineOrSymbolId([layers[0], layers[1]])).toBeUndefined();
  });
});
