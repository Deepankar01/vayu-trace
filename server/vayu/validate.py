"""Model vs measured PM2.5 at the northern cities over one episode (`python -m vayu.validate`).

    python -m vayu.validate 2025-11-03 2025-11-09

What is compared, per city and hour (UTC hours, [t, t+1)):
- simulated: dry PM2.5, the value the UI shows for a city: the mean over the 3x3 cell block
  around the city (about 30 km), summed over every source tag at default weights (all 1, fire
  scaling 1, fires continue); null where any contributing tag is null;
- measured: CPCB PM2.5 via OpenAQ (`city_pm25`: median over up to 5 stations within 25 km of
  CPCB's half-hour-offset hour averages, overlap-aligned to UTC hours);
- CAMS: Copernicus PM2.5 from Open-Meteo at the city point, as a reference forecast.

Hours of the episode are taken from stored runs without double counting (`segments`): each run
covers 144 hours from two days before its date, so consecutive 6-day blocks of the episode each
come from the run whose window starts on the block's first day; a final shorter block comes from
the run whose window ends on the episode's last day. Nothing is fitted or tuned to these
measurements; the numbers are reported as they come out.

Writes `data/validation.json` (served by GET /api/validation) and
`docs/validation/{YYYY-MM}.md` at the repository root.

With `--pollutant pm10` the same comparison is made for PM10 (simulated: fine plus coarse tags,
which includes the ESTIMATED road and construction dust; measured: CPCB PM10; CAMS PM10) and
written to `data/validation-pm10.json` and `docs/validation/{YYYY-MM}-pm10.md`.
"""
import argparse
import hashlib
import json
import math
import sys
import time
from collections.abc import Callable
from datetime import UTC, date, datetime, timedelta
from pathlib import Path

import numpy as np

from vayu import config
from vayu.cities import CITIES, City
from vayu.errors import UpstreamError

MIN_N = 24  # metrics are None below this many paired hours
N_NORTHERN = 28  # CITIES[:28]: Delhi ... Muzaffarpur
NCR = ("delhi", "gurugram", "noida", "ghaziabad", "faridabad")
IST = timedelta(hours=5, minutes=30)
DAY_IST = (10, 17)  # an hour counts as day if it starts between 10:00 and 17:59 IST
NIGHT_IST = (22, 5)  # ... as night if it starts between 22:00 and 05:59 IST
WINDOW_DAYS = 6  # a run's window: 144 hours from two days before its date
NO_FIT = "No parameter was fitted to these measurements."
REPO_ROOT = Path(__file__).resolve().parents[2]
METRIC_KEYS = ("r", "bias", "nmb", "rmse", "fac2")
POOL_NAMES = {"all": "All 28 northern cities", "ncr": "Delhi NCR (5 cities)"}


# --- metrics ---

def _f(x) -> float | None:
    x = float(x)
    return x if math.isfinite(x) else None


def metrics(sim: np.ndarray, measured: np.ndarray) -> dict:
    """{n, r, bias, nmb, rmse, fac2} over hours where both are finite.

    bias = mean(sim - obs) (ug/m3); nmb = sum(sim - obs) / sum(obs); fac2 = share of hours with
    obs > 0 and 0.5 <= sim/obs <= 2. Every field but n is None when n < MIN_N; r is also None
    when either series has no variance.
    """
    sim = np.asarray(sim, dtype=float)
    obs = np.asarray(measured, dtype=float)
    ok = np.isfinite(sim) & np.isfinite(obs)
    n = int(ok.sum())
    out = {"n": n, **{k: None for k in METRIC_KEYS}}
    if n < MIN_N:
        return out
    s, o = sim[ok], obs[ok]
    d = s - o
    if s.std() > 0 and o.std() > 0:
        out["r"] = _f(np.corrcoef(s, o)[0, 1])
    out["bias"] = _f(d.mean())
    out["nmb"] = _f(d.sum() / o.sum()) if o.sum() > 0 else None
    out["rmse"] = _f(np.sqrt((d**2).mean()))
    pos = o > 0
    if pos.any():
        ratio = s[pos] / o[pos]
        out["fac2"] = _f(((ratio >= 0.5) & (ratio <= 2.0)).mean())
    return out


