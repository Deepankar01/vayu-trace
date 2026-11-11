import math

import numpy as np
import pytest

from vayu.domain import cell_index
from vayu.emissions import dropped
from vayu.emissions.dropped import FIREWORKS_TOTAL_KG, KINDS, dropped_emissions

DELHI = (77.21, 28.61)


def test_every_kind_has_citation():
    assert set(KINDS) == {"traffic", "construction", "fireworks", "custom"}
    for kind in KINDS.values():
        assert kind.source.startswith("http")
        assert kind.label and kind.unit


def test_custom_is_identity():
    for x in (0.5, 1.0, 10.0, 1234.5):
        assert KINDS["custom"].kg_per_hour(x) == x


def test_factors_are_linear_and_positive():
    for name in ("traffic", "construction"):
        f = KINDS[name].kg_per_hour
        assert f(1.0) > 0
        assert math.isclose(f(1000.0), 1000.0 * f(1.0), rel_tol=1e-12)


def test_factor_values_match_the_written_arithmetic():
    # traffic: 0.035278 g/km x 30 km/day / 24 h per vehicle (see dropped.py)
    assert math.isclose(KINDS["traffic"].kg_per_hour(1.0), 0.0352775e-3 * 30 / 24, rel_tol=1e-4)
    # construction: 0.11 short ton PM10/acre/month x 0.09994 PM2.5/PM10 over 720 h
    expected = 0.11 * 907.18474 / 4046.8564224 * (4.89 / 48.93) / 720
    assert math.isclose(KINDS["construction"].kg_per_hour(1.0), expected, rel_tol=1e-12)


def test_emissions_placed_in_cell_and_hours():
    em = dropped_emissions("custom", *DELHI, 10.0, 2, 3, 8, tag_id="user_1")
    ix, iy = cell_index(*DELHI)
    assert em.tags == ["user_1"]
    for h in range(8):
        cy, cx, kg = em.hour("user_1", h)
        if 2 <= h < 5:
            assert list(cy) == [iy] and list(cx) == [ix] and list(kg) == [10.0]
        else:
            assert kg.size == 0


def test_duration_truncated_at_window_end():
    em = dropped_emissions("custom", *DELHI, 1.0, 6, 72, 8)
    assert [em.hour("user", h)[2].sum() for h in range(8)] == [0] * 6 + [1.0, 1.0]


def test_fireworks_total_independent_of_duration():
    for size, total in FIREWORKS_TOTAL_KG.items():
        for duration in (1, 3, 5):
            em = dropped_emissions("fireworks", *DELHI, size, 0, duration, 10)
            got = sum(em.hour("user", h)[2].sum() for h in range(10))
            assert math.isclose(got, total, rel_tol=1e-12)


def test_fireworks_rejects_unknown_size():
    with pytest.raises(ValueError, match="size"):
        dropped_emissions("fireworks", *DELHI, 2.5, 0, 3, 10)


def test_dropped_outside_domain_raises():
    with pytest.raises(ValueError, match="outside"):
        dropped_emissions("custom", 100.0, 28.0, 1.0, 0, 3, 10)


@pytest.mark.parametrize("kwargs, match", [
    ({"kind": "volcano"}, "kind"),
    ({"amount": 0.0}, "amount"),
    ({"amount": -1.0}, "amount"),
    ({"amount": float("inf")}, "amount"),
    ({"amount": float("nan")}, "amount"),
    ({"start_hour": -1}, "start_hour"),
    ({"start_hour": 10}, "start_hour"),
    ({"duration_h": 0}, "duration_h"),
    ({"duration_h": 73}, "duration_h"),
])
def test_validation(kwargs, match):
    args = {"kind": "custom", "lon": DELHI[0], "lat": DELHI[1], "amount": 1.0,
            "start_hour": 0, "duration_h": 3, "hours": 10, **kwargs}
    with pytest.raises(ValueError, match=match):
        dropped_emissions(**args)


def test_rate_matches_kind_for_continuous_kinds():
    em = dropped_emissions("traffic", *DELHI, 5000.0, 0, 1, 1)
    assert np.isclose(em.hour("user", 0)[2].sum(), dropped.KINDS["traffic"].kg_per_hour(5000.0))
