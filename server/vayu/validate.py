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


def simulated_total(by_tag: dict[str, list], hours: int) -> np.ndarray:
    """Sum over tags of a city's series (lists with None for missing), NaN where any is None.
    Tags absent from `by_tag` are all-zero series (the API omits those)."""
    total = np.zeros(hours)
    for values in by_tag.values():
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
    model = metrics(sim, obs)
    return {
        "model": model, "cams": metrics(cams, obs),
        "mean_sim": _mean_paired(sim, obs), "mean_measured": _mean_paired(obs, sim),
        "mean_cams": _mean_paired(cams, obs), "mean_measured_cams": _mean_paired(obs, cams),
        "hours_measured": int(np.isfinite(np.asarray(obs, float)).sum()),
        "split": {"model": bias_split(sim, obs, start), "cams": bias_split(cams, obs, start)},
    }


def build_report(data: dict[str, dict], start: datetime, hours: int,
                 pools: dict[str, list[str]]) -> dict:
    """Per-city and pooled rows from {city_id: {sim, obs, cams, stations}} arrays of `hours`.
    Pooled rows concatenate the cities' hours (so NMB is a ratio of sums over all pairs)."""
    names = {c.id: c.name for c in CITIES}
    cities = []
    for cid, d in data.items():
        row = _row(d["sim"], d["obs"], d["cams"], start)
        cities.append({"id": cid, "name": names.get(cid, cid), "stations": d["stations"], **row})
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
        pooled.append({"id": pid, "name": POOL_NAMES.get(pid, pid), "cities": list(ids), **row})
    return {
        "episode": {"start": start.isoformat(), "hours": hours,
                    "end": (start + timedelta(hours=hours - 1)).isoformat()},
        "min_n": MIN_N, "no_fit": NO_FIT, "cities": cities, "pooled": pooled,
    }


def _pool_split(rows: list[dict], src: str, part: str, start: datetime) -> dict:
    sims, obss = [], []
    for d in rows:
        day, night = day_night_masks(start, len(d["obs"]))
        mask = day if part == "day" else night
        sims.append(np.where(mask, np.asarray(d["sim" if src == "model" else "cams"], float),
                             np.nan))
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
        m, c = p["model"], p["cams"]
        line = (f"- {p['name']}: mean measured {_num(p['mean_measured'])} µg/m³, mean simulated "
                f"{_num(p['mean_sim'])} µg/m³ (NMB {_num(m['nmb'], '{:+.2f}')}, r "
                f"{_num(m['r'], '{:.2f}')}")
        if m["r"] is not None:
            line += f", r² {m['r'] ** 2:.2f}: the share of hourly variance a linear fit would explain"
        line += (f"; {_num(m['fac2'], '{:.0%}') if m['fac2'] is not None else '–'} of hours within "
                 f"a factor of two). CAMS: NMB {_num(c['nmb'], '{:+.2f}')}, r "
                 f"{_num(c['r'], '{:.2f}')}, FAC2 {_num(c['fac2'], '{:.2f}')}.")
        out.append(line)
        sm = p["split"]["model"]
        if sm["day"]["bias"] is not None and sm["night"]["bias"] is not None:
            out.append(f"- {p['name']}, by time of day: mean bias {sm['day']['bias']:+.0f} µg/m³ "
                       f"in daytime hours (10:00-17:59 IST) and {sm['night']['bias']:+.0f} µg/m³ "
                       f"at night (22:00-05:59 IST).")
    both = [r for r in rows if r["model"]["r"] is not None and r["cams"]["r"] is not None]
    if both:
        better_r = sum(r["model"]["r"] > r["cams"]["r"] for r in both)
        closer = sum(abs(r["model"]["nmb"]) < abs(r["cams"]["nmb"]) for r in both
                     if r["cams"]["nmb"] is not None)
        rs = [r["model"]["r"] for r in both]
        out.append(f"- Per-city r ranges from {min(rs):.2f} to {max(rs):.2f}. The model's r is "
                   f"higher than CAMS's in {better_r} of {len(both)} cities, and its |NMB| is "
                   f"smaller than CAMS's in {closer} of {len(both)}.")
    return out


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
        "sources (EDGAR v8.1 sectors in India, satellite fires), the value the app shows for a "
        "city: the mean over the 3 x 3 block of 0.1 degree cells around it (about 30 km), summed "
        "over all source tags at default weights (every weight 1, fire scaling 1, fires "
        "continue). An hour is missing if any tag is missing there."),
        ("- **Measured**: CPCB PM2.5 via OpenAQ, the median over up to 5 stations within 25 km. "
        "CPCB hour averages run on the Indian clock (HH:30 UTC); each UTC hour is the "
        "overlap-weighted mean of the two periods it straddles, missing if either is missing. "
        "Nothing is interpolated."),
        ("- **CAMS**: Copernicus Atmosphere Monitoring Service PM2.5 from the Open-Meteo "
        "air-quality API at the city point, shown as a reference model that does include "
        "secondary aerosol and transport from outside India."),
        (f"- **Metrics** over hours where both series exist: n, Pearson r, mean bias "
        f"(simulated minus measured, µg/m³), NMB = Σ(sim − obs) / Σ obs, RMSE (µg/m³), FAC2 = "
        f"share of hours with 0.5 ≤ sim/obs ≤ 2 (obs > 0). Fields are \"–\" when n < {MIN_N}. "
        "Mean measured and mean simulated are over the same paired hours (CAMS means over the "
        "CAMS pairs). Pooled rows concatenate the cities' paired hours."),
        ("- **Day and night**: hours (UTC [t, t+1)) starting 10:00-17:59 IST are day, 22:00-05:59 "
        "IST night; other hours are in neither."),
        ("- **Hours and runs**: every UTC hour of the episode is used once. Whole 6-day blocks "
        "come from the run whose 144-hour window starts on the block's first day (run date = "
        "block start + 2 days); a shorter final block comes from the run whose window ends on the "
        "episode's last day. Each run includes 48 hours of spin-up before its window."),
        ("- **Not simulated**: secondary aerosol (nitrate, sulphate, secondary organics), "
        "inflow from outside India (including Pakistani Punjab), road and construction dust "
        "(no gridded inventory), vertical structure (one mixed layer), chemistry; emissions are "
        "annual means with no daily or seasonal cycle. Low readings are expected from these "
        "omissions; high readings point at transport, mixing or emission placement."),
        "",
        "Runs used:",
        "",
    ]
    for r in runs:
        lines.append(f"- {r['date']}: build `{r['build_id']}` (made {r['made_at']}), hours "
                     f"{r['first_hour']} to {r['last_hour']} UTC")
    lines += ["", "## Pooled", "", *_table(report["pooled"]), "",
              "## Per city", "", *_table(report["cities"]), "",
              "## Bias by time of day", "", *_split_table(report["pooled"] + report["cities"]),
              "", "## Reading", "", *reading(report)]
    missing = report.get("missing", [])
    if missing:
        lines += ["", "## Missing", "", *[f"- {m}" for m in missing]]
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