def day_night_masks(start: datetime, hours: int) -> tuple[np.ndarray, np.ndarray]:
    """Boolean (hours,) masks: hour h ([start + h, start + h + 1) UTC) is day if it starts at
    10:00-17:59 IST and night if it starts at 22:00-05:59 IST."""
    ist_hour = np.array([(start + timedelta(hours=h) + IST).hour for h in range(hours)])
    day = (ist_hour >= DAY_IST[0]) & (ist_hour <= DAY_IST[1])
    night = (ist_hour >= NIGHT_IST[0]) | (ist_hour <= NIGHT_IST[1])
    return day, night


def _bias(sim, obs, mask) -> dict:
    m = metrics(np.where(mask, sim, np.nan), obs)
    return {"n": m["n"], "bias": m["bias"], "nmb": m["nmb"]}


def bias_split(sim, obs, start: datetime) -> dict:
    """{"day": {n, bias, nmb}, "night": {...}} (None below MIN_N pairs)."""
    day, night = day_night_masks(start, len(sim))
    return {"day": _bias(sim, obs, day), "night": _bias(sim, obs, night)}


def _mean_paired(a, b) -> float | None:
    a, b = np.asarray(a, float), np.asarray(b, float)
    ok = np.isfinite(a) & np.isfinite(b)
    return _f(a[ok].mean()) if ok.any() else None


PM10_NOTE = ("PM10 here is the model's PM2.5 plus its coarse (2.5-10 um) part. The largest coarse "
             "source, road and construction dust, is an estimate (national totals spread by a "
             "traffic proxy), not gridded data, so these figures test that estimate as much as "
             "the transport.")


def simulated_total(by_tag: dict[str, list], hours: int, pollutant: str = "pm25") -> np.ndarray:
    """PM2.5: sum over the FINE tags of a city's series (lists with None for missing), NaN where
    any is None. Tags absent from `by_tag` are all-zero series (the API omits those). `coarse_`
    tags (the 2.5-10 um part of PM10) are not PM2.5 and are left out. With `pollutant="pm10"`
    every tag is summed."""
    total = np.zeros(hours)
    for tag, values in by_tag.items():
        if pollutant == "pm25" and tag.startswith("coarse_"):
            continue
        total += np.array([np.nan if v is None else v for v in values], dtype=float)
    return total


# --- episode assembly ---

def _window_start(day: date) -> datetime:
    return datetime.combine(day - timedelta(days=2), datetime.min.time(), tzinfo=UTC)


def segments(first: date, last: date) -> list[tuple[date, datetime, int]]:
    """(run date, first UTC hour taken from that run, number of hours) covering every hour of
    first 00:00 .. last 23:00 UTC exactly once. Whole 6-day blocks come from the run whose
    window starts on the block's first day (date = block start + 2); a final shorter block comes
    from the run whose window ends on `last` (date = last - 3)."""
    out = []
    block = first
    while block <= last:
        days = min(WINDOW_DAYS, (last - block).days + 1)
        run_day = block + timedelta(days=2) if days == WINDOW_DAYS else last - timedelta(days=3)
        out.append((run_day, datetime.combine(block, datetime.min.time(), tzinfo=UTC), days * 24))
        block += timedelta(days=days)
    return out


# --- report ---

def _row(sim, obs, cams, start) -> dict:
    """Model vs measured over hours where both exist; CAMS vs measured over the SAME hours (where
    CAMS also exists), so the two are comparable; CAMS over all its own hours is `cams_own`."""
    sim, obs, cams = (np.asarray(a, float) for a in (sim, obs, cams))
    cams_common = np.where(np.isfinite(sim), cams, np.nan)
    return {
        "model": metrics(sim, obs), "cams": metrics(cams_common, obs),
        "cams_own": metrics(cams, obs),
        "mean_sim": _mean_paired(sim, obs), "mean_measured": _mean_paired(obs, sim),
        "mean_cams": _mean_paired(cams_common, obs),
        "mean_measured_cams": _mean_paired(obs, cams_common),
        "hours_measured": int(np.isfinite(obs).sum()),
        "split": {"model": bias_split(sim, obs, start),
                  "cams": bias_split(cams_common, obs, start)},
    }


