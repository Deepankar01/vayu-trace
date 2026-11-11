"""A full simulation run: release tagged parcels every hour, advance them, grid each hour to disk.

Time base. Met and emissions are indexed from `sim_start = start - spinup_h`: emission hour `k`
covers [sim_start + k, sim_start + k + 1) and met time `t` is hours since `sim_start`. Parcels
released during the spin-up are advanced, but frames are written only from `start` on.

Within each hour `k`: release hour `k`'s emissions at time `k`, then take 3600 / DT_S transport
steps. Output frame `h` is the hour MEAN over [start + h, start + h + 1) (CPCB's hourly average
convention), by the trapezoid rule over the seven states at k, k + 1/6, ..., k + 1: weight 1/2 on
the post-release state at the start, 1 on each of the five intermediate states, 1/2 on the state
after the sixth step, divided by 6. (A left-point average would overweight the fresh release, by
about dt / (2 tau) for a residence time tau.) The volume uses the mean of the
mixing height at the hour's start and end; the haze factor uses the mean relative humidity
likewise. Each tag's mass grid is smoothed with an age-dependent box kernel (constants.py,
KERNEL_*) before dividing by volume, conserving mass exactly.

Linearity. One `np.random.Generator` drives everything, and the random stream never depends on
emission magnitudes: each non-zero tag-hour draws a fixed number of parcels (a pure function of
the tag id) with normalised cell probabilities. Transport and survival depend only on met,
domain and the surviving fraction `frac`, never on mass. Scaling every emission by a factor
therefore gives the same trajectories, and fields scaled by that factor (exactly for powers of
two, within float32 rounding otherwise). That is what lets the browser rescale sources.

Storage. Each run lives in its own directory `runs/{date}/{run_id}/`, written into a temporary
sibling and renamed when complete, and never modified afterwards; `runs/{date}/current.json`
names the current run and is replaced atomically. A `RunResult` held across a rebuild keeps
reading its own frames. `load_run` follows the pointer and serves the run only while it is still
valid for the date (same constants, same window, final or fresh). Superseded run directories are
deleted once they are more than RETAIN_SUPERSEDED old.
"""
import hashlib
import json
import math
import os
import re
import shutil
import uuid
from collections.abc import Callable
from dataclasses import dataclass
from datetime import UTC, date, datetime, time, timedelta
from functools import lru_cache
from pathlib import Path

import numpy as np

from vayu import config, domain, receptors, terrain
from vayu import constants as C
from vayu.cities import CITIES
from vayu.clients import firms
from vayu.clients.openmeteo import ARCHIVE_FINAL_AFTER, fetch_met
from vayu.constants import DT_S, HAZE_GROWTH_COEFF, HAZE_RH_CAP, KERNEL_AGE_H, KERNEL_HALF_WIDTH
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
from vayu.emissions import Emissions, fires, inventory
from vayu.emissions.fires import fire_emissions
from vayu.emissions.inventory import inventory_emissions
from vayu.met import MetField
from vayu.sim import particles as particles_module
from vayu.sim.particles import Particles, step
from vayu.terrain import elevation

WINDOW_H = 144  # output hours per run
SPINUP_H = 48  # hours simulated before the window so it starts with transported pollution
# Parcels released per emitting tag per hour (see parcels_per_tag_hour). Design choices, not
# fitted. The default was lowered from the plan's 200 to bound run time; the four
# `*_rest_of_india` sector tags cover most of the country, so a parcel there would otherwise
# carry tens of µg/m³ in a city cell (sampling noise figures in docs/data-notes.md).
PARTICLES_PER_TAG_HOUR = 100
PARTICLES_REST_OF_INDIA = 400

