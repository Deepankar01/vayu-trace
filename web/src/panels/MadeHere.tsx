/**
 * "Made here vs arrived" for the selected city at the playhead hour: how much of the modelled
 * concentration of the pollutant in view was emitted inside the city's own square and how much
 * came from outside, plus (always) the made-here share of PM2.5 next to that of coarse PM, which
 * is the comparison the coarse tags exist for. A model estimate, never a measurement.
 */
import type { CityMeta, MetaNotes } from "../api/types";
import type { Weights } from "../lib/compose";
import { fmtNumber, fmtShare, fmtSharesToWhole } from "../lib/format";
import { madeHere, type MadeHere } from "../lib/madeHere";
import { POLLUTANT_INLINE, type Pollutant } from "../lib/pollutant";
import { USER_COLOR } from "../lib/tags";
import { Dot, HourTag } from "./ui";

export const MADE_HERE_COLOR = "#f2d15c";
export const ARRIVED_COLOR = "#7f8aa3";

/** "Coarse particles deposit 5× faster ..." from the run's two deposition velocities; null if unusable. */
export function depositionNote(notes: Pick<MetaNotes, "v_dep_fine_m_s" | "v_dep_coarse_m_s">): string | null {
  const fine = notes.v_dep_fine_m_s;
  const coarse = notes.v_dep_coarse_m_s;
  if (!(fine > 0) || !(coarse > 0)) return null;
  const ratio = Number((coarse / fine).toFixed(1));
  return (
    `In the model coarse particles deposit ${ratio}× faster than fine ones (${coarse} vs ${fine} m/s), ` +
    "so less coarse PM arrives from far away."
  );
}

interface Part {
  key: "local" | "arrived" | "added";
  label: string;
  color: string;
  value: number | null;
  share: number | null;
}

function partsOf(m: MadeHere): Part[] {
  const parts: Part[] = [
    { key: "local", label: "Made here", color: MADE_HERE_COLOR, value: m.local, share: m.localShare },
    { key: "arrived", label: "Arrived from outside", color: ARRIVED_COLOR, value: m.arrived, share: m.arrivedShare },
  ];
  // added sources are not split by place: a third part, and only when they contribute
  if (m.added !== null && m.added !== 0) {
    parts.push({ key: "added", label: "Added sources", color: USER_COLOR, value: m.added, share: m.addedShare });
  }
  return parts;
}

export interface MadeHereProps {
  city: Pick<CityMeta, "by_tag" | "by_tag_local">;
  weights: Weights;
  hour: number;
  pollutant: Pollutant;
  notes: Pick<MetaNotes, "city_area_km" | "v_dep_fine_m_s" | "v_dep_coarse_m_s">;
}

export function MadeHereBlock({ city, weights, hour, pollutant, notes }: MadeHereProps) {
  let view: MadeHere;
  let fine: MadeHere;
  let coarse: MadeHere;
  try {
    view = madeHere(city, weights, hour, pollutant);
    fine = pollutant === "pm25" ? view : madeHere(city, weights, hour, "pm25");
    coarse = pollutant === "coarse" ? view : madeHere(city, weights, hour, "coarse");
  } catch {
    return null; // stale weights: the breakdown section above reports the problem
  }
  const parts = partsOf(view);
  const shareText = fmtSharesToWhole(parts.map((p) => p.share));
  const physics = depositionNote(notes);

  return (
    <section aria-label="Made here vs arrived">
      <h4 className="h4-tagged" data-testid="made-here-title">
        <span className="h4-text">Made here vs arrived · <span className="nocase">{POLLUTANT_INLINE[pollutant]} (this hour)</span></span>
        <HourTag />
      </h4>
      <div className="bar" aria-hidden="true">
        {parts.map((p) => (
          <div key={p.key} data-testid={`mh-seg-${p.key}`} className="seg" style={{ width: `${(p.share ?? 0) * 100}%`, background: p.color }} />
        ))}
      </div>
      <ul className="legend made-here" aria-label="Made here vs arrived">
        {parts.map((p, i) => (
          <li key={p.key}>
            <span className="name"><Dot color={p.color} />{p.label}</span>
            <span className="v num" data-testid={`mh-${p.key}`}>
              <span className="mh-value">{fmtNumber(p.value)} µg/m³</span>{shareText[i]}
            </span>
          </li>
        ))}
      </ul>
      <p className="note share-note">
        Made here: emitted inside the city's own ≈ {notes.city_area_km} km square. Model estimate, not measured.
      </p>
      <p className="hour-compare num" data-testid="made-here-compare">
        Made here: PM2.5 {fmtShare(fine.localShare)} · coarse {fmtShare(coarse.localShare)}
      </p>
      {physics && <p className="note share-note" data-testid="deposition-note">{physics}</p>}
    </section>
  );
}
