// One-off: union the state polygons into a single national outline.
// Usage: node scripts/build-outline.mjs   (writes public/india-outline.geojson)
import { readFileSync, writeFileSync } from "node:fs";
import { featureCollection } from "@turf/helpers";
import union from "@turf/union";

const states = JSON.parse(readFileSync("public/india-boundary.geojson", "utf8"));
const merged = union(featureCollection(states.features));
if (!merged) throw new Error("union produced nothing");
// State edges don't match perfectly, leaving sliver holes; keep exterior rings only.
const polys = merged.geometry.type === "Polygon" ? [merged.geometry.coordinates] : merged.geometry.coordinates;
merged.geometry = { type: "MultiPolygon", coordinates: polys.map((p) => [p[0]]) };
merged.properties = { name: "India" };
writeFileSync("public/india-outline.geojson", JSON.stringify(featureCollection([merged])));
console.log("wrote public/india-outline.geojson", merged.geometry.type);
