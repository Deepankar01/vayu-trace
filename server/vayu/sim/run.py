"""A full simulation run: release tagged parcels every hour, advance them, grid each hour to disk.

Time base. Met and emissions are indexed from `sim_start = start - spinup_h`: emission hour `k`
covers [sim_start + k, sim_start + k + 1) and met time `t` is hours since `sim_start`. Parcels
released during the spin-up are advanced, but frames are written only from `start` on. Output
frame `h` is the state at `start + h` hours (frame 0 is the state at the window start).

Within each hour `k`: grid the current state (if it is an output hour), release hour `k`'s
emissions at time `k`, then take 3600 / DT_S transport steps.

Linearity. One `np.random.Generator` drives everything, and the random stream never depends on
emission magnitudes: each non-zero tag-hour draws exactly `particles_per_tag_hour` parcels with
normalised (scale-invariant) cell probabilities. Parcel survival depends only on met, domain and
depletion relative to release mass. Scaling every emission by a power of two therefore gives the
same trajectories and fields scaled by exactly that factor, which is what lets the browser
rescale sources.
"""
import json
import math
import os
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np

from vayu import config
from vayu.clients.openmeteo import fetch_met
from vayu.constants import DT_S, HAZE_GROWTH_COEFF, HAZE_RH_CAP
from vayu.domain import (
    CELL,
    LAT_MIN,
    LON_MIN,
    NX,
    NY,
    TAGS,
    cell_area_m2,
    cell_center,
    cell_index,
    inside,
)
from vayu.emissions import Emissions
from vayu.emissions.fires import fire_emissions
from vayu.emissions.inventory import inventory_emissions
from vayu.met import MetField
from vayu.sim.particles import Particles, step
from vayu.terrain import elevation

WINDOW_H = 144  # output hours per run
SPINUP_H = 48  # hours simulated before the window so it starts with transported pollution
# Parcels released per emitting tag per hour. The plan's 200 took 128 s per run; lowered to 100 to
# stay under 90 s (timing in docs/data-notes.md, "Simulation run timing").
PARTICLES_PER_TAG_HOUR = 100

STEPS_PER_HOUR = 3600 // DT_S
NCELL = NY * NX
TAG_IDS = [t.id for t in TAGS]
_TAG_INDEX = {tid: i for i, tid in enumerate(TAG_IDS)}
_FIRE_TAGS = np.array([i for i, t in enumerate(TAGS) if t.kind in ("fire", "firefc")])

Progress = Callable[[float, str], None]


def _noop(fraction: float, stage: str) -> None:
    pass


# --- window ---

def run_window(day: date, now: datetime | None = None) -> tuple[datetime, int | None]:
    """(start, forecast_from) of the output window for `day`.

    Past day D: hours start at D-2 00:00 UTC; today (D == now's UTC date): at D-3 00:00 UTC.
    `forecast_from` is the index of the first output hour strictly later than `now`, or None if
    the whole window is in the past. `now` defaults to the current time; pass it explicitly
    wherever reproducibility matters. Future days are rejected.
    """
    now = datetime.now(UTC) if now is None else now
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    now = now.astimezone(UTC)
    today = now.date()
    if day > today:
        raise ValueError(f"{day} is in the future (today is {today} UTC)")
    back = 3 if day == today else 2
    start = datetime.combine(day - timedelta(days=back), time(0), tzinfo=UTC)
    first_later = math.floor((now - start) / timedelta(hours=1)) + 1
    return start, (first_later if first_later < WINDOW_H else None)


# --- per-hour fields ---

def haze_factor(rh: np.ndarray) -> np.ndarray:
    """Hygroscopic growth factor f(RH) = 1 + c RH^2 / (1 - RH), RH a fraction capped at
    HAZE_RH_CAP (see constants.py). NaN stays NaN."""
    rh = np.minimum(np.asarray(rh, dtype=float), HAZE_RH_CAP)
    return 1.0 + HAZE_GROWTH_COEFF * rh**2 / (1.0 - rh)