# Bump FORMAT_VERSION for any code change that alters results without changing a constant in
# constants_snapshot (e.g. a new algorithm), so stored runs made by older code are not served.
FORMAT_VERSION = 3
# A run made this long after its window ended is final and never refreshed: the Open-Meteo
# archive's own finality lag (FIRMS settles after 7 days, so it is covered too).
FINAL_AFTER = ARCHIVE_FINAL_AFTER
FRESH_FOR = timedelta(hours=1)  # otherwise a run is served for this long after it was made
RETAIN_SUPERSEDED = timedelta(hours=2)  # readers may still hold a superseded run this long

STEPS_PER_HOUR = 3600 // DT_S
NCELL = NY * NX
NCLASS = len(KERNEL_HALF_WIDTH)  # age classes of the smoothing kernel
TAG_IDS = [t.id for t in TAGS]
_TAG_INDEX = {tid: i for i, tid in enumerate(TAG_IDS)}
_FIRE_TAGS = np.array([i for i, t in enumerate(TAGS) if t.kind in ("fire", "firefc")])

Progress = Callable[[float, str], None]


def _noop(fraction: float, stage: str) -> None:
    pass


def parcels_per_tag_hour(tag_id: str) -> int:
    """Parcels released per hour for an emitting tag: a fixed catalogue, never data-dependent."""
    tag = TAGS[_TAG_INDEX[tag_id]]
    if tag.kind == "sector" and tag.region == "rest_of_india":
        return PARTICLES_REST_OF_INDIA
    return PARTICLES_PER_TAG_HOUR


# --- window ---

def _utc(now: datetime) -> datetime:
    if now.tzinfo is None:
        raise ValueError("now must be timezone-aware")
    return now.astimezone(UTC)


def run_window(day: date, now: datetime) -> tuple[datetime, int | None]:
    """(start, forecast_from) of the output window for `day`.

    Past day D: hours start at D-2 00:00 UTC; today (D == now's UTC date): at D-3 00:00 UTC.
    `forecast_from` is the index of the first output hour strictly later than `now`, or None if
    the whole window is in the past. Future days are rejected.
    """
    now = _utc(now)
    today = now.date()
    if day > today:
        raise ValueError(f"{day} is in the future (today is {today} UTC)")
    back = 3 if day == today else 2
    start = datetime.combine(day - timedelta(days=back), time(0), tzinfo=UTC)
    first_later = math.floor((now - start) / timedelta(hours=1)) + 1
    return start, (first_later if first_later < WINDOW_H else None)


def fires_assumed_from(start: datetime, now: datetime, hours: int) -> int | None:
    """Index of the first output hour at or after 00:00 UTC of `now`'s day, from which fire
    emissions are persistence (`firefc_*`), or None if the window ends before then."""
    midnight = datetime.combine(_utc(now).date(), time(0), tzinfo=UTC)
    first = max(math.ceil((midnight - start) / timedelta(hours=1)), 0)
    return first if first < hours else None


def cities_digest() -> str:
    """SHA-256 of the city list (ids and coordinates): stored city series depend on it."""
    spec = [[c.id, c.lat, c.lon] for c in CITIES]
    return hashlib.sha256(json.dumps(spec).encode()).hexdigest()


