/**
 * City markers and their two-line labels: the name, then one of "AQI N" / "arrives +N h" /
 * "smoke present · N h old" (the smoke lines from the weighted fire contribution and the
 * 15 ug/m3 threshold of `arrival`). Marker colour is the CPCB category of the AQI.
 */
import type { PickingInfo } from "@deck.gl/core";
import { ScatterplotLayer, TextLayer } from "@deck.gl/layers";
import type { CityMeta } from "../../api/types";
import { pm25ToAqi, rolling24h } from "../../lib/aqi";
import { arrival } from "../../lib/breakdown";
import { aqiColor } from "../../lib/colors";
import { cityTotals, type Weights } from "../../lib/compose";
import { hexToRgba } from "./rgba";

export interface CityLabel {
  primary: string;
  secondary: string;
  /** CPCB category colour of `aqi` (mute grey when null). */
  color: string;
  /** PM2.5-based AQI of the rolling 24 h mean, null when unavailable. */
  aqi: number | null;
}

const isFireTag = (id: string) => id.startsWith("fire_") || id.startsWith("firefc_");

/**
 * Weighted fire contribution (all `fire_*` and `firefc_*` tags) per hour, ug/m3. Tags of weight 0
 * are skipped; a contributing tag that is null at an hour makes that hour null (`arrival` treats
 * null as below the threshold). A fire tag with no weight entry throws, like `cityTotals`.
 */
export function fireSeries(city: Pick<CityMeta, "by_tag" | "fire_age_h">, weights: Weights): (number | null)[] {
  const ids = Object.keys(city.by_tag).filter(isFireTag).sort();
  for (const id of ids) if (weights[id] === undefined) throw new Error(`no weight for source tag '${id}'`);
  const contributing = ids.filter((id) => weights[id] !== 0);
  const n = ids.reduce((m, id) => Math.max(m, city.by_tag[id].length), city.fire_age_h.length);
  const out: (number | null)[] = [];
  for (let h = 0; h < n; h++) {
    let s: number | null = 0;
    for (const id of contributing) {
      const v = city.by_tag[id][h];
      if (v == null) {
        s = null;
        break;
      }
      s += v * weights[id];
    }
    out.push(s);
  }
  return out;
}

interface Series {
  weights: Weights;
  totals: (number | null)[];
  fire: (number | null)[];
}
const seriesMemo = new WeakMap<CityMeta, Series>();

/** Totals and fire series for a city under `weights`, memoised per (city object, weights identity). */
function seriesFor(city: CityMeta, weights: Weights): Series {
  const hit = seriesMemo.get(city);
  if (hit && hit.weights === weights) return hit;
  const s = { weights, totals: cityTotals(city, weights, city.fire_age_h.length), fire: fireSeries(city, weights) };
  seriesMemo.set(city, s);
  return s;
}

/**
 * The label at `hourIndex` (floored). AQI = `pm25ToAqi(rolling24h(cityTotals(...), h))`, "AQI N"
 * rounded or "AQI –". Secondary: "smoke present · N h old" (N = `fire_age_h[h]` rounded; just
 * "smoke present" if the age is null) when the weighted fire contribution is >= 15 at h,
 * "arrives +N h" when it first reaches 15 later, else the AQI text.
 */
export function cityLabel(city: CityMeta, hourIndex: number, weights: Weights): CityLabel {
  const h = Math.floor(hourIndex);
  const { totals, fire } = seriesFor(city, weights);
  const mean = rolling24h(totals, h);
  const aqi = mean == null ? null : pm25ToAqi(mean);
  const aqiText = aqi == null ? "AQI –" : `AQI ${Math.round(aqi)}`;
  let secondary = aqiText;
  if (h >= 0 && h < fire.length) {
    const age = city.fire_age_h[h] ?? null;
    const a = arrival(fire, h, age);
    if (a.kind === "present") secondary = a.age_h == null ? "smoke present" : `smoke present · ${Math.round(a.age_h)} h old`;
    else if (a.kind === "arrives") secondary = `arrives +${a.in_h} h`;
  }
  return { primary: city.name, secondary, color: aqiColor(aqi), aqi };
}

