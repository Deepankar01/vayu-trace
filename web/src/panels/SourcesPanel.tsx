/**
 * Left panel: sources and what-if controls. Fires are observed (only the global fire scaling is
 * adjustable); the four sector sliders weight every region's tag of that sector 0–200 %. Region
 * scenarios work on the Delhi NCR tags only. Every change is a weight on already simulated
 * fields: the map, labels and city panel recompose in the browser, nothing is re-simulated.
 */
import type { Sector } from "../api/types";
import { useDropStore } from "../map/dropStore";
import { TAG_COLORS } from "../lib/colors";
import { DASH, fmtISTShort } from "../lib/format";
import { FIRE_SCALING_RANGE, SLIDER_RANGE } from "../state/weights";
import { MAX_ADDED_SOURCES } from "./dropKinds";
import { useApp, useAppStore } from "./storeContext";
import { Dot, Info, Slider, Switch, cityOf } from "./ui";

export const NO_DUST_NOTE = "No baseline dust data — add sites with Drop source";
export const FIRE_SCALING_TIP =
  "Satellites miss small and short-lived fires and fires under cloud or smoke. This multiplies all fire " +
  "emissions by one number for the whole run. Default 1× means no correction.";

const SECTORS: { sector: Sector; label: string; color: string; note?: string }[] = [
  { sector: "vehicles", label: "Vehicles", color: TAG_COLORS.vehicles, note: "Includes road-dust resuspension reported with road transport in the inventory" },
  { sector: "industry", label: "Industry and power", color: TAG_COLORS.industry },
  { sector: "dust", label: "Road and construction dust", color: TAG_COLORS.dust },
  { sector: "residential", label: "Residential", color: TAG_COLORS.residential },
];

/** Night-inversion strength from the mixing height (m): strong < 300, weak 300–800, none above. */
export function inversionOf(blh: number | null): string {
  if (blh == null || !Number.isFinite(blh)) return DASH;
  if (blh < 300) return "strong";
  if (blh <= 800) return "weak";
  return "none";
}

const pct = (v: number) => Math.round(v * 100);