def constants_snapshot(*, spinup_h: int | None = None,
                       particles: tuple[int, int] | None = None) -> dict:
    """Every setting that affects a run's results, read at call time (JSON-normalised).

    `spinup_h` and `particles` (default, rest_of_india parcels per tag-hour) record the values a
    run actually used when they differ from the module settings.
    """
    default_n, roi_n = particles or (PARTICLES_PER_TAG_HOUR, PARTICLES_REST_OF_INDIA)
    snap = {
        name: getattr(particles_module, name)
        for name in ("DT_S", "K_H_M2_S", "V_DEP_M_S", "WASHOUT_A", "WASHOUT_B", "Z_RELAX_S",
                     "MIN_MASS_FRACTION")
    }
    snap.update({
        name: getattr(C, name)
        for name in ("HAZE_GROWTH_COEFF", "HAZE_RH_CAP", "KERNEL_AGE_H", "KERNEL_HALF_WIDTH",
                     "FIRE_PEAK_HOUR_IST", "FIRE_SIGMA_H", "BIOMASS_KG_PER_MJ",
                     "EF_PM25_CROP_G_PER_KG", "EF_PM25_VEG_G_PER_KG", "CROP_STATES",
                     "FIRE_PROFILE_FLOOR", "WIND_BLEND_100M", "MET_STEP_DEG", "BLH_MIN_M",
                     "BLH_MAX_M", "BLH_NIGHT_BASE_M", "BLH_NIGHT_PER_MS", "BLH_DAY_BASE_M",
                     "BLH_DAY_PER_K", "BLH_PEAK_LOCAL_HOUR", "BLH_DAY_HALF_WIDTH_H")
    })
    snap.update({
        f"domain.{name}": getattr(domain, name)
        for name in ("LON_MIN", "LON_MAX", "LAT_MIN", "LAT_MAX", "CELL", "NX", "NY",
                     "NCR_CENTRE", "NCR_RADIUS_KM")
    })
    snap.update({
        f"firms.{name}": getattr(firms, name)
        for name in ("SATELLITES", "HISTORY_DAYS", "STATIC_MIN_DAYS", "STATIC_CELL_DEG")
    })
    snap.update({
        "fires.FORECAST_BASIS_DAYS": fires.FORECAST_BASIS_DAYS,
        "terrain.ZOOM": terrain.ZOOM,
        "terrain.TILE_URL": terrain.TILE_URL,
        "inventory.RELEASE": inventory.RELEASE,
        "inventory.YEAR": inventory.YEAR,
        "inventory.EDGAR_SECTORS": inventory.EDGAR_SECTORS,
        "inventory.notes": inventory.inventory_notes(),
        "SPINUP_H": SPINUP_H if spinup_h is None else spinup_h,
        "WINDOW_H": WINDOW_H,
        "PARTICLES_PER_TAG_HOUR": default_n,
        "PARTICLES_REST_OF_INDIA": roi_n,
        "cities.digest": cities_digest(),
        "receptors.RECEPTORS_VERSION": receptors.RECEPTORS_VERSION,
    })
    return json.loads(json.dumps(snap))


# --- per-hour fields ---

def haze_factor(rh: np.ndarray) -> np.ndarray:
    """Hygroscopic growth factor f(RH) = 1 + c RH^2 / (1 - RH), RH a fraction capped at
    HAZE_RH_CAP (see constants.py). NaN stays NaN."""
    rh = np.minimum(np.asarray(rh, dtype=float), HAZE_RH_CAP)
    return 1.0 + HAZE_GROWTH_COEFF * rh**2 / (1.0 - rh)


@lru_cache(maxsize=1)
def _cell_centres() -> tuple[np.ndarray, np.ndarray]:
    return np.meshgrid(*cell_center(np.arange(NX), np.arange(NY)))


def _box_counts(n: int, r: int) -> np.ndarray:
    """Per index, how many indices within +/- r lie inside 0..n-1."""
    i = np.arange(n)
    return np.minimum(i + r, n - 1) - np.maximum(i - r, 0) + 1


def _box_spread(mass: np.ndarray, r: int) -> np.ndarray:
    """Spread each cell's mass equally over the in-domain cells of the (2r+1)^2 box around it.

    Total mass is conserved (each source divides by its own in-domain box size). Uses padded
    slicing, not cumulative sums, so cells the kernel does not reach stay exactly zero.
    """
    if r == 0:
        return mass
    ny, nx = mass.shape
    w = mass / (_box_counts(ny, r)[:, None] * _box_counts(nx, r)[None, :])
    pad = np.pad(w, ((r, r), (0, 0)))
    rows = sum(pad[j:j + ny] for j in range(2 * r + 1))
    pad = np.pad(rows, ((0, 0), (r, r)))
    return sum(pad[:, j:j + nx] for j in range(2 * r + 1))


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