def _r_stats(rows: list[dict]) -> dict:
    """Per-city correlation summary over the cities of a pool (cities with r for both)."""
    both = [r for r in rows if r["model"]["r"] is not None and r["cams"]["r"] is not None]
    out = {"cities": len(both),
           "model_r_gt_cams_r": sum(r["model"]["r"] > r["cams"]["r"] for r in both)}
    for src in ("model", "cams"):
        rs = np.array([r[src]["r"] for r in both], float)
        out[src] = ({"median": _f(np.median(rs)), "mean": _f(rs.mean()), "min": _f(rs.min()),
                     "max": _f(rs.max())} if len(rs) else
                    {"median": None, "mean": None, "min": None, "max": None})
    return out


def measured_gaps(data: dict[str, dict], start: datetime) -> dict:
    """Which measured hours are missing in every city, and whether each city's set is the same."""
    sets = {cid: frozenset(np.flatnonzero(~np.isfinite(np.asarray(d["obs"], float))).tolist())
            for cid, d in data.items()}
    if not sets:
        return {"common": [], "identical": True, "extra": {}}
    common = frozenset.intersection(*sets.values())
    return {
        "common": [(start + timedelta(hours=h)).isoformat() for h in sorted(common)],
        "identical": len(set(sets.values())) == 1,
        "extra": {cid: len(v - common) for cid, v in sets.items() if v - common},
    }


def build_report(data: dict[str, dict], start: datetime, hours: int,
                 pools: dict[str, list[str]]) -> dict:
    """Per-city and pooled rows from {city_id: {sim, obs, cams, stations}} arrays of `hours`.
    Pooled rows concatenate the cities' hours (so NMB is a ratio of sums over all pairs, and r
    is a correlation across all city-hours, which includes differences between cities); their
    `r_per_city` summarises the cities' own correlations."""
    names = {c.id: c.name for c in CITIES}
    cities = []
    for cid, d in data.items():
        row = _row(d["sim"], d["obs"], d["cams"], start)
        cities.append({"id": cid, "name": names.get(cid, cid), "stations": d["stations"], **row})
    by_id = {r["id"]: r for r in cities}
    pooled = []
    for pid, ids in pools.items():
        cat = {k: np.concatenate([np.asarray(data[c][k], float) for c in ids])
               for k in ("sim", "obs", "cams")}
        row = _row(cat["sim"], cat["obs"], cat["cams"], start)
        row["split"] = {
            src: {part: _pool_split([data[c] for c in ids], src, part, start)
                  for part in ("day", "night")}
            for src in ("model", "cams")
        }
        row["r_per_city"] = _r_stats([by_id[c] for c in ids])
        pooled.append({"id": pid, "name": POOL_NAMES.get(pid, pid), "cities": list(ids), **row})
    return {
        "episode": {"start": start.isoformat(), "hours": hours,
                    "end": (start + timedelta(hours=hours - 1)).isoformat()},
        "min_n": MIN_N, "no_fit": NO_FIT, "cities": cities, "pooled": pooled,
        "measured_gaps": measured_gaps(data, start),
    }


def _pool_split(rows: list[dict], src: str, part: str, start: datetime) -> dict:
    sims, obss = [], []
    for d in rows:
        day, night = day_night_masks(start, len(d["obs"]))
        mask = day if part == "day" else night
        sim = np.asarray(d["sim"], float)
        val = sim if src == "model" else np.where(np.isfinite(sim), np.asarray(d["cams"], float),
                                                  np.nan)
        sims.append(np.where(mask, val, np.nan))
        obss.append(np.asarray(d["obs"], float))
    m = metrics(np.concatenate(sims), np.concatenate(obss))
    return {"n": m["n"], "bias": m["bias"], "nmb": m["nmb"]}


def constants_hash(snapshot: dict) -> str:
    return hashlib.sha256(json.dumps(snapshot, sort_keys=True).encode()).hexdigest()


def provenance(runs: list[dict], generated: datetime | None = None) -> dict:
    from vayu.sim.run import FORMAT_VERSION, constants_snapshot
    return {
        "generated_at": (generated or datetime.now(UTC)).isoformat(timespec="seconds"),
        "format_version": FORMAT_VERSION,
        "constants_sha256": constants_hash(constants_snapshot()),
        "runs": runs,
        "weights": "default: every source weight 1, fire scaling 1, fires continue",
    }


# --- markdown ---

def _num(v, fmt="{:.0f}") -> str:
    return "–" if v is None else fmt.format(v)