export function SourcesPanel() {
  const store = useAppStore();
  const meta = useApp((s) => s.meta);
  const sliders = useApp((s) => s.sliders);
  const fireScaling = useApp((s) => s.fireScaling);
  const firesContinue = useApp((s) => s.firesContinue);
  const region = useApp((s) => s.regionScenario);
  const users = useApp((s) => s.userSources);
  const compare = useApp((s) => s.compareBaseline);
  const selected = useApp((s) => s.selectedCity);
  const hour = useApp((s) => Math.floor(s.hour));
  const armed = useDropStore((d) => d.armedForDrop);

  const s = store.getState;
  const dust = meta?.notes.dust_available ?? true;
  const fireDefault = meta?.notes.fire_scaling_default ?? 1;
  const atCap = users.length >= MAX_ADDED_SOURCES;
  const city = cityOf(meta, selected);
  const blh = city?.met.blh_m[hour] ?? null;

  const reset = () => {
    const st = s();
    st.resetScenario();
    for (const u of st.userSources) if (u.enabled) st.toggleUserSource(u.id);
  };

  return (
    <div className="side-inner">
      <h4>Sources</h4>
      <div className="row">
        <span className="name"><Dot color={TAG_COLORS.fires} />Fires (satellite)</span>
        <span className="mute small">observed</span>
      </div>
      <div className="row sub">
        <span className="name mute">
          Fire scaling
          <Info label="About fire scaling">{FIRE_SCALING_TIP}</Info>
        </span>
        <span className="num value">{fireScaling.toFixed(1)}×</span>
      </div>
      <Slider
        label="Fire scaling" value={fireScaling} min={FIRE_SCALING_RANGE.min} max={FIRE_SCALING_RANGE.max} step={0.1}
        color={TAG_COLORS.fires} resetTo={fireDefault} onChange={(v) => s().setFireScaling(Math.round(v * 10) / 10)}
      />

      {SECTORS.map(({ sector, label, color, note }) => {
        const disabled = sector === "dust" && !dust;
        const v = sliders[sector];
        return (
          <div key={sector} className={disabled ? "sector disabled" : "sector"}>
            <div className="row">
              <span className="name"><Dot color={color} muted={disabled} />{label}</span>
              <span className="value-wrap">
                {!disabled && v !== 1 && (
                  <button type="button" className="reset-one" aria-label={`Reset ${label} to 100%`} onClick={() => s().setSlider(sector, 1)}>↺</button>
                )}
                <span className="num value" data-testid={`pct-${sector}`}>{disabled ? DASH : `${pct(v)}%`}</span>
              </span>
            </div>
            <Slider
              label={label} value={pct(v)} min={SLIDER_RANGE.min * 100} max={SLIDER_RANGE.max * 100} step={5}
              color={color} disabled={disabled} resetTo={100} onChange={(x) => s().setSlider(sector, x / 100)}
            />
            {note && <p className="note">{note}</p>}
            {disabled && <p className="note warn">{NO_DUST_NOTE}</p>}
          </div>
        );
      })}

      <div className="sep" />
      <h4>
        What-if scenarios
        <Info label="About the scenarios">
          Illustrative presets, not policy assessments: odd-even scales Delhi NCR vehicle emissions by 0.7; the
          construction ban sets Delhi NCR road and construction dust to zero.
        </Info>
      </h4>
      <Switch label="Odd-even traffic, Delhi NCR" checked={region.delhiOddEven} onChange={(on) => s().setRegionScenario("delhiOddEven", on)}>
        <span className="switch-label">Odd-even traffic, Delhi NCR</span>
        {region.delhiOddEven && <span className="effect good num">−30% vehicles</span>}
      </Switch>
      <Switch
        label="Construction ban, Delhi NCR" checked={region.delhiConstructionBan} disabled={!dust}
        onChange={(on) => s().setRegionScenario("delhiConstructionBan", on)}
      >
        <span className="switch-label">Construction ban, Delhi NCR</span>
        {region.delhiConstructionBan && dust && <span className="effect good">dust → 0</span>}
      </Switch>
      {!dust && <p className="note warn">{NO_DUST_NOTE}</p>}
      {meta?.fires_assumed_from != null && (
        <Switch label="Fires stop now" checked={!firesContinue} onChange={(on) => s().setFiresContinue(!on)}>
          <span className="switch-label">Fires stop now</span>
          {!firesContinue && <span className="effect accent">assumed fires off</span>}
        </Switch>
      )}

      {users.length > 0 && (
        <>
          <h4 className="h4-sub">Added sources</h4>
          {users.map((u, i) => (
            <div key={u.id} className="user-source">
              <Switch label={`${i + 1}. ${u.label}`} checked={u.enabled} onChange={() => s().toggleUserSource(u.id)}>
                <span className="switch-label user-label"><Dot color={u.color} muted={!u.enabled} /><span>{i + 1}. {u.label}</span></span>
              </Switch>
              <p className="user-meta num">
                {u.spec && meta
                  ? `${fmtISTShort(meta.hours[u.spec.start_hour])} IST · ${u.spec.duration_h} h · ${u.spec.lat.toFixed(2)}° N, ${u.spec.lon.toFixed(2)}° E`
                  : "added earlier to this run"}
              </p>
            </div>
          ))}
        </>
      )}

      <button
        type="button" className={`btn dashed${armed ? " armed" : ""}`} disabled={atCap}
        aria-pressed={armed}
        onClick={() => (armed ? useDropStore.getState().disarm() : useDropStore.getState().arm())}
      >
        {armed ? "Cancel drop" : "+ Drop source on map"}
      </button>
      {armed && <p className="hint" role="status"><span>Click the map to place the source</span> <span className="kbd">Esc</span> cancels</p>}
      {atCap && <p className="note">At most {MAX_ADDED_SOURCES} added sources per run</p>}
      <div className="btn-row">
        <button type="button" className={`btn${compare ? " on" : ""}`} aria-pressed={compare} onClick={() => s().setCompareBaseline(!compare)}>
          Compare with baseline
        </button>
        <button type="button" className="btn reset" onClick={reset}>Reset</button>
      </div>

      <div className="sep" />
      <h4>Weather acting on smoke{city ? ` · ${city.name}` : ""}</h4>
      <div className="row">
        <span className="mute">Night inversion</span>
        <span data-testid="inversion">{inversionOf(blh)}</span>
      </div>
      <div className="row">
        <span className="mute name">Rain washout<Info label="About rain washout">Not available per city: the run's city weather carries no precipitation.</Info></span>
        <span data-testid="rain" className="mute">—</span>
      </div>
      <div className="row">
        <span className="mute name">Terrain blocking<Info label="About terrain blocking">Smoke cannot enter terrain above the mixed layer, so the Himalaya and other ranges hold it back.</Info></span>
        <span data-testid="terrain">on</span>
      </div>
    </div>
  );
}