@lru_cache(maxsize=1)
def _cell_centres() -> tuple[np.ndarray, np.ndarray]:
    return np.meshgrid(*cell_center(np.arange(NX), np.arange(NY)))


def _weighted_median_by_cell(cell, value, weight, ncell: int) -> np.ndarray:
    """Per cell, the weighted (lower) median of `value`: the smallest value whose cumulative
    weight within its cell reaches half the cell's total. NaN for cells with no entries."""
    out = np.full(ncell, np.nan)
    if len(cell) == 0:
        return out
    order = np.lexsort((value, cell))
    c, v, w = cell[order], value[order], weight[order]
    starts = np.flatnonzero(np.r_[True, c[1:] != c[:-1]])
    ends = np.r_[starts[1:], len(c)] - 1
    cum = np.cumsum(w)
    before = cum[starts] - w[starts]  # cumulative weight before each group
    group = np.repeat(np.arange(len(starts)), np.diff(np.r_[starts, len(c)]))
    within = cum - before[group]
    total = within[ends]
    crossing = np.flatnonzero(within >= 0.5 * total[group])
    first_group, first = np.unique(group[crossing], return_index=True)
    out[c[starts[first_group]]] = v[crossing[first]]
    return out


def _grid(p: Particles, met, t_hours: float) -> dict[str, np.ndarray]:
    """Frame arrays for the current state: one float32 (NY, NX) field per emitting tag (µg/m³),
    plus haze factor, fire age (h) and the mask of cells where mixing height is missing."""
    lon_c, lat_c = _cell_centres()
    s = met.sample(lon_c, lat_c, t_hours)
    blh = np.asarray(s.blh, dtype=float)
    missing = np.isnan(blh)
    ix, iy = cell_index(p.lon, p.lat)
    ok = inside(ix, iy)
    cell = (iy * NX + ix)[ok]
    tag = p.tag[ok].astype(np.int64)
    mass_kg = p.mass_kg[ok].astype(np.float64)
    mass = np.bincount(tag * NCELL + cell, weights=mass_kg, minlength=len(TAGS) * NCELL)
    mass = mass.reshape(len(TAGS), NY, NX)
    volume_m3 = cell_area_m2()[:, None] * blh
    out = {}
    for i in np.flatnonzero(mass.reshape(len(TAGS), -1).any(axis=1)):
        out[TAG_IDS[i]] = (mass[i] * 1e9 / volume_m3).astype(np.float32)
    fire = np.isin(tag, _FIRE_TAGS)
    age_h = p.age_s[ok][fire].astype(np.float64) / 3600.0
    out["fire_age_h"] = _weighted_median_by_cell(
        cell[fire], age_h, mass_kg[fire], NCELL).reshape(NY, NX).astype(np.float32)
    out["haze"] = haze_factor(s.rh).astype(np.float32)
    out["missing"] = missing
    return out


# --- release ---

def _release(emissions: Emissions, active: list[int], k: int, met, elev, rng, n: int) -> Particles:
    """Parcels for emission hour `k`, released at time `k`: per emitting tag, `n` parcels in cells
    drawn with probability proportional to emission, uniform within the cell, equal mass."""
    cols = {"lon": [], "lat": [], "iy": [], "ix": [], "mass": [], "tag": []}
    for ti in active:
        iy, ix, kg = emissions.hour(TAG_IDS[ti], k)
        if kg.size == 0:
            continue
        if (kg < 0).any():
            raise ValueError(f"negative emission for {TAG_IDS[ti]} in hour {k}")
        total = kg.sum()
        pick = rng.choice(kg.size, size=n, p=kg / total)
        cols["lon"].append(LON_MIN + (ix[pick] + rng.random(n)) * CELL)
        cols["lat"].append(LAT_MIN + (iy[pick] + rng.random(n)) * CELL)
        cols["iy"].append(iy[pick])
        cols["ix"].append(ix[pick])
        cols["mass"].append(np.full(n, total / n, dtype=np.float32))
        cols["tag"].append(np.full(n, ti, dtype=np.int16))
    if not cols["lon"]:
        return Particles.empty()
    c = {k_: np.concatenate(v) for k_, v in cols.items()}
    blh = met.sample(c["lon"], c["lat"], k).blh
    z = np.maximum(elev[c["iy"], c["ix"]], 0.0) + 0.5 * blh
    m = len(c["lon"])
    return Particles(
        lon=c["lon"], lat=c["lat"], mass_kg=c["mass"], age_s=np.zeros(m, np.float32),
        z_m=z.astype(np.float32), tag=c["tag"], mass0_kg=c["mass"].copy(),
    )