def _metric_cells(m: dict) -> list[str]:
    return [str(m["n"]), _num(m["r"], "{:.2f}"), _num(m["bias"], "{:+.0f}"),
            _num(m["nmb"], "{:+.2f}"), _num(m["rmse"]), _num(m["fac2"], "{:.2f}")]


def _table(rows: list[dict]) -> list[str]:
    head = ("| City | stations | mean measured | mean sim | n | r | bias | NMB | RMSE | FAC2 "
            "| CAMS mean | CAMS n | CAMS r | CAMS bias | CAMS NMB | CAMS RMSE | CAMS FAC2 |")
    lines = [head, "|" + "---|" * (head.count("|") - 1)]
    for r in rows:
        cells = [r["name"], str(r.get("stations", "")), _num(r["mean_measured"]),
                 _num(r["mean_sim"]), *_metric_cells(r["model"]), _num(r["mean_cams"]),
                 *_metric_cells(r["cams"])]
        lines.append("| " + " | ".join(cells) + " |")
    return lines


def _split_table(rows: list[dict]) -> list[str]:
    lines = [("| City | day n | day bias | day NMB | night n | night bias | night NMB "
             "| CAMS day bias | CAMS night bias |"), "|" + "---|" * 9]
    for r in rows:
        m, c = r["split"]["model"], r["split"]["cams"]
        lines.append("| " + " | ".join([
            r["name"], str(m["day"]["n"]), _num(m["day"]["bias"], "{:+.0f}"),
            _num(m["day"]["nmb"], "{:+.2f}"), str(m["night"]["n"]),
            _num(m["night"]["bias"], "{:+.0f}"), _num(m["night"]["nmb"], "{:+.2f}"),
            _num(c["day"]["bias"], "{:+.0f}"), _num(c["night"]["bias"], "{:+.0f}")]) + " |")
    return lines


def reading(report: dict) -> list[str]:
    """Plain statements derived from the numbers (no judgement words)."""
    out = []
    pooled = {p["id"]: p for p in report["pooled"]}
    rows = [r for r in report["cities"] if r["model"]["nmb"] is not None]
    low = [r["name"] for r in rows if r["model"]["nmb"] < 0]
    high = [r["name"] for r in rows if r["model"]["nmb"] > 0]
    if rows:
        out.append(f"- Over the episode the simulated mean is below the measured mean in "
                   f"{len(low)} of {len(rows)} cities with enough paired hours and above it in "
                   f"{len(high)}" + (f" ({', '.join(high)})." if high else "."))
    for pid in ("all", "ncr"):
        p = pooled.get(pid)
        if p is None or p["model"]["n"] < MIN_N:
            continue
        m, c, rs = p["model"], p["cams"], p["r_per_city"]
        out.append(
            f"- {p['name']}: mean measured {_num(p['mean_measured'])} µg/m³, mean simulated "
            f"{_num(p['mean_sim'])} µg/m³, CAMS {_num(p['mean_cams'])} µg/m³ over the same "
            f"hours. NMB {_num(m['nmb'], '{:+.2f}')} for the model and "
            f"{_num(c['nmb'], '{:+.2f}')} for CAMS; {_pct(m['fac2'])} of the model's hours and "
            f"{_pct(c['fac2'])} of CAMS's are within a factor of two of the measurement.")
        out.append(
            f"- {p['name']}, correlation: the pooled r ({_num(m['r'], '{:.2f}')} model, "
            f"{_num(c['r'], '{:.2f}')} CAMS) is a correlation across all city-hours and includes "
            f"differences between cities; it is not hour-to-hour agreement. Within cities the "
            f"median r is {_num(rs['model']['median'], '{:.2f}')} for the model and "
            f"{_num(rs['cams']['median'], '{:.2f}')} for CAMS (model range "
            f"{_num(rs['model']['min'], '{:.2f}')} to {_num(rs['model']['max'], '{:.2f}')}). "
            f"The model's r exceeds CAMS's in {rs['model_r_gt_cams_r']} of {rs['cities']} "
            f"cities. With autocorrelated hourly data a small difference in r is not a ranking.")
        sm = p["split"]["model"]
        if sm["day"]["bias"] is not None and sm["night"]["bias"] is not None:
            out.append(f"- {p['name']}, by time of day: mean bias {sm['day']['bias']:+.0f} µg/m³ "
                       f"in daytime hours (10:00-17:59 IST) and {sm['night']['bias']:+.0f} µg/m³ "
                       f"at night (22:00-05:59 IST).")
    both = [r for r in rows if r["cams"]["nmb"] is not None]
    if both:
        closer = sum(abs(r["model"]["nmb"]) < abs(r["cams"]["nmb"]) for r in both)
        out.append(f"- The model's |NMB| is smaller than CAMS's in {closer} of {len(both)} "
                   f"cities.")
    return out


