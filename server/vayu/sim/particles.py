"""Lagrangian particles in a single well-mixed layer, and the transport time step.

Terrain blocking is "stay", not reflection: a parcel whose full, x-only and y-only moves are all
refused stays where it is for that step, and that step's turbulent displacement is discarded.
"""
from dataclasses import dataclass, fields

import numpy as np

from vayu.constants import (
    DT_S,
    EARTH_RADIUS_M,
    K_H_M2_S,
    V_DEP_M_S,
    WASHOUT_A,
    WASHOUT_B,
    Z_RELAX_S,
)
from vayu.domain import cell_index, inside
from vayu.met import MetField

DEG_PER_RAD = 180.0 / np.pi
MIN_MASS_FRACTION = 0.01  # parcels below this fraction of their release mass are dropped

_DTYPES = {
    "lon": np.float64, "lat": np.float64, "age_s": np.float32,
    "z_m": np.float32, "tag": np.int16, "mass0_kg": np.float32, "frac": np.float32,
}


@dataclass
class Particles:
    """Parcel state, one array element per parcel (all arrays the same length).

    lon, lat  degrees (float64: a 600 s move is a small fraction of a 0.1 degree cell)
    age_s     seconds since release
    z_m       parcel height above sea level, m (the centre of the mixed layer it travels in)
    tag       index into the emission-tag catalogue (int16)
    mass0_kg  PM2.5 mass at release
    frac      fraction of the release mass still airborne (1 at release); current mass is
              `mass_kg = mass0_kg * frac`. Transport and the depletion drop depend on `frac`
              only, never on the mass itself, so scaling emissions by any factor gives identical
              trajectories and survival.
    """
    lon: np.ndarray
    lat: np.ndarray
    age_s: np.ndarray
    z_m: np.ndarray
    tag: np.ndarray
    mass0_kg: np.ndarray
    frac: np.ndarray

    def __len__(self) -> int:
        return len(self.lon)

    @property
    def mass_kg(self) -> np.ndarray:
        """Current PM2.5 mass (float32), derived from release mass and surviving fraction."""
        return self.mass0_kg * self.frac

    @classmethod
    def released(cls, lon, lat, mass_kg, z_m, tag) -> "Particles":
        """Fresh parcels: age 0, full release mass."""
        n = len(lon)
        return cls(
            lon=np.asarray(lon, dtype=np.float64), lat=np.asarray(lat, dtype=np.float64),
            age_s=np.zeros(n, np.float32), z_m=np.asarray(z_m, dtype=np.float32),
            tag=np.asarray(tag, dtype=np.int16), mass0_kg=np.asarray(mass_kg, dtype=np.float32),
            frac=np.ones(n, np.float32),
        )

    @classmethod
    def empty(cls) -> "Particles":
        return cls(**{k: np.empty(0, dtype=t) for k, t in _DTYPES.items()})

    @classmethod
    def concat(cls, parts: list["Particles"]) -> "Particles":
        if not parts:
            return cls.empty()
        return cls(**{
            k: np.concatenate([getattr(p, k) for p in parts]).astype(t, copy=False)
            for k, t in _DTYPES.items()
        })

    def keep(self, mask: np.ndarray) -> "Particles":
        return Particles(**{f.name: getattr(self, f.name)[mask] for f in fields(self)})


@dataclass(frozen=True)
class StepStats:
    """Parcels dropped in one step, by reason. Each parcel is counted once: missing met is
    checked first, then leaving the domain, then depletion."""
    left_domain: int  # position after the move is outside the grid
    depleted: int  # surviving fraction below MIN_MASS_FRACTION
    missing_met: int  # met sample (u, v or blh) was NaN at the start position


