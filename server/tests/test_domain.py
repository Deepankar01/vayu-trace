import numpy as np

from vayu.domain import (
    FIRE_STATES,
    NX,
    NY,
    REGIONS,
    SECTORS,
    TAGS,
    cell_area_m2,
    cell_center,
    cell_index,
    fire_state_mask,
    region_mask,
)


def region_at(lon, lat):
    ix, iy = cell_index(lon, lat)
    return REGIONS[region_mask()[iy, ix]]


def fire_state_at(lon, lat):
    ix, iy = cell_index(lon, lat)
    return FIRE_STATES[fire_state_mask()[iy, ix]]


def test_tag_count():
    assert len(TAGS) == 34 and len({t.id for t in TAGS}) == 34


def test_tag_kinds_and_labels():
    by_id = {t.id: t for t in TAGS}
    assert by_id["fire_punjab"].kind == "fire" and by_id["fire_punjab"].region == "punjab"
    assert by_id["firefc_other"].kind == "firefc" and by_id["firefc_other"].label == "Fires (satellite)"
    assert by_id["fire_punjab"].color == "#ff5a2b"
    v = by_id["vehicles_delhi_ncr"]
    assert (v.kind, v.sector, v.region, v.label, v.color) == (
        "sector", "vehicles", "delhi_ncr", "Vehicles", "#6aa8ff")
    assert by_id["dust_bihar"].label == "Road and construction dust"
    assert {t.sector for t in TAGS if t.kind == "sector"} == set(SECTORS)


def test_cell_index_corners():
    ix, iy = cell_index(np.array([66.0, 97.99, 65.9]), np.array([6.0, 37.99, 10.0]))
    assert list(ix) == [0, 319, -1] and list(iy)[:2] == [0, 319]


def test_cell_index_scalar_and_outside():
    ix, iy = cell_index(77.21, 28.61)
    assert (int(ix), int(iy)) == (112, 226)
    ix, iy = cell_index(98.0, 38.0)
    assert int(ix) == -1 and int(iy) == -1


def test_cell_center_roundtrip():
    lon, lat = cell_center(np.array([0, 112]), np.array([0, 226]))
    assert np.allclose(lon, [66.05, 77.25]) and np.allclose(lat, [6.05, 28.65])
    ix, iy = cell_index(lon, lat)
    assert list(ix) == [0, 112] and list(iy) == [0, 226]


def test_cell_area():
    a = cell_area_m2()
    assert a.shape == (NY,) and a[0] > a[-1] > 0
    assert 1.0e8 < a[200] < 1.3e8  # ~0.1 deg x 0.1 deg is about 11 km x 11 km


def test_masks_shape_dtype_deterministic():
    r, f = region_mask(), fire_state_mask()
    assert r.shape == f.shape == (NY, NX) and r.dtype == f.dtype == np.int8
    assert region_mask() is r  # cached


def test_delhi_is_ncr():
    assert region_at(77.21, 28.61) == "delhi_ncr"


def test_ncr_takes_precedence_over_state():
    assert region_at(77.0, 28.9) == "delhi_ncr"  # Sonipat side, Haryana
    assert fire_state_at(77.0, 28.9) == "haryana"


def test_ludhiana_is_punjab():
    assert region_at(75.85, 30.90) == "punjab"
    assert fire_state_at(75.85, 30.90) == "punjab"


def test_other_regions():
    assert region_at(85.14, 25.60) == "bihar"  # Patna
    assert region_at(80.95, 26.85) == "uttar_pradesh"  # Lucknow
    assert region_at(75.72, 29.15) == "haryana"  # Hisar
    assert fire_state_at(77.41, 23.26) == "madhya_pradesh"  # Bhopal
    assert fire_state_at(80.27, 13.08) == "other"


def test_chennai_is_rest():
    assert region_at(80.27, 13.08) == "rest_of_india"


def test_ocean_is_rest():
    assert region_at(70.0, 10.0) == "rest_of_india"