class _HourMean:
    """Accumulates parcel samples within one hour and turns them into frame arrays."""

    def __init__(self, active: list[int]):
        self.slot = np.full(len(TAGS), -1, dtype=np.int64)
        self.slot[active] = np.arange(len(active))
        self.active = active
        self.weight = 0.0
        self.idx, self.mass = [], []
        self.fire_cell, self.fire_age, self.fire_mass = [], [], []

    def add(self, p: Particles, weight: float) -> None:
        """Add one state with quadrature weight `weight` (applied to mass and fire age alike)."""
        self.weight += weight
        ix, iy = cell_index(p.lon, p.lat)
        ok = inside(ix, iy)
        cell = (iy * NX + ix)[ok]
        tag = p.tag[ok]
        mass = p.mass_kg[ok].astype(np.float64) * weight
        age_h = p.age_s[ok].astype(np.float64) / 3600.0
        age_class = np.searchsorted(KERNEL_AGE_H, age_h, side="right")
        self.idx.append((self.slot[tag] * NCLASS + age_class) * NCELL + cell)
        self.mass.append(mass)
        fire = np.isin(tag, _FIRE_TAGS)
        self.fire_cell.append(cell[fire])
        self.fire_age.append(age_h[fire])
        self.fire_mass.append(mass[fire])

    def frame(self, met, k: int) -> dict[str, np.ndarray]:
        """Hour-mean dry PM2.5 per emitting tag (µg/m³, float32), plus `haze`, `fire_age_h` and
        `missing` (cells whose mixing height is missing; every tag is NaN there)."""
        lon_c, lat_c = _cell_centres()
        s0, s1 = met.sample(lon_c, lat_c, float(k)), met.sample(lon_c, lat_c, float(k + 1))
        blh = 0.5 * (np.asarray(s0.blh, dtype=float) + np.asarray(s1.blh, dtype=float))
        rh = 0.5 * (np.asarray(s0.rh, dtype=float) + np.asarray(s1.rh, dtype=float))
        volume_m3 = cell_area_m2()[:, None] * blh

        n = len(self.active)
        mass = np.bincount(np.concatenate(self.idx), weights=np.concatenate(self.mass),
                           minlength=n * NCLASS * NCELL).reshape(n, NCLASS, NY, NX)
        out = {}
        for slot in np.flatnonzero(mass.reshape(n, -1).any(axis=1)):
            grid = sum(_box_spread(mass[slot, c], KERNEL_HALF_WIDTH[c]) for c in range(NCLASS))
            grid = grid / self.weight
            out[TAG_IDS[self.active[slot]]] = (grid * 1e9 / volume_m3).astype(np.float32)
        out["fire_age_h"] = _weighted_median_by_cell(
            np.concatenate(self.fire_cell), np.concatenate(self.fire_age),
            np.concatenate(self.fire_mass), NCELL,
        ).reshape(NY, NX).astype(np.float32)
        out["haze"] = haze_factor(rh).astype(np.float32)
        out["missing"] = np.isnan(blh)
        return out


# --- release ---

def _release(emissions: Emissions, budget: dict[int, int], k: int, met, elev, rng) -> Particles:
    """Parcels for emission hour `k`, released at time `k`: per emitting tag, `budget[tag]`
    parcels in cells drawn with probability proportional to emission, uniform within the cell,
    equal mass."""
    cols = {"lon": [], "lat": [], "iy": [], "ix": [], "mass": [], "tag": []}
    for ti, n in budget.items():
        iy, ix, kg = emissions.hour(TAG_IDS[ti], k)
        if kg.size == 0:
            continue
        if (kg < 0).any():
            raise ValueError(f"negative emission for {TAG_IDS[ti]} in hour {k}")
        total = kg.sum()
        if not total > 0:
            continue
        pick = rng.choice(kg.size, size=n, p=kg / total)
        cols["lon"].append(LON_MIN + (ix[pick] + rng.random(n)) * CELL)
        cols["lat"].append(LAT_MIN + (iy[pick] + rng.random(n)) * CELL)
        cols["iy"].append(iy[pick])
        cols["ix"].append(ix[pick])
        cols["mass"].append(np.full(n, total / n, dtype=np.float32))
        cols["tag"].append(np.full(n, ti, dtype=np.int16))
    if not cols["lon"]:
        return Particles.empty()
    c = {name: np.concatenate(v) for name, v in cols.items()}
    blh = met.sample(c["lon"], c["lat"], float(k)).blh
    z = np.maximum(elev[c["iy"], c["ix"]], 0.0) + 0.5 * blh
    return Particles.released(c["lon"], c["lat"], c["mass"], z, c["tag"])