# --- storage ---

def _frame_path(out_dir: Path, h: int) -> Path:
    return out_dir / f"frame_{h:03d}.npz"


def _write_atomic(path: Path, write: Callable) -> None:
    tmp = path.with_name(f"{path.name}.{os.getpid()}.tmp")
    with open(tmp, "wb") as f:
        write(f)
    os.replace(tmp, path)


@dataclass(frozen=True)
class RunResult:
    """A finished run on disk; frames are read lazily."""
    out_dir: Path
    start: datetime
    hours: int
    tags: list[str]
    forecast_from: int | None
    blh_estimated: bool
    step_stats: dict

    @classmethod
    def from_dir(cls, out_dir: Path) -> "RunResult | None":
        """The run in `out_dir`, or None unless it is complete (run.json says so and every
        frame file exists)."""
        try:
            meta = json.loads((out_dir / "run.json").read_text())
        except (FileNotFoundError, json.JSONDecodeError):
            return None
        if meta.get("complete") is not True:
            return None
        if not all(_frame_path(out_dir, h).is_file() for h in range(meta["hours"])):
            return None
        return cls(
            out_dir=out_dir, start=datetime.fromisoformat(meta["start"]), hours=meta["hours"],
            tags=list(meta["tags"]), forecast_from=meta["forecast_from"],
            blh_estimated=meta["blh_estimated"], step_stats=dict(meta["step_stats"]),
        )

    def _read(self, h: int, names: list[str]) -> dict[str, np.ndarray]:
        if not 0 <= h < self.hours:
            raise IndexError(f"hour {h} outside 0..{self.hours - 1}")
        with np.load(_frame_path(self.out_dir, h)) as z:
            return {n: z[n] for n in names if n in z.files}

    def frame(self, h: int) -> dict[str, np.ndarray]:
        """Dry PM2.5 (µg/m³) per tag, float32 (NY, NX); every tag present (non-emitting tags are
        zero), NaN where the mixing height is missing."""
        z = self._read(h, [*self.tags, "missing"])
        blank = np.where(z.pop("missing"), np.float32(np.nan), np.float32(0.0))
        return {t: z[t] if t in z else blank.copy() for t in self.tags}

    def haze(self, h: int) -> np.ndarray:
        """Hygroscopic growth factor f(RH) at cell centres (multiplies dry PM2.5 for "haze")."""
        return self._read(h, ["haze"])["haze"]

    def fire_age_h(self, h: int) -> np.ndarray:
        """Mass-weighted median age (hours) of fire parcels per cell; NaN where there are none."""
        return self._read(h, ["fire_age_h"])["fire_age_h"]


# --- simulation ---