def _pct(v) -> str:
    return "–" if v is None else f"{v:.0%}"


def _gap_lines(report: dict) -> list[str]:
    g = report.get("measured_gaps")
    if not g:
        return []
    names = {r["id"]: r["name"] for r in report["cities"]}
    hours = ", ".join(h[5:13].replace("T", " ") + "Z" for h in g["common"])
    out = [f"- {len(g['common'])} measured hours are missing in every city"
           + (f": {hours}." if g["common"] else ".")]
    if g["identical"]:
        out.append("- Every city's set of missing hours is exactly this set (checked for all "
                   "cities).")
    else:
        extra = ", ".join(f"{names.get(k, k)} {v}" for k, v in g["extra"].items())
        out.append(f"- Some cities miss further hours of their own: {extra}.")
    out.append("- Hours missing in every city point at the CPCB feed or its ingestion into "
               "OpenAQ rather than single monitors. Missing hours are left missing, never filled.")
    return out


def _r_table(rows: list[dict]) -> list[str]:
    lines = [("| Pool | pooled r, model | per-city r, model: median / mean (range) | pooled r, CAMS "
             "| per-city r, CAMS: median / mean (range) | cities where model r > CAMS r |"),
             "|" + "---|" * 6]
    for p in rows:
        rs = p["r_per_city"]

        def summary(src, rs=rs):
            d = rs[src]
            return (f"{_num(d['median'], '{:.2f}')} / {_num(d['mean'], '{:.2f}')} "
                    f"({_num(d['min'], '{:.2f}')} to {_num(d['max'], '{:.2f}')})")
        lines.append("| " + " | ".join([
            p["name"], _num(p["model"]["r"], "{:.2f}"), summary("model"),
            _num(p["cams"]["r"], "{:.2f}"), summary("cams"),
            f"{rs['model_r_gt_cams_r']} of {rs['cities']}"]) + " |")
    return lines