# --- storage ---

def _frame_path(out_dir: Path, h: int) -> Path:
    return out_dir / f"frame_{h:03d}.npz"


def _write_atomic(path: Path, write: Callable) -> None:
    tmp = path.with_name(f"{path.name}.{uuid.uuid4().hex}.tmp")
    with open(tmp, "wb") as f:
        write(f)
    os.replace(tmp, path)


def _parse_time(value) -> datetime | None:
    return None if value is None else datetime.fromisoformat(value)


@dataclass(frozen=True)
class RunResult:
    """A finished run on disk; frames are read lazily. Frame `h` is the mean over
    [start + h, start + h + 1)."""
    out_dir: Path
    start: datetime
    hours: int
    tags: list[str]
    forecast_from: int | None
    fires_assumed_from: int | None
    blh_estimated: bool
    step_stats: dict
    made_at: datetime | None
    format_version: int
    constants: dict

    @property
    def run_id(self) -> str:
        return self.out_dir.name

    @classmethod
    def from_dir(cls, out_dir: Path) -> "RunResult | None":
        """The run in `out_dir`, or None unless run.json is readable, says `complete: true` and
        every frame file exists. Validity for a date is `load_run`'s job."""
        try:
            meta = json.loads((Path(out_dir) / "run.json").read_text())
            if meta.get("complete") is not True:
                return None
            result = cls(
                out_dir=Path(out_dir), start=datetime.fromisoformat(meta["start"]),
                hours=int(meta["hours"]), tags=list(meta["tags"]),
                forecast_from=meta["forecast_from"],
                fires_assumed_from=meta["fires_assumed_from"],
                blh_estimated=bool(meta["blh_estimated"]), step_stats=dict(meta["step_stats"]),
                made_at=_parse_time(meta["made_at"]), format_version=int(meta["format_version"]),
                constants=dict(meta["constants"]),
            )
        except (OSError, ValueError, KeyError, TypeError, AttributeError):
            return None
        if not all(_frame_path(result.out_dir, h).is_file() for h in range(result.hours)):
            return None
        return result

    def _read(self, h: int, names: list[str]) -> dict[str, np.ndarray]:
        if not 0 <= h < self.hours:
            raise IndexError(f"hour {h} outside 0..{self.hours - 1}")
        with np.load(_frame_path(self.out_dir, h)) as z:
            return {n: z[n] for n in names if n in z.files}

    def frame(self, h: int) -> dict[str, np.ndarray]:
        """Hour-mean dry PM2.5 (µg/m³) per tag, float32 (NY, NX); every tag present
        (non-emitting tags are zero), NaN where the mixing height is missing."""
        z = self._read(h, [*self.tags, "missing"])
        blank = np.where(z.pop("missing"), np.float32(np.nan), np.float32(0.0))
        return {t: z[t] if t in z else blank.copy() for t in self.tags}

    def haze(self, h: int) -> np.ndarray:
        """Hygroscopic growth factor f(RH) at cell centres (multiplies dry PM2.5 for "haze")."""
        return self._read(h, ["haze"])["haze"]

    def fire_age_h(self, h: int) -> np.ndarray:
        """Mass-weighted median age (hours) of fire parcels per cell over the hour's samples;
        NaN where there are none."""
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
    fires_assumed_from: int | None = None,
    made_at: datetime | None = None,
) -> RunResult:
    """Run `spinup_h + hours` hours from `start - spinup_h` and write `hours` frames to `out_dir`.

    `emissions` are indexed from `start - spinup_h` and must cover `spinup_h + hours` hours;
    `met` must cover one hour more (the last frame's volume uses the mixing height at its end).
    Defaults: spinup_h = SPINUP_H; parcels per tag-hour from `parcels_per_tag_hour`, or
    `particles_per_tag_hour` for every tag if given (tests; recorded as such in the constants
    snapshot). `out_dir` must not exist: the run is built in a temporary sibling directory and
    renamed to `out_dir` when complete, and is never modified afterwards.
    """
    spinup_h = SPINUP_H if spinup_h is None else spinup_h
    total = spinup_h + hours
    if met.hours < total + 1:
        raise ValueError(f"met covers {met.hours} h, run needs {total + 1} h")
    unknown = sorted(set(emissions.tags) - set(TAG_IDS))
    if unknown:
        raise ValueError(f"unknown emission tags: {', '.join(unknown)}")
    active = sorted(_TAG_INDEX[t] for t in emissions.tags)
    budget = {
        ti: particles_per_tag_hour if particles_per_tag_hour is not None
        else parcels_per_tag_hour(TAG_IDS[ti])
        for ti in active
    }
    used_particles = None if particles_per_tag_hour is None else (particles_per_tag_hour,) * 2

    out_dir = Path(out_dir)
    if out_dir.exists():
        raise FileExistsError(f"{out_dir} exists; run directories are never overwritten")
    out_dir.parent.mkdir(parents=True, exist_ok=True)
    work = out_dir.with_name(f".{out_dir.name}.tmp-{uuid.uuid4().hex}")
    work.mkdir()
    try:
        rng = np.random.default_rng(seed)
        p = Particles.empty()
        stats = {"left_domain": 0, "depleted": 0, "missing_met": 0}
        peak = 0
        for k in range(total):
            progress(0.97 * k / total, f"simulating hour {k + 1}/{total}")
            p = Particles.concat([p, _release(emissions, budget, k, met, elev, rng)])
            peak = max(peak, len(p))
            acc = _HourMean(active) if k >= spinup_h else None
            if acc is not None:
                acc.add(p, 0.5)  # trapezoid: half weight on the post-release state at k
            for i in range(STEPS_PER_HOUR):
                p, s = step(p, met, elev, k + i * DT_S / 3600.0, rng)
                for name in stats:
                    stats[name] += getattr(s, name)
                if acc is not None:
                    acc.add(p, 0.5 if i == STEPS_PER_HOUR - 1 else 1.0)
            if acc is not None:
                arrays = acc.frame(met, k)
                _write_atomic(_frame_path(work, k - spinup_h),
                              lambda f, a=arrays: np.savez_compressed(f, **a))

        progress(0.98, "writing")
        meta = {
            "format_version": FORMAT_VERSION,
            "start": start.isoformat(),
            "hours": hours,
            "frame_semantics": "hour_mean_trapezoid",
            "forecast_from": forecast_from,
            "fires_assumed_from": fires_assumed_from,
            "made_at": None if made_at is None else _utc(made_at).isoformat(),
            "tags": TAG_IDS,
            "seed": seed,
            "parcels_per_tag_hour": {TAG_IDS[ti]: n for ti, n in budget.items()},
            "constants": constants_snapshot(spinup_h=spinup_h, particles=used_particles),
            "blh_estimated": bool(met.blh_estimated),
            "step_stats": stats,
            "peak_parcels": peak,
            "complete": True,
        }
        _write_atomic(work / "run.json", lambda f: f.write(json.dumps(meta, indent=1).encode()))
        os.rename(work, out_dir)
    finally:
        if work.exists():
            shutil.rmtree(work, ignore_errors=True)
    progress(1.0, "done")
    result = RunResult.from_dir(out_dir)
    if result is None:
        raise RuntimeError(f"run written to {out_dir} could not be read back")
    return result