def simulate(
    emissions: Emissions,
    met: MetField,
    elev: np.ndarray,
    start: datetime,
    hours: int,
    out_dir: Path,
    *,
    seed: int = 0,
    progress: Progress = _noop,
    spinup_h: int | None = None,
    particles_per_tag_hour: int | None = None,
    forecast_from: int | None = None,
) -> RunResult:
    """Run `spinup_h + hours` hours from `start - spinup_h` and write `hours` frames to `out_dir`.

    `emissions` and `met` are indexed from `start - spinup_h` (see the module docstring) and must
    cover `spinup_h + hours` hours. Defaults: spinup_h = SPINUP_H, particles_per_tag_hour =
    PARTICLES_PER_TAG_HOUR. Any earlier run in `out_dir` is invalidated first; run.json is
    written last, so an interrupted run is never loaded.
    """
    spinup_h = SPINUP_H if spinup_h is None else spinup_h
    n = PARTICLES_PER_TAG_HOUR if particles_per_tag_hour is None else particles_per_tag_hour
    total = spinup_h + hours
    if met.hours < total:
        raise ValueError(f"met covers {met.hours} h, run needs {total} h")
    unknown = sorted(set(emissions.tags) - set(TAG_IDS))
    if unknown:
        raise ValueError(f"unknown emission tags: {', '.join(unknown)}")
    active = sorted(_TAG_INDEX[t] for t in emissions.tags)

    out_dir = Path(out_dir)
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "run.json").unlink(missing_ok=True)
    for old in [*out_dir.glob("frame_*.npz"), *out_dir.glob("*.tmp")]:
        old.unlink()

    rng = np.random.default_rng(seed)
    p = Particles.empty()
    stats = {"left_domain": 0, "depleted": 0, "missing_met": 0}
    peak = 0
    for k in range(total):
        progress(0.98 * k / total, f"simulating hour {k + 1}/{total}")
        if k >= spinup_h:
            arrays = _grid(p, met, float(k))
            _write_atomic(_frame_path(out_dir, k - spinup_h),
                          lambda f, a=arrays: np.savez_compressed(f, **a))
        if k == total - 1:
            break
        p = Particles.concat([p, _release(emissions, active, k, met, elev, rng, n)])
        peak = max(peak, len(p))
        for i in range(STEPS_PER_HOUR):
            p, s = step(p, met, elev, k + i * DT_S / 3600.0, rng)
            for name in stats:
                stats[name] += getattr(s, name)

    progress(0.99, "writing")
    meta = {
        "start": start.isoformat(),
        "hours": hours,
        "forecast_from": forecast_from,
        "tags": TAG_IDS,
        "seed": seed,
        "spinup_h": spinup_h,
        "particles_per_tag_hour": n,
        "dt_s": DT_S,
        "blh_estimated": bool(met.blh_estimated),
        "step_stats": stats,
        "peak_parcels": peak,
        "complete": True,
    }
    _write_atomic(out_dir / "run.json", lambda f: f.write(json.dumps(meta, indent=1).encode()))
    progress(1.0, "done")
    result = RunResult.from_dir(out_dir)
    assert result is not None
    return result


def _run_dir(day: date) -> Path:
    return config.data_dir() / "runs" / day.isoformat()


def load_run(day: date) -> RunResult | None:
    """The complete stored run for `day`, or None."""
    return RunResult.from_dir(_run_dir(day))


def run_date(day: date, now: datetime, progress: Progress = _noop) -> RunResult:
    """The run for `day`: the stored one if complete, otherwise fetch inputs and simulate.

    Upstream errors propagate; a failed run leaves no complete marker behind.
    """
    cached = load_run(day)
    if cached is not None:
        progress(1.0, "cached")
        return cached
    start, forecast_from = run_window(day, now)
    sim_start = start - timedelta(hours=SPINUP_H)
    total = SPINUP_H + WINDOW_H
    progress(0.0, "fetching fires")
    emissions = fire_emissions(sim_start, total, now)
    emissions.merge(inventory_emissions())
    progress(0.05, "fetching weather")
    met = MetField(fetch_met(sim_start, total, now))
    progress(0.1, "terrain")
    elev = elevation()
    return simulate(
        emissions, met, elev, start, WINDOW_H, _run_dir(day),
        progress=lambda f, s: progress(1.0 if f >= 1.0 else 0.12 + 0.88 * f, s),
        spinup_h=SPINUP_H, particles_per_tag_hour=PARTICLES_PER_TAG_HOUR,
        forecast_from=forecast_from,
    )
