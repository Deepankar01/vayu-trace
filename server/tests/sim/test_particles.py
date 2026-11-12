import math

import numpy as np
import pytest

from vayu.constants import (
    DT_S,
    EARTH_RADIUS_M,
    K_H_M2_S,
    V_DEP_M_S,
    WASHOUT_A,
    WASHOUT_B,
    Z_RELAX_S,
)
from vayu.domain import CELL, LAT_MIN, LON_MAX, LON_MIN, NX, NY
from vayu.met import MetSample
from vayu.sim import particles
from vayu.sim.particles import Particles, StepStats, step

STEPS_PER_HOUR = 3600 // DT_S


class StubMet:
    """Uniform met everywhere; `u_fn` optionally overrides u per position."""

    def __init__(self, u=0.0, v=0.0, blh=500.0, precip=0.0, u_fn=None):
        self.u, self.v, self.blh, self.precip, self.u_fn = u, v, blh, precip, u_fn

    def sample(self, lon, lat, t_hours):
        lon = np.asarray(lon, dtype=float)
        full = lambda x: np.full(lon.shape, x, dtype=float)
        u = self.u_fn(lon, lat) if self.u_fn else full(self.u)
        return MetSample(u, full(self.v), full(self.blh), full(0.5), full(20.0), full(self.precip))


def flat(h=0.0):
    return np.full((NY, NX), h, dtype=np.float32)


def make(lon, lat, mass=1.0, z=250.0):
    lon = np.asarray(lon, dtype=float)
    lat = np.broadcast_to(np.asarray(lat, dtype=float), lon.shape).copy()
    n = lon.size
    return Particles(
        lon=lon.copy(), lat=lat,
        age_s=np.zeros(n, np.float32),
        z_m=np.full(n, z, np.float32), tag=np.zeros(n, np.int16),
        mass0_kg=np.full(n, mass, np.float32), frac=np.ones(n, np.float32),
    )


def run(p, met, elev, hours, seed=0, **kw):
    rng = np.random.default_rng(seed)
    stats = []
    for i in range(int(hours * STEPS_PER_HOUR)):
        p, s = step(p, met, elev, i * DT_S / 3600, rng, **kw)
        stats.append(s)
    return p, stats


def col(lon):
    """Grid column of a longitude."""
    return round((lon - LON_MIN) / CELL)


def row(lat):
    return round((lat - LAT_MIN) / CELL)


def east_m(dlon, lat):
    return np.radians(dlon) * EARTH_RADIUS_M * np.cos(np.radians(lat))


def north_m(dlat):
    return np.radians(dlat) * EARTH_RADIUS_M


# --- brief tests ---------------------------------------------------------------------------


@pytest.mark.parametrize("lat", [22.0, 37.0])  # 37 N: cos(lat) ~ 0.80
def test_uniform_wind_distance(monkeypatch, lat):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    p0 = make(np.linspace(75, 80, 50), lat)
    p, _ = run(p0, StubMet(u=5.0), flat(), hours=1)
    assert len(p) == 50
    dx = east_m(p.lon - p0.lon, lat)
    assert dx.mean() == pytest.approx(18_000, rel=0.01)
    assert np.abs(p.lat - p0.lat).max() < 1e-9


def test_mass_conserved_without_deposition():
    p0 = make(np.full(1000, 80.0), 22.0, mass=2.5)
    p, _ = run(p0, StubMet(u=3.0, precip=5.0), flat(), hours=6, deposition=False)
    assert len(p) == 1000
    assert p.mass_kg.sum() == p0.mass_kg.sum()
    assert np.all(p.mass_kg == np.float32(2.5))


def test_dry_deposition_rate():
    p, _ = run(make(np.full(100, 80.0), 22.0), StubMet(blh=500.0), flat(), hours=1)
    assert p.mass_kg.mean() == pytest.approx(math.exp(-0.002 * 3600 / 500), rel=1e-3)