# --- stored runs: runs/{date}/{run_id}/ plus a current.json pointer ---

_POINTER = "current.json"
_RUN_ID = re.compile(r"\d{8}T\d{6}Z-[0-9a-f]{8}")


def _date_dir(day: date) -> Path:
    return config.data_dir() / "runs" / day.isoformat()


def _new_run_id(made_at: datetime) -> str:
    return f"{_utc(made_at):%Y%m%dT%H%M%SZ}-{uuid.uuid4().hex[:8]}"


def _run_id_time(name: str) -> datetime | None:
    """made_at encoded in a run directory name (also a `.{run_id}.tmp-...` build directory)."""
    try:
        return datetime.strptime(name.lstrip(".")[:16], "%Y%m%dT%H%M%SZ").replace(tzinfo=UTC)
    except ValueError:
        return None


def _current_run_id(day: date) -> str | None:
    try:
        pointer = json.loads((_date_dir(day) / _POINTER).read_text())
        run_id = pointer["run_id"]
    except (OSError, ValueError, KeyError, TypeError):
        return None
    return run_id if isinstance(run_id, str) and _RUN_ID.fullmatch(run_id) else None


def _set_current(day: date, run_id: str) -> None:
    _write_atomic(_date_dir(day) / _POINTER,
                  lambda f: f.write(json.dumps({"run_id": run_id}).encode()))