def _ground(elev: np.ndarray, lon: np.ndarray, lat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """(terrain height >= 0 at the nearest cell, inside-domain mask). Outside cells read 0."""
    ix, iy = cell_index(lon, lat)
    ok = inside(ix, iy)
    h = elev[np.where(ok, iy, 0), np.where(ok, ix, 0)]
    return np.where(ok, np.maximum(h, 0.0), 0.0), ok


def step(
    p: Particles,
    met: MetField,
    elev: np.ndarray,
    t_hours: float,
    rng: np.random.Generator,
    *,
    deposition: bool = True,
) -> tuple[Particles, StepStats]:
    """Advance every parcel by DT_S seconds. Returns the surviving parcels and drop counts.

    1. Sample met at each parcel (time `t_hours`). Parcels whose u, v or blh is NaN cannot be
       advected and are dropped (StepStats.missing_met). NaN precipitation counts as no rain.
       Proposed move: dx = u*DT + N(0, sqrt(2*K_H*DT)), likewise dy; metres -> degrees at the
       parcel's current latitude.
    2. Blocking: a cell is impassable if its terrain exceeds the ceiling z_m + blh/2 (current
       z_m, blh at the start position). A candidate move is allowed only if both its destination
       cell and its midpoint cell are passable; the full (diagonal) move additionally needs the
       x-only or the y-only move to be allowed (no corner cutting). Candidates in order: full
       move, x-only, y-only, stay. A destination or midpoint outside the domain counts as
       passable (the parcel leaves and is dropped in 5). Terrain below 0 (sea) counts as 0.
       Moves up to two cells long are therefore checked against every cell they cross; only a
       single move longer than two cells can jump a one-cell ridge.
    3. z_m relaxes toward terrain(new position) + blh/2 with time constant Z_RELAX_S.
    4. If `deposition`: frac *= exp(-(V_DEP/blh + WASHOUT_A * precip**WASHOUT_B) * DT), with blh
       and precip from the start position; precip <= 0 gives no washout.
    5. age += DT. Drop parcels outside the domain or with frac below MIN_MASS_FRACTION.

    All randomness comes from `rng`. The diffusivity K_H_M2_S is read from this module at call
    time.

    Aliasing: the returned `Particles` may share arrays with the input `p` (always `tag` and
    `mass0_kg`; also `frac` when `deposition=False`; all fields can be shared when no parcel
    is dropped and a field is unchanged). Callers must not mutate either object's arrays in
    place.
    """
    s = met.sample(p.lon, p.lat, t_hours)
    usable = ~(np.isnan(s.u) | np.isnan(s.v) | np.isnan(s.blh))
    missing_met = int(len(p) - np.count_nonzero(usable))
    if missing_met:
        p = p.keep(usable)
        u, v, blh, precip = (x[usable] for x in (s.u, s.v, s.blh, s.precip_mm_h))
    else:
        u, v, blh, precip = s.u, s.v, s.blh, s.precip_mm_h
    n = len(p)

    # 1. Proposed move.
    sigma = np.sqrt(2.0 * K_H_M2_S * DT_S)
    noise = rng.standard_normal((2, n)) * sigma
    dx = u * DT_S + noise[0]
    dy = v * DT_S + noise[1]
    dlat = dy / EARTH_RADIUS_M * DEG_PER_RAD
    dlon = dx / (EARTH_RADIUS_M * np.cos(np.radians(p.lat))) * DEG_PER_RAD
    lon_new = p.lon + dlon
    lat_new = p.lat + dlat

    # 2. Terrain blocking.
    ceiling = p.z_m + 0.5 * blh
    h_here, in_here = _ground(elev, p.lon, p.lat)
    h_full, in_full = _ground(elev, lon_new, lat_new)
    h_x, in_x = _ground(elev, lon_new, p.lat)
    h_y, in_y = _ground(elev, p.lon, lat_new)
    lon_mid = p.lon + 0.5 * dlon
    lat_mid = p.lat + 0.5 * dlat

    def passable(h, ok):  # a cell outside the domain counts as passable
        return ~ok | (h <= ceiling)

    ok_x = passable(h_x, in_x) & passable(*_ground(elev, lon_mid, p.lat))
    ok_y = passable(h_y, in_y) & passable(*_ground(elev, p.lon, lat_mid))
    # The full (diagonal) move also needs one orthogonal neighbour on the way to be passable,
    # so a parcel cannot cut a corner through a diagonal one-cell ridge.
    ok_full = (
        passable(h_full, in_full) & passable(*_ground(elev, lon_mid, lat_mid)) & (ok_x | ok_y)
    )
    choice = np.where(ok_full, 0, np.where(ok_x, 1, np.where(ok_y, 2, 3)))
    lon = np.where((choice == 0) | (choice == 1), lon_new, p.lon)
    lat = np.where((choice == 0) | (choice == 2), lat_new, p.lat)
    h_new = np.choose(choice, (h_full, h_x, h_y, h_here))
    in_domain = np.choose(choice, (in_full, in_x, in_y, in_here))

    # 3. Height relaxation.
    target = h_new + 0.5 * blh
    z = p.z_m + (target - p.z_m) * (1.0 - np.exp(-DT_S / Z_RELAX_S))

    # 4. Deposition.
    frac = p.frac
    if deposition:
        rain = np.nan_to_num(precip, nan=0.0)
        wet = rain > 0
        washout = np.zeros(n)
        washout[wet] = WASHOUT_A * np.power(rain[wet], WASHOUT_B)
        frac = frac * np.exp(-(V_DEP_M_S / blh + washout) * DT_S)

    # 5. Age and drop.
    out = Particles(
        lon=lon, lat=lat,
        age_s=(p.age_s + np.float32(DT_S)).astype(np.float32, copy=False),
        z_m=z.astype(np.float32, copy=False),
        tag=p.tag, mass0_kg=p.mass0_kg,
        frac=frac.astype(np.float32, copy=False),
    )
    depleted = in_domain & (out.frac < MIN_MASS_FRACTION)
    keep = in_domain & ~depleted
    stats = StepStats(
        missing_met=missing_met,
        left_domain=int(n - np.count_nonzero(in_domain)),
        depleted=int(np.count_nonzero(depleted)),
    )
    return (out if keep.all() else out.keep(keep)), stats