/** Labels shown at low zoom; every label from LABEL_ALL_ZOOM. */
export const PRIORITY_CITIES: ReadonlySet<string> = new Set([
  "delhi", "lucknow", "kanpur", "patna", "varanasi", "amritsar", "ludhiana", "jaipur", "mumbai", "kolkata",
  "chennai", "bengaluru", "hyderabad", "ahmedabad",
]);
export const LABEL_ALL_ZOOM = 5.5;

export function showLabel(cityId: string, zoom: number): boolean {
  return zoom >= LABEL_ALL_ZOOM || PRIORITY_CITIES.has(cityId);
}

export interface CityDatum {
  city: CityMeta;
  label: CityLabel;
}

const FONT = '-apple-system, "Inter", "Segoe UI", sans-serif';
const TEXT: [number, number, number, number] = [0xe8, 0xea, 0xf0, 255];
const MUTE: [number, number, number, number] = [0xa3, 0xab, 0xbd, 255]; // --mute, lifted a touch for the halo
const HALO: [number, number, number, number] = [0x0b, 0x0e, 0x13, 200];
const SDF = { sdf: true, fontSize: 64, buffer: 8, radius: 12 };

export interface CityLayerProps {
  data: CityDatum[];
  selected: string | null;
  zoom: number;
  /** While a drop is armed, map clicks go to the drop handler: markers are not pickable. */
  pickable: boolean;
  onSelect: (id: string) => void;
}

export function cityLayers({ data, selected, zoom, pickable, onSelect }: CityLayerProps) {
  const sel = data.filter((d) => d.city.id === selected);
  const labelled = data.filter((d) => d.city.id === selected || showLabel(d.city.id, zoom));
  const pos = (d: CityDatum) => [d.city.lon, d.city.lat] as [number, number];
  return [
    new ScatterplotLayer<CityDatum>({
      id: "city-ring",
      data: sel,
      getPosition: pos,
      radiusUnits: "pixels",
      getRadius: 13,
      filled: false,
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1.5,
      getLineColor: (d) => hexToRgba(d.label.color, 180),
      updateTriggers: { getLineColor: [sel.map((d) => d.label.color).join()] },
    }),
    new ScatterplotLayer<CityDatum>({
      id: "city-markers",
      data,
      getPosition: pos,
      radiusUnits: "pixels",
      getRadius: (d) => (d.city.id === selected ? 6 : 4.5),
      getFillColor: (d) => hexToRgba(d.label.color),
      stroked: true,
      lineWidthUnits: "pixels",
      getLineWidth: 1,
      getLineColor: HALO,
      pickable,
      autoHighlight: pickable,
      highlightColor: [255, 255, 255, 60],
      onClick: (info: PickingInfo<CityDatum>) => {
        if (info.object) onSelect(info.object.city.id);
        return true;
      },
      updateTriggers: { getFillColor: [data.map((d) => d.label.color).join()], getRadius: [selected] },
    }),
    new TextLayer<CityDatum>({
      id: "city-names",
      data: labelled,
      getPosition: pos,
      getText: (d) => d.label.primary,
      getSize: 11,
      sizeUnits: "pixels",
      getColor: TEXT,
      fontFamily: FONT,
      fontWeight: 600,
      getTextAnchor: "start",
      getAlignmentBaseline: "bottom",
      getPixelOffset: [11, 1],
      fontSettings: SDF,
      outlineWidth: 3,
      outlineColor: HALO,
      characterSet: "auto",
    }),
    new TextLayer<CityDatum>({
      id: "city-status",
      data: labelled,
      getPosition: pos,
      getText: (d) => d.label.secondary,
      getSize: 10,
      sizeUnits: "pixels",
      getColor: MUTE,
      fontFamily: FONT,
      fontWeight: 400,
      getTextAnchor: "start",
      getAlignmentBaseline: "top",
      getPixelOffset: [11, 2],
      fontSettings: SDF,
      outlineWidth: 3,
      outlineColor: HALO,
      characterSet: "auto",
      updateTriggers: { getText: [labelled.map((d) => d.label.secondary).join("|")] },
    }),
  ];
}