def _cleanup(day: date, now: datetime) -> None:
    """Delete run (and abandoned build) directories for `day` that are not current and were made
    more than RETAIN_SUPERSEDED before `now`. Unrecognised entries are left alone."""
    current = _current_run_id(day)
    for child in _date_dir(day).iterdir():
        made = _run_id_time(child.name)
        if (child.is_dir() and child.name != current and made is not None
                and _utc(now) - made > RETAIN_SUPERSEDED):
            shutil.rmtree(child, ignore_errors=True)


def load_run(day: date, now: datetime) -> RunResult | None:
    """The current stored run for `day` if it is still valid at `now`, else None (re-run).

    Valid means: the pointer names a complete run; same format version and constants snapshot
    as the current code; its tags all in the current catalogue; its start equals `run_window(day, now)`'s; and either it was final when
    made (made at least FINAL_AFTER after its window ended) or it was made less than FRESH_FOR
    before `now`.
    """
    run_id = _current_run_id(day)
    if run_id is None:
        return None
    res = RunResult.from_dir(_date_dir(day) / run_id)
    if res is None or res.made_at is None:
        return None
    if res.format_version != FORMAT_VERSION or res.constants != constants_snapshot():
        return None
    if not set(res.tags) <= set(TAG_IDS):
        return None
    if res.start != run_window(day, now)[0]:
        return None
    final = res.made_at >= res.start + timedelta(hours=res.hours) + FINAL_AFTER
    if not (final or _utc(now) - res.made_at < FRESH_FOR):
        return None
    return res


def run_date(day: date, now: datetime, progress: Progress = _noop) -> RunResult:
    """The run for `day`: the stored one if still valid (see `load_run`), otherwise fetch inputs,
    simulate into a new run directory and point `current.json` at it. Upstream errors
    propagate; a failed run leaves the stored state unchanged."""
    cached = load_run(day, now)
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
    met = MetField(fetch_met(sim_start, total + 1, now))
    progress(0.1, "terrain")
    elev = elevation()
    run_id = _new_run_id(now)
    result = simulate(
        emissions, met, elev, start, WINDOW_H, _date_dir(day) / run_id,
        progress=lambda f, s: progress(0.12 + 0.87 * f, s),
        spinup_h=SPINUP_H, forecast_from=forecast_from,
        fires_assumed_from=fires_assumed_from(start, now, WINDOW_H), made_at=now,
    )
    _set_current(day, run_id)
    _cleanup(day, now)
    progress(1.0, "done")
    return result