def test_rain_removes_more():
    dry, _ = run(make(np.full(100, 80.0), 22.0), StubMet(), flat(), hours=3)
    wet, _ = run(make(np.full(100, 80.0), 22.0), StubMet(precip=2.0), flat(), hours=3)
    assert wet.mass_kg.mean() < dry.mass_kg.mean()
    expected = math.exp(-(V_DEP_M_S / 500 + WASHOUT_A * 2.0**WASHOUT_B) * 3 * 3600)
    assert wet.mass_kg.mean() == pytest.approx(expected, rel=1e-3)


def test_wall_blocks():
    wall_lon = 82.0
    elev = flat()
    elev[:, col(wall_lon):] = 3000.0
    p, _ = run(make(np.full(2000, 80.0), 22.0), StubMet(u=5.0, blh=500.0), elev, hours=24)
    assert len(p) == 2000
    assert p.lon.max() < wall_lon
    assert p.lon.mean() > 81.5  # they did reach and pile up against the wall


RAMP_START = 72.0


def ramp():
    """1,000 m rise over 500 km (~4.8 degrees of longitude at 22 N), flat at the top."""
    lon_c = LON_MIN + (np.arange(NX) + 0.5) * CELL
    ramp_len_deg = 500e3 / east_m(1.0, 22.0)
    rise = np.clip((lon_c - RAMP_START) / ramp_len_deg, 0, 1) * 1000.0
    return np.broadcast_to(rise, (NY, NX)).astype(np.float32), RAMP_START + ramp_len_deg


def test_gentle_slope_passes():
    elev, ramp_end = ramp()
    p, _ = run(make(np.full(500, 71.0), 22.0), StubMet(u=5.0), elev, hours=48)
    assert len(p) == 500
    assert p.lon.min() > ramp_end


def test_gentle_slope_holds_back_shallow_night_layer():
    # blh 100 m: z_m lags the slope by ~slope*u*Z_RELAX_S = 0.002*5*21600 = 216 m, more than the
    # mixed-layer depth, so the parcel is repeatedly held until z_m catches up. It creeps up the
    # slope (held back, not lost) instead of crossing it like the 500 m layer above.
    elev, ramp_end = ramp()
    p, s = run(make(np.full(500, 71.0), 22.0, z=50.0), StubMet(u=5.0, blh=100.0), elev, hours=48)
    assert len(p) == 500
    assert sum(x.left_domain + x.depleted + x.missing_met for x in s) == 0
    assert p.lon.mean() > RAMP_START + 0.5  # it does climb
    assert p.lon.max() < ramp_end  # but nowhere near as far as 5 m/s for 48 h would take it


def test_diffusion_variance():
    n = 20_000
    p0 = make(np.full(n, 80.0), 22.0)
    p, _ = run(p0, StubMet(), flat(), hours=1, deposition=False)
    expected = 2 * K_H_M2_S * 3600
    assert np.var(east_m(p.lon - p0.lon, 22.0)) == pytest.approx(expected, rel=0.05)
    assert np.var(north_m(p.lat - p0.lat)) == pytest.approx(expected, rel=0.05)


def test_leaves_domain_dropped():
    p0 = make(np.array([LON_MAX - 0.01, 80.0]), 22.0)
    p, stats = run(p0, StubMet(u=10.0), flat(), hours=1)
    assert len(p) == 1
    assert p.lon[0] < 82.0
    assert sum(s.left_domain for s in stats) == 1


def test_seeded_rng_is_deterministic():
    elev = flat()
    elev[:, col(82.0):] = 3000.0
    met = StubMet(u=4.0, v=1.0, precip=1.0)
    a, sa = run(make(np.full(500, 80.0), 22.0), met, elev, hours=6, seed=42)
    b, sb = run(make(np.full(500, 80.0), 22.0), met, elev, hours=6, seed=42)
    c, _ = run(make(np.full(500, 80.0), 22.0), met, elev, hours=6, seed=43)
    for f in ("lon", "lat", "age_s", "z_m", "tag", "mass0_kg", "frac"):
        np.testing.assert_array_equal(getattr(a, f), getattr(b, f))
    assert sa == sb
    assert not np.array_equal(a.lon, c.lon)