def render_markdown(report: dict) -> str:
    ep = report["episode"]
    runs = report.get("runs", [])
    lines = [
        f"# Validation: northern India, {ep['start'][:10]} to {ep['end'][:10]}",
        "",
        (f"Generated {report.get('generated_at', '?')} by `python -m vayu.validate`. "
        f"Run format version {report.get('format_version', '?')}, constants snapshot SHA-256 "
        f"`{report.get('constants_sha256', '?')}`."),
        "",
        (f"**{NO_FIT}** One global parameter set is used for every city and date; nothing was "
        "changed in response to these numbers."),
        "",
        "## Method",
        "",
        ("- **Simulated**: hour-mean dry PM2.5 that the model attributes to directly emitted "
        "sources (EDGAR v8.1 sectors in India; an ESTIMATED road and construction dust source "
        "in India, spread from TERI 2016 national totals; satellite-detected fires anywhere in the model "
        "domain, 66-98°E, 6-38°N, including Pakistan, Nepal and Bangladesh), the value the app "
        "shows for a "
        "city: the mean over the 3 x 3 block of 0.1 degree cells around it (about 30 km), summed "
        "over all source tags at default weights (every weight 1, fire scaling 1, fires "
        "continue). An hour is missing if any tag is missing there."),
        ("- **Measured**: CPCB PM2.5 via OpenAQ, the median over up to 5 stations within 25 km. "
        "CPCB hour averages run on the Indian clock (HH:30 UTC); each UTC hour is the "
        "overlap-weighted mean of the two periods it straddles, missing if either is missing. "
        "Nothing is interpolated."),
        ("- **CAMS**: Copernicus Atmosphere Monitoring Service PM2.5 from the Open-Meteo "
        "air-quality API at the city point, shown as a reference model that does include "
        "secondary aerosol and transport from outside India. CAMS values are instantaneous at "
        "HH:00 UTC, while model and CPCB values are means over [HH:00, HH+1:00) UTC: about a "
        "30-minute offset."),
        (f"- **Metrics** over hours where both series exist: n, Pearson r, mean bias "
        f"(simulated minus measured, µg/m³), NMB = Σ(sim − obs) / Σ obs, RMSE (µg/m³), FAC2 = "
        f"share of hours with 0.5 ≤ sim/obs ≤ 2 (obs > 0). Fields are \"–\" when n < {MIN_N}. "
        "Mean measured and mean simulated are over the same paired hours. CAMS is compared "
        "over the SAME hours as the model (hours where simulated, measured and CAMS values all "
        "exist), so the two rows are comparable. Pooled rows concatenate the cities' paired "
        "hours: pooled NMB is a ratio of sums, and pooled r is a correlation across all "
        "city-hours, which includes differences between cities, so it is not hour-to-hour "
        "agreement; the median per-city r describes that."),
        ("- **Day and night**: hours (UTC [t, t+1)) starting 10:00-17:59 IST are day, 22:00-05:59 "
        "IST night; other hours are in neither."),
        ("- **Hours and runs**: every UTC hour of the episode is used once. Whole 6-day blocks "
        "come from the run whose 144-hour window starts on the block's first day (run date = "
        "block start + 2 days); a shorter final block comes from the run whose window ends on the "
        "episode's last day. Each run includes 48 hours of spin-up before its window."),
        ("- **Not simulated**: secondary aerosol (nitrate, sulphate, secondary organics), "
        "anthropogenic inventory emissions outside India (vehicles, industry, residential, for "
        "example in Pakistani Punjab; fires there ARE simulated and appear under \"other states "
        "and neighbouring countries\", with the generic vegetation emission factor, not the "
        "crop-residue one, a known approximation for crop-residue fires in Pakistani Punjab), "
        "road and construction dust "
        "(no gridded inventory), vertical structure (one mixed layer), chemistry; emissions are "
        "annual means with no daily or seasonal cycle. Low readings are expected from these "
        "omissions. Possible causes of other errors include errors in transport, mixing height "
        "or the placement of emissions; this report does not separate them."),
        "",
        "Runs used:",
        "",
    ]
    for r in runs:
        lines.append(f"- {r['date']}: build `{r['build_id']}` (made {r['made_at']}), hours "
                     f"{r['first_hour']} to {r['last_hour']} UTC")
    lines += ["", "## Pooled", "", *_table(report["pooled"]), "",
              ("Pooled r is a correlation across all city-hours and includes differences between "
              "cities; the per-city r summaries describe agreement from hour to hour."), "",
              *_r_table(report["pooled"]), "",
              "## Per city", "", *_table(report["cities"]), "",
              "## Bias by time of day", "", *_split_table(report["pooled"] + report["cities"]),
              "", "## Reading", "", *reading(report)]
    missing = report.get("missing", [])
    gaps = _gap_lines(report)
    if missing or gaps:
        lines += ["", "## Missing", "", *gaps, *[f"- {m}" for m in missing]]
    return "\n".join(lines) + "\n"


# --- data collection (network and runs) ---

def _with_retries(what: str, fn: Callable, attempts: int = 4, wait_s: float = 60.0):
    for i in range(attempts):
        try:
            return fn()
        except UpstreamError as exc:
            if i == attempts - 1:
                raise
            print(f"  {what}: {exc}; retrying in {wait_s:.0f} s", file=sys.stderr)
            time.sleep(wait_s)


def run_offset(run, first: datetime, n: int) -> int:
    """Index in `run` of the hour starting at `first`, checking that `n` hours from there lie in
    the run's window and are all observed: validation never uses forecast hours or hours with
    assumed (persistence) fires."""
    off = int((first - run.start) / timedelta(hours=1))
    if off < 0 or off + n > run.hours:
        raise ValueError(f"hours {first:%Y-%m-%d %H}Z +{n} h lie outside run {run.run_id} "
                         f"({run.start:%Y-%m-%d %H}Z +{run.hours} h)")
    for name in ("forecast_from", "fires_assumed_from"):
        limit = getattr(run, name)
        if limit is not None and off + n > limit:
            raise ValueError(f"run {run.run_id} has {name}={limit}: hours {off}..{off + n - 1} "
                             f"are not all observed; validation covers observed periods only")
    return off


def _sim_for_run(run) -> dict[str, list]:
    """The API's per-city series for a run (built and stored on first use): exactly the city
    values the UI composes."""
    from vayu import api
    return api._extras(api._S.build_for(run))["cities"]


