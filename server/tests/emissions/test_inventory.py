import netCDF4
import numpy as np
import pytest

from vayu import config
from vayu.domain import (
    NX,
    NY,
    REGIONS,
    SECTORS,
    TAGS,
    cell_area_m2,
    cell_index,
    india_mask,
    region_mask,
)
from vayu.emissions import inventory

HOURS_PER_YEAR = 8760


def write_nc(path, values, units, lat0=0.05, lon0=60.05, descending_lat=False):
    """A synthetic EDGAR-style file: (lat, lon) variable `emissions` on a 0.1 degree grid whose
    window (lon 60-100, lat 0-40) is larger than the model domain."""
    n = values.shape[0]
    lat = lat0 + 0.1 * np.arange(n)
    lon = lon0 + 0.1 * np.arange(values.shape[1])
    if descending_lat:
        lat, values = lat[::-1], values[::-1]
    with netCDF4.Dataset(path, "w") as ds:
        ds.createDimension("lat", lat.size)
        ds.createDimension("lon", lon.size)
        ds.createVariable("lat", "f8", ("lat",))[:] = lat
        ds.createVariable("lon", "f8", ("lon",))[:] = lon
        v = ds.createVariable("emissions", "f4", ("lat", "lon"))
        v.units = units
        v[:] = values


def window(fill):
    return np.full((400, 400), fill, dtype=np.float32)


def test_unit_conversion(tmp_path):
    flux = tmp_path / "flux.nc"
    write_nc(flux, window(2e-9), "kg m-2 s-1")
    kg_h = inventory.read_grid(flux)
    assert kg_h.shape == (NY, NX)
    np.testing.assert_allclose(kg_h[:, 5], 2e-9 * cell_area_m2() * 3600, rtol=1e-6)

    tonnes = tmp_path / "tonnes.nc"
    write_nc(tonnes, window(8.76), "Tonnes")  # 8.76 t/yr = 1 kg/h
    np.testing.assert_allclose(inventory.read_grid(tonnes), 1.0, rtol=1e-6)


def test_read_grid_orientation_and_alignment(tmp_path):
    values = np.arange(400 * 400, dtype=np.float32).reshape(400, 400)
    south_north, north_south = tmp_path / "a.nc", tmp_path / "b.nc"
    write_nc(south_north, values, "Tonnes")
    write_nc(north_south, values, "Tonnes", descending_lat=True)
    a, b = inventory.read_grid(south_north), inventory.read_grid(north_south)
    np.testing.assert_array_equal(a, b)
    # domain cell (iy=0, ix=0) is centre (66.05, 6.05) = file row 60, column 60
    assert a[0, 0] == pytest.approx(float(values[60, 60]) * 1000 / HOURS_PER_YEAR, rel=1e-6)

    shifted = tmp_path / "shifted.nc"
    write_nc(shifted, values, "Tonnes", lon0=60.0)  # cell edges, not centres
    with pytest.raises(ValueError, match="aligned"):
        inventory.read_grid(shifted)
    partial = tmp_path / "partial.nc"
    write_nc(partial, values[:, :300], "Tonnes")  # lon stops at 90
    with pytest.raises(ValueError, match="cover"):
        inventory.read_grid(partial)


def test_hot_cell_lands_at_its_own_cell_not_transposed(tmp_path):
    values = np.zeros((400, 400), dtype=np.float32)
    values[286, 172] = 8.76  # file lat 28.65, lon 77.25: the centre of the cell holding (77.2, 28.6)
    for descending in (False, True):
        path = tmp_path / f"hot_{descending}.nc"
        write_nc(path, values, "Tonnes", descending_lat=descending)
        grid = inventory.read_grid(path)
        ix, iy = cell_index(77.2, 28.6)
        assert grid[iy, ix] == pytest.approx(1.0)
        assert np.count_nonzero(grid) == 1


@pytest.mark.parametrize("units", ["ppm", "mg", "Mg/s"])
def test_unknown_units_rejected(tmp_path, units):
    bad = tmp_path / "bad.nc"
    write_nc(bad, window(1.0), units)
    with pytest.raises(ValueError, match="units"):
        inventory.read_grid(bad)


def test_megagram_units_accepted(tmp_path):
    ok = tmp_path / "ok.nc"
    write_nc(ok, window(8.76), "Mg")
    np.testing.assert_allclose(inventory.read_grid(ok), 1.0, rtol=1e-6)


def test_split_by_region_conserves_mass():
    rng = np.random.default_rng(0)
    grids = {s: rng.random((NY, NX)) for s in ("vehicles", "industry", "residential")}
    em = inventory.split_by_region(grids)
    land = india_mask()
    for sector, grid in grids.items():
        parts = []
        for region in REGIONS:
            iy, ix, kg = em.hour(f"{sector}_{region}", 0)
            parts.append(kg.sum())
            assert land[iy, ix].all()  # nothing outside India
            assert (region_mask()[iy, ix] == REGIONS.index(region)).all()
        np.testing.assert_allclose(sum(parts), grid[land].sum(), rtol=1e-12)
    assert grids["vehicles"].sum() > grids["vehicles"][land].sum()  # something was dropped


def test_split_by_region_treats_missing_grids_as_zero():
    em = inventory.split_by_region({s: np.ones((NY, NX)) for s in ("vehicles", "industry", "residential")})
    for region in REGIONS:
        assert em.hour(f"dust_{region}", 0)[2].size == 0
        assert em.hour(f"coarse_vehicles_{region}", 0)[2].size == 0