# --- additional tests ----------------------------------------------------------------------


def test_missing_met_drops_and_counts(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    u_fn = lambda lon, lat: np.where(lon < 75.0, np.nan, 2.0)
    p0 = make(np.array([70.0, 71.0, 80.0, 81.0, 82.0]), 22.0)
    p, s = step(p0, StubMet(u_fn=u_fn), flat(), 0.0, np.random.default_rng(0))
    assert s == StepStats(left_domain=0, depleted=0, missing_met=2)
    assert len(p) == 3
    assert np.all(p.lon > 80.0 - 1e-9)


def test_missing_precip_is_no_rain():
    class NanPrecip(StubMet):
        def sample(self, lon, lat, t_hours):
            s = super().sample(lon, lat, t_hours)
            s.precip_mm_h[:] = np.nan
            return s

    p, s = step(make(np.full(10, 80.0), 22.0), NanPrecip(), flat(), 0.0, np.random.default_rng(0))
    assert s.missing_met == 0 and len(p) == 10
    assert np.allclose(p.mass_kg, math.exp(-V_DEP_M_S / 500 * DT_S), rtol=1e-6)


@pytest.mark.parametrize("precip", [0.0, -0.1])
def test_zero_or_negative_precip_gives_no_washout(precip):
    p, _ = step(make(np.full(10, 80.0), 22.0), StubMet(precip=precip), flat(), 0.0,
                np.random.default_rng(0))
    assert np.all(np.isfinite(p.mass_kg))
    assert np.allclose(p.mass_kg, math.exp(-V_DEP_M_S / 500 * DT_S), rtol=1e-6)


def test_depleted_parcels_dropped():
    p0 = make(np.full(4, 80.0), 22.0, mass=1.0)
    p0.frac[:2] = 0.0099  # below 1 % of the release mass
    p, s = step(p0, StubMet(), flat(), 0.0, np.random.default_rng(0))
    assert len(p) == 2
    assert s == StepStats(left_domain=0, depleted=2, missing_met=0)


def test_leaving_domain_is_not_blocked_by_wrapped_elevation(monkeypatch):
    # A raw -1 index would read the east edge column; a mountain there must not stop a parcel
    # leaving through the west edge.
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    elev = flat()
    elev[:, -1] = 5000.0
    elev[-1, :] = 5000.0
    p, s = step(make(np.array([LON_MIN + 0.01]), 22.0), StubMet(u=-10.0), elev, 0.0,
                np.random.default_rng(0))
    assert len(p) == 0
    assert s.left_domain == 1


def test_z_relaxes_toward_target(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    p0 = make(np.array([80.0]), 22.0, z=0.0)
    p, _ = step(p0, StubMet(blh=500.0), flat(1000.0), 0.0, np.random.default_rng(0))
    target = 1000.0 + 250.0
    assert p.z_m[0] == pytest.approx(target * (1 - math.exp(-DT_S / Z_RELAX_S)), rel=1e-5)
    p2, _ = run(p0, StubMet(blh=500.0), flat(1000.0), hours=48)
    assert p2.z_m[0] == pytest.approx(target, rel=1e-3)


def test_sea_elevation_treated_as_zero(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    p, _ = step(make(np.array([80.0]), 22.0, z=250.0), StubMet(blh=500.0), flat(-2000.0), 0.0,
                np.random.default_rng(0))
    assert p.z_m[0] == pytest.approx(250.0)


def test_x_only_fallback_slides_along_wall_to_the_north(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    elev = flat()
    elev[row(25.0):, :] = 3000.0
    p0 = make(np.array([80.0]), 24.98)
    p, _ = step(p0, StubMet(u=5.0, v=5.0), elev, 0.0, np.random.default_rng(0))
    assert p.lat[0] == p0.lat[0]  # northward part refused
    assert east_m(p.lon[0] - 80.0, 24.98) == pytest.approx(5.0 * DT_S, rel=1e-6)


def test_y_only_fallback_slides_along_wall_to_the_east(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    elev = flat()
    elev[:, col(82.0):] = 3000.0
    p0 = make(np.array([81.99]), 22.0)
    p, _ = step(p0, StubMet(u=5.0, v=5.0), elev, 0.0, np.random.default_rng(0))
    assert p.lon[0] == p0.lon[0]
    assert north_m(p.lat[0] - 22.0) == pytest.approx(5.0 * DT_S, rel=1e-6)


def test_fully_blocked_parcel_stays(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    elev = flat()
    elev[row(22.0) + 1:, :] = 3000.0
    elev[:, col(80.0) + 1:] = 3000.0
    p0 = make(np.array([80.09]), 22.09)
    p, _ = step(p0, StubMet(u=5.0, v=5.0), elev, 0.0, np.random.default_rng(0))
    assert (p.lon[0], p.lat[0]) == (p0.lon[0], p0.lat[0])
    assert p.age_s[0] == DT_S


def test_particles_helpers():
    a = make(np.array([70.0, 71.0]), 20.0)
    b = make(np.array([72.0]), 21.0)
    c = Particles.concat([a, Particles.empty(), b])
    assert len(c) == 3
    np.testing.assert_array_equal(c.lon, [70.0, 71.0, 72.0])
    k = c.keep(np.array([True, False, True]))
    np.testing.assert_array_equal(k.lat, [20.0, 21.0])
    assert k.tag.dtype == np.int16 and k.lon.dtype == np.float64
    assert len(Particles.concat([])) == 0


def test_diagonal_one_cell_ridge_is_not_cut(monkeypatch):
    # Ridge cells where ix - iy == c run south-west to north-east; wind blows toward the
    # north-west, straight across it. Without the corner rule parcels slip between the diagonal
    # cells.
    iy, ix = np.indices((NY, NX))
    c = col(80.0) - row(22.0)
    elev = flat()
    elev[ix - iy == c] = 4000.0
    p0 = make(np.full(1000, 80.55), 21.55)
    side = lambda p: (np.floor((p.lon - LON_MIN) / CELL) - np.floor((p.lat - LAT_MIN) / CELL))
    assert np.all(side(p0) > c)
    p, _ = run(p0, StubMet(u=-5.0 / np.sqrt(2), v=5.0 / np.sqrt(2), blh=500.0), elev, hours=24)
    assert len(p) == 1000
    assert np.all(side(p) > c)


def test_one_cell_ridge_not_tunnelled_at_20_m_s():
    # 20 m/s * 600 s = 12 km per step, more than one 0.1 degree cell (~10.3 km at 22 N).
    ridge = col(82.0)
    elev = flat()
    elev[:, ridge] = 3000.0
    p, _ = run(make(np.full(1000, 80.0), 22.0), StubMet(u=20.0, blh=500.0), elev, hours=24)
    assert len(p) == 1000
    assert p.lon.max() < LON_MIN + ridge * CELL
    assert p.lon.mean() > LON_MIN + ridge * CELL - 0.3  # they reached it


def _ground_reference(elev, lon, lat):
    """The original per-call terrain look-up, kept as the reference for `_grounds`."""
    from vayu.domain import cell_index, inside

    ix, iy = cell_index(lon, lat)
    ok = inside(ix, iy)
    h = elev[np.where(ok, iy, 0), np.where(ok, ix, 0)]
    return np.where(ok, np.maximum(h, 0.0), 0.0), ok


def test_step_bit_identical_with_reference_terrain_lookup(monkeypatch):
    rng = np.random.default_rng(5)
    elev = rng.uniform(-50, 4000, (NY, NX)).astype(np.float32)
    elev[:, col(82.0)] = 6000.0  # a ridge, so blocking is exercised
    lon = np.r_[rng.uniform(LON_MIN - 0.5, LON_MAX + 0.5, 2000), [LON_MIN, LON_MAX, np.nan]]
    p0 = make(lon, rng.uniform(5.5, 38.5, lon.size), z=300.0)
    met = StubMet(u=6.0, v=-3.0, precip=0.5)
    fast, fast_stats = run(p0, met, elev, hours=2, seed=11)

    def reference(elev, lons, lats, pairs):
        return [_ground_reference(elev, lons[i], lats[j]) for i, j in pairs]

    monkeypatch.setattr(particles, "_grounds", reference)
    ref, ref_stats = run(p0, met, elev, hours=2, seed=11)
    assert fast_stats == ref_stats and sum(s.left_domain for s in ref_stats) > 0
    for f in ("lon", "lat", "age_s", "z_m", "tag", "mass0_kg", "frac"):
        np.testing.assert_array_equal(getattr(fast, f), getattr(ref, f))


# --- coarse particles and release cell ---

def test_coarse_tags_deposit_five_times_faster_and_move_identically():
    from vayu.constants import V_DEP_COARSE_M_S
    from vayu.domain import TAGS
    coarse = next(i for i, t in enumerate(TAGS) if t.size == "coarse")
    p = make(np.array([77.0, 77.0]), 28.0)
    p.tag = np.array([0, coarse], dtype=np.int16)
    out, _ = step(p, StubMet(u=3.0, blh=500.0), flat(), 0.0, np.random.default_rng(1))
    assert out.frac[0] == pytest.approx(math.exp(-V_DEP_M_S / 500.0 * DT_S), rel=1e-6)
    assert out.frac[1] == pytest.approx(math.exp(-V_DEP_COARSE_M_S / 500.0 * DT_S), rel=1e-6)
    assert V_DEP_COARSE_M_S == 5 * V_DEP_M_S
    # size changes nothing but the deposition rate: same wind, same turbulence draw per parcel
    same = make(np.array([77.0, 77.0]), 28.0)
    ref, _ = step(same, StubMet(u=3.0, blh=500.0), flat(), 0.0, np.random.default_rng(1))
    np.testing.assert_array_equal(out.lon, ref.lon)
    np.testing.assert_array_equal(out.lat, ref.lat)


def test_coarse_airborne_mass_after_a_day_is_far_below_fine():
    from vayu.domain import TAGS
    coarse = next(i for i, t in enumerate(TAGS) if t.size == "coarse")
    p = make(np.array([77.0, 77.0]), 28.0)
    p.tag = np.array([0, coarse], dtype=np.int16)
    out, _ = run(p, StubMet(blh=500.0), flat(), 24)
    by_tag = dict(zip(out.tag.tolist(), out.frac.tolist()))
    assert by_tag[0] == pytest.approx(math.exp(-0.002 / 500 * 86400), rel=1e-4)  # 71 % left
    assert by_tag[coarse] == pytest.approx(math.exp(-0.01 / 500 * 86400), rel=1e-4)  # 18 % left


def test_release_cell_is_recorded_and_survives_moves_keep_and_concat():
    p = Particles.released([77.05, 70.0, 200.0], [28.05, 10.0, 28.0], [1.0] * 3, [250.0] * 3, [0] * 3)
    ix, iy = round((77.05 - LON_MIN) / CELL - 0.5), round((28.05 - LAT_MIN) / CELL - 0.5)
    assert p.cell0.dtype == np.int32
    assert p.cell0.tolist() == [iy * NX + ix, 40 * NX + 40, -1]  # -1: released outside the grid
    moved, _ = run(p.keep(np.array([True, True, False])), StubMet(u=10.0), flat(), 3)
    assert moved.cell0.tolist() == p.cell0[:2].tolist() and moved.lon[0] > 77.5
    both = Particles.concat([moved, Particles.empty(), p])
    assert both.cell0.tolist() == p.cell0[:2].tolist() + p.cell0.tolist()