def collect(first: date, last: date, now: datetime, cities: list[City],
            pollutant: str = "pm25") -> tuple[dict, list, list]:
    from vayu.clients.openaq import city_pm25
    from vayu.clients.openmeteo import fetch_cams_pm25
    from vayu.sim.run import run_date

    start = datetime.combine(first, datetime.min.time(), tzinfo=UTC)
    hours = ((last - first).days + 1) * 24
    extra = {} if pollutant == "pm25" else {"parameter": pollutant}
    cams_extra = {} if pollutant == "pm25" else {"pollutant": pollutant}
    sim = {c.id: np.full(hours, np.nan) for c in cities}
    runs, missing = [], []
    for run_day, seg_start, n in segments(first, last):
        print(f"run {run_day} (hours from {seg_start:%Y-%m-%d %H}Z, {n} h)", file=sys.stderr)
        run = _with_retries(f"run {run_day}", lambda d=run_day: run_date(
            d, now, lambda f, s: print(f"  {f:4.0%} {s}", file=sys.stderr)))
        series = _sim_for_run(run)
        off = run_offset(run, seg_start, n)
        at = int((seg_start - start) / timedelta(hours=1))
        for c in cities:
            total = simulated_total(series[c.id]["by_tag"], run.hours, pollutant)
            sim[c.id][at:at + n] = total[off:off + n]
        runs.append({"date": run_day.isoformat(), "build_id": run.run_id,
                     "made_at": run.made_at.isoformat() if run.made_at else None,
                     "first_hour": seg_start.isoformat(),
                     "last_hour": (seg_start + timedelta(hours=n - 1)).isoformat()})
    data = {}
    for c in cities:
        print(f"measured + CAMS: {c.name}", file=sys.stderr)
        try:
            m = _with_retries(f"OpenAQ {c.name}", lambda c=c: city_pm25(c, start, hours, now=now, **extra))
            obs, stations = np.asarray(m.values, float), m.station_count
        except UpstreamError as exc:
            obs, stations = np.full(hours, np.nan), 0
            missing.append(f"{c.name}: measured data not fetched ({exc})")
        try:
            cams = np.asarray(_with_retries(
                f"CAMS {c.name}", lambda c=c: fetch_cams_pm25(c.lat, c.lon, start, hours, **cams_extra)),
                float)
        except UpstreamError as exc:
            cams = np.full(hours, np.nan)
            missing.append(f"{c.name}: CAMS not fetched ({exc})")
        n_obs = int(np.isfinite(obs).sum())
        if n_obs < hours:
            missing.append(f"{c.name}: {hours - n_obs} of {hours} hours without a measured value")
        data[c.id] = {"sim": sim[c.id], "obs": obs, "cams": cams, "stations": stations}
    return data, runs, missing


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("first", type=date.fromisoformat)
    parser.add_argument("last", type=date.fromisoformat)
    parser.add_argument("--pollutant", choices=("pm25", "pm10"), default="pm25")
    args = parser.parse_args(argv)
    if args.last < args.first:
        parser.error("last must not be before first")
    now = datetime.now(UTC)
    cities = list(CITIES[:N_NORTHERN])
    data, runs, missing = collect(args.first, args.last, now, cities, args.pollutant)
    start = datetime.combine(args.first, datetime.min.time(), tzinfo=UTC)
    hours = ((args.last - args.first).days + 1) * 24
    report = build_report(data, start, hours,
                          pools={"all": [c.id for c in cities], "ncr": list(NCR)})
    report.update(provenance(runs))
    report["missing"] = missing
    report["pollutant"] = args.pollutant
    suffix = "" if args.pollutant == "pm25" else f"-{args.pollutant}"
    out_json = config.data_dir() / f"validation{suffix}.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    from vayu.api import clean
    out_json.write_text(json.dumps(clean(report), allow_nan=False, indent=1))
    out_md = REPO_ROOT / "docs" / "validation" / f"{args.first:%Y-%m}{suffix}.md"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    text = render_markdown(report)
    if args.pollutant == "pm10":
        text = text.replace("PM2.5", "PM10") + f"\n## PM10 caveat\n\n{PM10_NOTE}\n"
    out_md.write_text(text)
    print(f"wrote {out_json} and {out_md}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
