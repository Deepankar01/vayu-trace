# Data notes

## India states boundary (`server/vayu/assets/india-states.geojson`)

- Source: third-party repository https://github.com/datta07/INDIAN-SHAPEFILES (not an official publication; commit 08490eaab1b9bb4b55addfb1d2c742586c8d22e0, the repository HEAD checked 2026-11-11, the day the file was retrieved), file `INDIA/INDIA_STATES.geojson` (37 state and union-territory polygons; census-style attributes `STNAME_SH` etc.).
- Licence: MIT (repository LICENSE).
- Depiction: believed to follow the official Government of India / Survey of India outline. Jammu & Kashmir includes Pakistan-occupied Kashmir (west to 73.39 E) and Ladakh includes Aksai Chin (north to 37.08 N, east to 80.33 E); Arunachal Pradesh is shown in full (to 97.41 E).
- Processing: kept only the state name (property `name`, from `STNAME_SH`); geometry repaired with `buffer(0)`, simplified with Douglas-Peucker tolerance 0.01 degree (topology preserved), coordinates rounded to 3 decimals. About 300 KB. Source file was about 2.2 MB.
- The source README says some data reflects 2019 boundaries and asks users to verify for legal purposes; this is used for 0.1 degree rasterisation and a map line only.
- Used for: `region_mask()` / `fire_state_mask()` (cell centres tested with `shapely.contains_xy`), and the web map in Task 12.

### Conformance checks (by inspection, not by authority)
Conformance to the official Government of India / Survey of India depiction was verified by the checks below on the simplified file, not by any official certification:
- Extents: Ladakh lon 72.53-80.33, lat 32.34-37.08 (Aksai Chin reached); Jammu & Kashmir lon from 73.39 (PoK); Arunachal Pradesh lon 91.55-97.41, lat 26.65-29.46.
- Containment: Aksai Chin (79.5 E, 35.2 N) in Ladakh; Gilgit (74.31 E, 35.92 N) and Skardu (75.63 E, 35.30 N) in Ladakh; Muzaffarabad (73.47 E, 34.37 N) in Jammu & Kashmir; Tawang (91.99 E, 27.59 N) in Arunachal Pradesh.
- Required state names (Punjab, Haryana, Uttar Pradesh, Bihar, Madhya Pradesh) are asserted present by a test, and `_state_masks` raises naming any missing one.

### Caveats
- The upstream README says some of its data reflects 2019 boundaries and to verify for official or legal purposes.
- Simplification tolerance is 0.01 degree (about 1 km), so the outline is approximate at the cell scale and not suitable for legal use.

## Emission inventory (`server/vayu/emissions/inventory.py`, `server/scripts/fetch_inventory.py`)

Baseline non-fire PM2.5 as constant (NY, NX) grids in kg per hour, one per `{sector}_{region}` tag (24 tags). Inspected 2026-11-11.

### Source used: EDGAR v8.1 air pollutants (JRC), release `v8.1_FT2022_AP`
- Landing page: https://edgar.jrc.ec.europa.eu/dataset_ap81. Gridded files are served from `https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/v81_FT2022_AP_new/PM2.5/<SECTOR>/emi_nc/v8.1_FT2022_AP_PM2.5_<YEAR>_<SECTOR>_emi_nc.zip` (also `flx_nc` for fluxes and `emi_txt`). Data years 1970-2022; **2022 used** (latest).
- Files used (each a zip of 1.8 MB TRO / 119 KB ENE / 1.2 MB IND / 1.2 MB REF_TRF / 3.4 MB RCO holding one 26.0 MB NetCDF4, `v8.1_FT2022_AP_PM2.5_2022_<SECTOR>_emi.nc`):

  | file (2022, `_emi.nc`) | SHA-256 |
  |---|---|
  | TRO | `17c8b96437d388f27d7cb9cf5838488bb0f09d0277711725904780dd06c37e70` |
  | ENE | `500c4b861fe8e7e68520e5aabd297b8d2f34af55444e8b35ae35e5e004bbc239` |
  | IND | `99e58266bbe6bef8870c028d47b6a493c9f852b05cc1abca7bce299cd5f3f58c` |
  | REF_TRF | `488ace7936a6c7c70fea4452454dd55103dab663b0aa25045382b3d13c7a1837` |
  | RCO | `a14d209f08c9c8563dbf8364f3a3a8202e95d7f8944f0050d31b11280ea60d64` |