def test_coarse_is_pm10_minus_pm25_never_negative():
    pm25 = {"vehicles": np.array([[1.0, 5.0]])}
    pm10 = {"vehicles": np.array([[4.0, 3.0]])}
    np.testing.assert_array_equal(inventory.coarse_grids(pm25, pm10)["coarse_vehicles"], [[3.0, 0.0]])


def test_dust_estimate_spreads_teri_totals_over_india_by_the_proxy():
    from vayu import constants as C
    from vayu.domain import india_mask
    proxy = np.ones((NY, NX))
    proxy[india_mask()] = 2.0
    proxy[200, 150] = 6.0  # a busier cell inside India (Madhya Pradesh)
    assert india_mask()[200, 150]
    fine, coarse = inventory.dust_grids(proxy)
    kt = lambda g: g.sum() * inventory.HOURS_PER_YEAR / 1e6
    assert kt(fine) == pytest.approx(C.DUST_ROAD_PM25_KT + C.DUST_CONSTRUCTION_PM25_KT)
    assert kt(fine + coarse) == pytest.approx(C.DUST_ROAD_PM10_KT + C.DUST_CONSTRUCTION_PM10_KT)
    assert not fine[~india_mask()].any() and not coarse[~india_mask()].any()
    assert coarse[200, 150] == pytest.approx(3 * coarse[200, 151])  # proportional to the proxy
    zero = inventory.dust_grids(np.zeros((NY, NX)))
    assert not zero[0].any() and not zero[1].any()
    assert inventory.DUST_ESTIMATED is True


def test_all_48_tags_present(tmp_path, monkeypatch):
    install_fake_inventory(tmp_path)
    em = inventory.inventory_emissions()
    sector_tags = sorted(t.id for t in TAGS if t.kind == "sector")
    assert len(sector_tags) == 48 == 2 * len(SECTORS) * len(REGIONS)
    assert em.tags == sector_tags
    notes = inventory.inventory_notes()
    assert notes["dust_available"] is True and notes["dust_estimated"] is True
    assert "TERI" in notes["dust_source"]
    assert notes["year"] == 2022 and "EDGAR" in notes["source"]


def install_fake_inventory(tmp_path):
    folder = config.data_dir() / "inventory"
    folder.mkdir(parents=True, exist_ok=True)
    for i, name in enumerate(inventory.source_files()):
        write_nc(folder / name, window(8.76 * (i + 1)), "Tonnes")


def total(em, tag):
    return em.hour(tag, 0)[2].sum()


def test_cache_is_reused_while_key_is_valid(tmp_path):
    install_fake_inventory(tmp_path)
    first = inventory.inventory_emissions()
    cache = next(config.data_dir().rglob("*.npz"))
    stamp = cache.stat().st_mtime_ns
    second = inventory.inventory_emissions()
    assert cache.stat().st_mtime_ns == stamp  # not rewritten
    for tag in first.tags:
        for a, b in zip(first.hour(tag, 0), second.hour(tag, 0)):
            np.testing.assert_array_equal(a, b)


def test_cache_rebuilt_when_source_file_changes(tmp_path):
    install_fake_inventory(tmp_path)
    before = total(inventory.inventory_emissions(), "vehicles_rest_of_india")
    path = config.data_dir() / "inventory" / inventory.source_files()[0]  # the TRO file
    write_nc(path, window(8.76 * 10), "Tonnes")
    after = total(inventory.inventory_emissions(), "vehicles_rest_of_india")
    assert after == pytest.approx(before * 10 / 1)  # TRO was 8.76 (x1), now x10


def test_cache_rebuilt_when_sector_mapping_changes(tmp_path, monkeypatch):
    install_fake_inventory(tmp_path)
    full = total(inventory.inventory_emissions(), "industry_rest_of_india")
    monkeypatch.setattr(inventory, "EDGAR_SECTORS", {**inventory.EDGAR_SECTORS, "industry": ("ENE",)})
    em = inventory.inventory_emissions()
    assert total(em, "industry_rest_of_india") < full
    assert len(em.tags) == 48


def test_cache_rebuilt_when_conversion_changes(tmp_path, monkeypatch):
    install_fake_inventory(tmp_path)
    before = total(inventory.inventory_emissions(), "residential_rest_of_india")
    monkeypatch.setattr(inventory, "HOURS_PER_YEAR", inventory.HOURS_PER_YEAR * 2)
    assert total(inventory.inventory_emissions(), "residential_rest_of_india") == pytest.approx(before / 2)


def test_cache_rebuilt_when_loader_version_changes(tmp_path, monkeypatch):
    install_fake_inventory(tmp_path)
    inventory.inventory_emissions()
    cache = next(config.data_dir().rglob("*.npz"))
    stamp = cache.stat().st_mtime_ns
    monkeypatch.setattr(inventory, "INVENTORY_LOADER_VERSION", inventory.INVENTORY_LOADER_VERSION + 1)
    inventory.inventory_emissions()
    assert cache.stat().st_mtime_ns != stamp  # rewritten under the new key


def test_valid_cache_without_source_files_raises(tmp_path):
    install_fake_inventory(tmp_path)
    inventory.inventory_emissions()
    for f in (config.data_dir() / "inventory").glob("*.nc"):
        f.unlink()
    with pytest.raises(inventory.InventoryNotFound, match="make setup"):
        inventory.inventory_emissions()


def test_missing_files_raise_with_fetch_instruction():
    with pytest.raises(inventory.InventoryNotFound, match="make setup"):
        inventory.inventory_emissions()
