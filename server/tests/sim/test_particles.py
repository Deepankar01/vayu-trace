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
        mass_kg=np.full(n, mass, np.float32), age_s=np.zeros(n, np.float32),
        z_m=np.full(n, z, np.float32), tag=np.zeros(n, np.int16),
        mass0_kg=np.full(n, mass, np.float32),
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


def test_uniform_wind_distance(monkeypatch):
    monkeypatch.setattr(particles, "K_H_M2_S", 0.0)
    p0 = make(np.linspace(75, 80, 50), 22.0)
    p, _ = run(p0, StubMet(u=5.0), flat(), hours=1)
    assert len(p) == 50
    dx = east_m(p.lon - p0.lon, 22.0)
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


def test_gentle_slope_passes():
    # 1,000 m rise over 500 km (~4.8 degrees of longitude at 22 N), flat at the top.
    lon_c = LON_MIN + (np.arange(NX) + 0.5) * CELL
    ramp_start, ramp_len_deg = 72.0, 500e3 / east_m(1.0, 22.0)
    ramp_end = ramp_start + ramp_len_deg
    rise = np.clip((lon_c - ramp_start) / ramp_len_deg, 0, 1) * 1000.0
    elev = np.broadcast_to(rise, (NY, NX)).astype(np.float32)
    p, _ = run(make(np.full(500, 71.0), 22.0), StubMet(u=5.0), elev, hours=48)
    assert len(p) == 500
    assert p.lon.min() > ramp_end


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
    for f in ("lon", "lat", "mass_kg", "age_s", "z_m", "tag", "mass0_kg"):
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
    p0.mass_kg[:2] = 0.0099  # below 1 % of the 1.0 kg release mass
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