- Layout (read from the file, not assumed): NetCDF4, global 1800 x 3600, one float32 variable `emissions(lat, lon)`, `units = "Tonnes"` (per cell per year), `_FillValue = NaN` (none present in the TRO file), `lat` -89.95..89.95 ascending (south to north), `lon` -179.95..179.95, cell centres at x.x5 so they coincide with the model's 0.1 degree centres. The loader still works out ordering from the coordinate variables, accepts descending latitude and `kg m-2 s-1` flux files, and refuses misaligned or partial coverage.
- Conversion: kg/h = tonnes x 1000 / 8760 (2022 has 8760 hours); annual mean rate, no diurnal or seasonal profile.
- Licence: CC BY 4.0 (https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/v81_FT2022_AP_new/copyright.txt: reuse allowed with credit and changes indicated). Required credit: EDGAR v8.1 air pollutants, European Commission JRC, https://edgar.jrc.ec.europa.eu/dataset_ap81. The UI/docs that show these figures must carry that acknowledgement.
- Sector codes (EDGAR readme): TRO road transportation 1A3b; ENE power industry 1A1a; IND combustion for manufacturing 1A2; REF_TRF oil refineries and transformation industry; RCO energy for buildings 1A4+1A5. Sub-splits of TRO do not exist as separate gridded files; the country totals list `1.A.3.b_noRES` and `1.A.3.b_RES` lines, which are both inside TRO.
- The country-total spreadsheet `EDGAR_PM25_1970_2022.zip` (5.7 MB, units Gg) is not gridded and is not used by the code; it was read once to check the loader (below).

### India-specific inventory (ESSD preprint essd-2023-310): inspected, not usable
- Sahu et al., "Development and comprehensive analysis of spatially resolved technological high resolution (0.1x0.1) Emission Inventory of Particulate Matter for India" (SNEIIv2.0), 17 sources, base year 2020, tons/grid/yr, `.shp` format, ~300 MB. It does include a **wind-blown road dust** sector (EPA AP-42 based).
- Zenodo record https://doi.org/10.5281/zenodo.7885103 (V2, 2023-05-02) declares licence CC BY 4.0 but its files are **access-restricted**: the record page says "The record is publicly accessible, but files are restricted. Log in to check if you have access", and `/api/records/7885103/files` returns 403 "Permission denied". Obtaining them needs a Zenodo login and the authors' approval, which is not something the fetch script can do, so no workaround was attempted. There is no other version of the record.
- Consequence: **no usable gridded dust field**. EDGAR itself has no road or construction dust sector (`NMM` non-metallic minerals and `PRO_*` are industrial or fuel process emissions, not dust). Per the spec, `dust_*` grids are zero and `inventory_notes()["dust_available"]` is False; nothing is proxied. If the authors grant access, a dust loader for the `.shp` layer is the only missing piece.

### Mapping (fixed)
| model sector | source |
|---|---|
| `vehicles` | EDGAR TRO |
| `industry` | EDGAR ENE + IND + REF_TRF |
| `residential` | EDGAR RCO |
| `dust` | none: zeros, `dust_available = False` |

Regions come from `region_mask()`. `region_mask()` labels every cell outside the states (sea, Pakistan, Nepal, China...) as `rest_of_india`, so the loader also applies `india_mask()` (cell centre inside any state or union-territory polygon of the official outline) and drops cells outside India. Because that test uses cell centres on a 0.1 degree grid with a simplified outline, coastal cells that are mostly land but centred offshore are dropped.

### Sanity checks
Loader versus EDGAR's own India country totals (2022, kt/yr, sum of the IPCC lines of the spreadsheet vs the gridded loader restricted to `india_mask()`):

| sector | EDGAR country table | loader, India cells |
|---|---|---|
| TRO (1.A.3.b_noRES + _RES) | 57.3 | 57.2 |
| ENE (1.A.1.a) | 398.4 | 388.4 |
| IND (1.A.2) | 1760.3 | 1735.7 |
| REF_TRF (1.A.1.bc + 1.B.1 + 1.B.2) | about 33 | 31.9 |
| RCO (1.A.4 + 1.A.5) | 1645.8 | 1654.8 |

Agreement is within about 3 per cent (the gap is the coastal-cell and polygon-edge effect above); this check confirms units, cropping and orientation, not the inventory's own accuracy. The REF_TRF comparison is approximate because the country table lines do not map one-to-one onto that file.

India-total PM2.5 by sector from `inventory_emissions()` (kt/yr = kg/h x 8760 / 1e6):

| sector | Delhi NCR | Punjab | Haryana | Uttar Pradesh | Bihar | rest of India | India |
|---|---|---|---|---|---|---|---|
| vehicles | 1.0 | 1.2 | 1.4 | 4.1 | 1.9 | 47.7 | 57.3 |
| industry and power | 85.8 | 55.2 | 45.4 | 83.3 | 23.3 | 1863.0 | 2156.0 |
| dust | 0 | 0 | 0 | 0 | 0 | 0 | 0 (not available) |
| residential | 43.5 | 38.9 | 28.7 | 268.4 | 150.3 | 1125.0 | 1654.8 |

Share of each sector's domain-wide EDGAR total dropped for lying outside India: vehicles 21.6 %, industry 13.4 %, residential 37.4 % (neighbouring countries and sea). These sit in the 66-98 E, 6-38 N domain and are not emitted; transport from them into India is therefore not modelled.

### Caveats for researchers
- Road transport in EDGAR is small (57 kt/yr) next to industry and residential; with no dust sector, the model will under-represent coarse-ish road and construction dust, which the Indian inventory above finds dominant for PM10. Do not read the absence of dust as a small dust source.
- EDGAR 0.1 degree allocation uses global proxy data; city-scale placement is approximate.
- One annual mean rate for every hour: no diurnal, weekly or seasonal variation (e.g. winter heating or burning).