def _sim_for_run(run) -> dict[str, list]:
    """The API's per-city series for a run (built and stored on first use): exactly the city
    values the UI composes."""
    from vayu import api
    return api._extras(api._S.build_for(run))["cities"]


def collect(first: date, last: date, now: datetime, cities: list[City]) -> tuple[dict, list, list]:
    from vayu.clients.openaq import city_pm25
    from vayu.clients.openmeteo import fetch_cams_pm25
    from vayu.sim.run import run_date

    start = datetime.combine(first, datetime.min.time(), tzinfo=UTC)
    hours = ((last - first).days + 1) * 24
    sim = {c.id: np.full(hours, np.nan) for c in cities}
    runs, missing = [], []
    for run_day, seg_start, n in segments(first, last):
        print(f"run {run_day} (hours from {seg_start:%Y-%m-%d %H}Z, {n} h)", file=sys.stderr)
        run = _with_retries(f"run {run_day}", lambda d=run_day: run_date(
            d, now, lambda f, s: print(f"  {f:4.0%} {s}", file=sys.stderr)))
        series = _sim_for_run(run)
        off = int((seg_start - run.start) / timedelta(hours=1))
        at = int((seg_start - start) / timedelta(hours=1))
        for c in cities:
            total = simulated_total(series[c.id]["by_tag"], run.hours)
            sim[c.id][at:at + n] = total[off:off + n]
        runs.append({"date": run_day.isoformat(), "build_id": run.run_id,
                     "made_at": run.made_at.isoformat() if run.made_at else None,
                     "first_hour": seg_start.isoformat(),
                     "last_hour": (seg_start + timedelta(hours=n - 1)).isoformat()})
    data = {}
    for c in cities:
        print(f"measured + CAMS: {c.name}", file=sys.stderr)
        try:
            m = _with_retries(f"OpenAQ {c.name}", lambda c=c: city_pm25(c, start, hours, now=now))
            obs, stations = np.asarray(m.values, float), m.station_count
        except UpstreamError as exc:
            obs, stations = np.full(hours, np.nan), 0
            missing.append(f"{c.name}: measured data not fetched ({exc})")
        try:
            cams = np.asarray(_with_retries(
                f"CAMS {c.name}", lambda c=c: fetch_cams_pm25(c.lat, c.lon, start, hours)), float)
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
    args = parser.parse_args(argv)
    if args.last < args.first:
        parser.error("last must not be before first")
    now = datetime.now(UTC)
    cities = list(CITIES[:N_NORTHERN])
    data, runs, missing = collect(args.first, args.last, now, cities)
    start = datetime.combine(args.first, datetime.min.time(), tzinfo=UTC)
    hours = ((args.last - args.first).days + 1) * 24
    report = build_report(data, start, hours,
                          pools={"all": [c.id for c in cities], "ncr": list(NCR)})
    report.update(provenance(runs))
    report["missing"] = missing
    out_json = config.data_dir() / "validation.json"
    out_json.parent.mkdir(parents=True, exist_ok=True)
    from vayu.api import clean
    out_json.write_text(json.dumps(clean(report), allow_nan=False, indent=1))
    out_md = REPO_ROOT / "docs" / "validation" / f"{args.first:%Y-%m}.md"
    out_md.parent.mkdir(parents=True, exist_ok=True)
    out_md.write_text(render_markdown(report))
    print(f"wrote {out_json} and {out_md}", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
