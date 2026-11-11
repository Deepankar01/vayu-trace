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
- Files used (each a zip of 0.1-3.4 MB holding one 26.0 MB NetCDF4, `v8.1_FT2022_AP_PM2.5_2022_<SECTOR>_emi.nc`; all nine PM2.5 gridmaps exist for 2022, none had to be left out):

  | file (2022, `_emi.nc`) | SHA-256 |
  |---|---|
  | TRO | `17c8b96437d388f27d7cb9cf5838488bb0f09d0277711725904780dd06c37e70` |
  | ENE | `500c4b861fe8e7e68520e5aabd297b8d2f34af55444e8b35ae35e5e004bbc239` |
  | IND | `99e58266bbe6bef8870c028d47b6a493c9f852b05cc1abca7bce299cd5f3f58c` |
  | REF_TRF | `488ace7936a6c7c70fea4452454dd55103dab663b0aa25045382b3d13c7a1837` |
  | RCO | `a14d209f08c9c8563dbf8364f3a3a8202e95d7f8944f0050d31b11280ea60d64` |
  | NMM | `3e0a263669ff68c7b890dc33adedfd6ee9e63fb1fd8ad76b30a18a6b243f1505` |
  | IRO | `8dc2028998d8b25682ebaa46283abfa4397f89f9759a9271a6c4d73e8302baab` |
  | NFE | `4c0ea258e5b88b74cb065b164976552d9e9753d5c432102f7f9630f51ee2a1cc` |
  | CHE | `c33a6cfb8945f043590c93c2e46187d105abc8a393127f5edbd1adae4252c77b` |
- Layout (read from the file, not assumed): NetCDF4, global 1800 x 3600, one float32 variable `emissions(lat, lon)`, `units = "Tonnes"` (per cell per year), `_FillValue = NaN` (none present in the TRO file), `lat` -89.95..89.95 ascending (south to north), `lon` -179.95..179.95, cell centres at x.x5 so they coincide with the model's 0.1 degree centres. The loader still works out ordering from the coordinate variables, accepts descending latitude and `kg m-2 s-1` flux files, and refuses misaligned or partial coverage.
- Conversion: kg/h = tonnes x 1000 / 8760 (2022 has 8760 hours); annual mean rate, no diurnal or seasonal profile.
- Licence: CC BY 4.0 (https://jeodpp.jrc.ec.europa.eu/ftp/jrc-opendata/EDGAR/datasets/v81_FT2022_AP_new/copyright.txt: reuse allowed with credit and changes indicated). Required credit: EDGAR v8.1 air pollutants, European Commission JRC, https://edgar.jrc.ec.europa.eu/dataset_ap81. The UI/docs that show these figures must carry that acknowledgement.
- Sector codes (EDGAR readme): TRO road transportation 1A3b; ENE power industry 1A1a; IND combustion for manufacturing 1A2; REF_TRF oil refineries and transformation industry; NMM non-metallic minerals production (cement, lime, glass, ceramics; 2A); IRO iron and steel production (2C1, 2C2); NFE non-ferrous metals production (2C3-2C7); CHE chemical processes (2B); RCO energy for buildings 1A4+1A5. TRO is not split into separate gridded files.
- The country-total spreadsheet `EDGAR_PM25_1970_2022.zip` (5.7 MB, units Gg) is not gridded and is not used by the code; it was read once to check the loader (below).

### India-specific inventory (ESSD preprint essd-2023-310): inspected, not usable
- Sahu et al., "Development and comprehensive analysis of spatially resolved technological high resolution (0.1x0.1) Emission Inventory of Particulate Matter for India" (SNEIIv2.0), 17 sources, base year 2020, tons/grid/yr, `.shp` format, ~300 MB. It does include a **wind-blown road dust** sector (EPA AP-42 based).
- Zenodo record https://doi.org/10.5281/zenodo.7885103 (V2, 2023-05-02) declares licence CC BY 4.0 but its files are **access-restricted**: the record page says "The record is publicly accessible, but files are restricted. Log in to check if you have access", and `/api/records/7885103/files` returns 403 "Permission denied". Obtaining them needs a Zenodo login and the authors' approval, which is not something the fetch script can do, so no workaround was attempted. There is no other version of the record.
- Consequence: **no usable gridded dust field**. EDGAR itself has no road or construction dust sector (`NMM` non-metallic minerals and `PRO_*` are industrial or fuel process emissions, not dust). Per the spec, `dust_*` grids are zero and `inventory_notes()["dust_available"]` is False; nothing is proxied. If the authors grant access, a dust loader for the `.shp` layer is the only missing piece.

### Mapping (fixed)
| model sector | source |
|---|---|
| `vehicles` | EDGAR TRO |
| `industry` | EDGAR ENE + IND + REF_TRF (energy and combustion) + NMM + IRO + NFE + CHE (industrial process PM2.5) |
| `residential` | EDGAR RCO |
| `dust` | none: zeros, `dust_available = False` |

Regions come from `region_mask()`. `region_mask()` labels every cell outside the states (sea, Pakistan, Nepal, China...) as `rest_of_india`, so the loader also applies `india_mask()` (cell centre inside any state or union-territory polygon of the official outline) and drops cells outside India. Because that test uses cell centres on a 0.1 degree grid with a simplified outline, coastal cells that are mostly land but centred offshore are dropped. The loss is not spatially uniform. Measured on the summed sector grids within 0.5 degree of each city, the share kept is: Delhi 100 %, Kolkata 100 %, Mumbai 99.4 %, Chennai 84 %; the national shortfall against EDGAR's country totals (about 1-3 %) comes from such edge cells. Emissions outside India are dropped by design: for example only 5 % of the emission within 0.5 degree of Lahore is kept (the part on the Indian side of the boundary), so Pakistani Punjab, which is upwind of Delhi in winter, contributes nothing, and neither do Nepal, Bangladesh or Chinese sources. Transport from them is not simulated.

### Sanity checks
Loader versus EDGAR's own India country totals (2022, kt/yr, sum of the IPCC lines of the spreadsheet vs the gridded loader restricted to `india_mask()`):

| sector | EDGAR country table | loader, India cells |
|---|---|---|
| TRO (1.A.3.b_noRES + _RES) | 57.3 | 57.2 |
| ENE (1.A.1.a) | 398.4 | 388.4 |
| IND (1.A.2) | 1760.3 | 1735.7 |
| REF_TRF (1.A.1.bc + 1.B.1 + 1.B.2) | about 33 | 31.9 |
| NMM (2.A.1-2.A.4) | 142.5 | 141.2 |
| IRO + NFE (2.C) | 24.8 | 24.8 |
| CHE (2.B) | 12.7 | 12.5 |
| RCO (1.A.4 + 1.A.5) | 1645.8 | 1654.8 |

Agreement is within about 3 per cent (the gap is the coastal-cell and polygon-edge effect above); this check confirms units, cropping and orientation, not the inventory's own accuracy. The REF_TRF comparison is approximate because the country table lines do not map one-to-one onto that file.

India-total PM2.5 by sector from `inventory_emissions()` (kt/yr = kg/h x 8760 / 1e6):

| sector | Delhi NCR | Punjab | Haryana | Uttar Pradesh | Bihar | rest of India | India |
|---|---|---|---|---|---|---|---|
| vehicles | 1.0 | 1.2 | 1.4 | 4.1 | 1.9 | 47.7 | 57.3 |
| industry, power and process | 87.5 | 56.9 | 46.9 | 89.9 | 23.5 | 2029.8 | 2334.5 |
| dust | 0 | 0 | 0 | 0 | 0 | 0 | 0 (not available) |
| residential | 43.5 | 38.9 | 28.7 | 268.4 | 150.3 | 1125.0 | 1654.8 |

Share of each sector's domain-wide EDGAR total dropped for lying outside India: vehicles 21.6 %, industry 14.1 %, residential 37.4 % (neighbouring countries and sea). These sit in the 66-98 E, 6-38 N domain and are not emitted; transport from them into India is therefore not modelled.

### Excluded EDGAR PM2.5 sectors
EDGAR v8.1 publishes PM2.5 gridmaps for 23 sector codes; the nine above are used. India 2022 kt/yr comes from EDGAR's country table (`EDGAR_PM25_1970_2022.zip`, IPCC 2006 lines, both fuel-type blocks summed); "n/a" means the table has no line that maps cleanly onto the code.

| EDGAR code | what | India kt/yr | why excluded |
|---|---|---|---|
| AWB | agricultural waste burning (3.C.1) | 791.8 | Deliberate: crop-residue burning is represented by satellite fire detections ("Fires (satellite)"); including it here would double count |
| AGS | agricultural soils (3.C.2, 3.C.4, 3.C.7) | 39.2 | Agriculture is out of scope (not a source the UI scales) |
| MNM | manure management (3.A.2) | 8.5 | Agriculture, out of scope |
| SWD_INC, SWD_LDF | waste incineration and landfills (4.A, 4.C) | about 0 (landfill 0.001; no incineration line) | Negligible in EDGAR; note EDGAR does not capture open waste burning, which is large in India |
| TNR_Other | railways, pipelines, off-road transport (1.A.3.c + 1.A.3.e) | 22.4 | Non-road transport is not in the sector set; small |
| TNR_Aviation_CDS/CRS/LTO/SPS | aviation (1.A.3.a) | 0.6 | Not a surface source; negligible |
| TNR_Ship | shipping (1.A.3.d + 1.C.2) | 29.4 | Mostly over the sea, outside the India mask |
| PRO_FFF | fuel exploitation and fossil fuel fires (1.B, 5.B) | 5.B 45.0; 1.B.1 about 30.7 (shared with REF_TRF, which includes 1B1b) | Fugitive and mining sources, out of scope; coal-fire (5.B) and mining placement is uncertain |
| PRU_SOL | solvents and products use (2.D and related) | 41.3 (all of 2.D) | Product use is excluded by decision; mostly not primary PM |
| FOO_PAP | food and paper industry process (2.H) | 1.8 | Process sector, negligible; left out for simplicity |
| TOTALS | sum of all sectors | n/a | Not a sector |

The excluded sectors add up to roughly 1.0 Mt/yr of EDGAR PM2.5 for India (an upper bound, since 1.B.1 overlaps REF_TRF), of which AWB is 0.79 Mt.

### What `1.A.3.b_RES` is
EDGAR's country table splits road transport (1A3b, inside TRO) into `1.A.3.b_noRES` and `1.A.3.b_RES`. EDGAR's published sector list (v6.1 page, https://edgar.jrc.ec.europa.eu/dataset_ap61) names them "Road transportation no resuspension" and "Road transportation resuspension" and gives `_RES` only for BC, OC, PM10 and PM2.5. I did not find the v8.1 documentation page that restates this, but the v8.1 India country lines carry the same labels, and `_noRES` plus `_RES` (0.5 + 0.6 + 39.4 + 16.8 = 57.3 kt) equals the TRO gridded India total (57.2 kt), so TRO contains both. About 17 kt of the 57 kt in `vehicles` (roughly 30 %) is therefore resuspended road dust, not exhaust. Some non-exhaust road PM is inside `vehicles` while the separate `dust` sector is unavailable. This is only the share EDGAR attributes to traffic resuspension; it is nowhere near the road and construction dust magnitude in the India inventory discussed above, and it cannot be separated or scaled independently in this model.

### Caveats for researchers
- Road transport in EDGAR is small (57 kt/yr) next to industry and residential; with no dust sector, the model will under-represent coarse-ish road and construction dust, which the Indian inventory above finds dominant for PM10. Industry now includes process PM2.5 (cement, steel and similar), but not open waste burning or small unorganised industry that EDGAR omits. Do not read the absence of dust as a small dust source.
- EDGAR 0.1 degree allocation uses global proxy data; city-scale placement is approximate.
- One annual mean rate for every hour: no diurnal, weekly or seasonal variation (e.g. winter heating or burning).

## Simulation run timing (`server/vayu/sim/run.py`)

Real run for 2023-11-05 (window 2023-11-03 00Z to 2023-11-08 23Z: 144 output hours plus 48 h spin-up = 192 simulated hours, 6 steps per hour), on the development Mac (Apple silicon), measured on 2026-11-11.

### Current configuration (format version 2)
Frames are hour means (6 sub-step samples per hour), each tag's mass grid is smoothed with the age-dependent box kernel (none under 6 h, 3 x 3 from 6 to 24 h, 5 x 5 beyond), parcels per tag-hour are 100, or 400 for the four `*_rest_of_india` sector tags (3 of them emit; dust has no data), and `MetField.sample` has a faster path for a single sample time.

| Stage | cold weather cache | warm cache |
|---|---|---|
| fetching fires + inventory | 0.2 s | 0.4 s |
| fetching weather (Open-Meteo archive, 22 batches, 193 hours) | 12.6 s (after one attempt that failed on HTTP 429, see below) | 0.5 s |
| terrain | 0.0 s (cached) | 0.0 s |
| simulating + writing frames | 111.1 s | 113.2 s |
| **wall** | **124.1 s** | **114.1 s** |

The warm run is inside the 120 s allowance but well above the one-minute target; the parcel count was not cut further. Profile of the simulation stage (cProfile, 114.8 s): `particles.step` 73.6 s, of which terrain look-ups (`_ground`/`cell_index`) 30 s and `MetField.sample` 23 s (82 s before the fast path, with fewer parcels); writing compressed frames 14.8 s (zlib; smoothed fields compress less well than the old sparse ones); building frames 17.6 s, of which the fire-age weighted median 6.7 s; accumulating sub-step samples most of the rest.

Peak live parcels 286,987. Dropped parcels over the run: left the domain 12,277; depleted below 1 % of release mass 334,929; missing met 0. `blh_estimated` false: the archive returned `boundary_layer_height` for every lattice point and hour of this 2023 window.

Open-Meteo rate limits: the free archive answers HTTP 429 when all 22 full-domain batches are requested at once, and the client's backoff (1+2+4+8+16 s) does not outlast it; a retry a minute or so later completes from the partly filled cache. Changing the requested hours (here 192 to 193) changes every cache key and triggers this again. A cold first run of a new date therefore needs one or two attempts, plus 20 s for the terrain tiles once per installation.

Most parcels end by depletion, not by leaving the domain: with mixing heights near the 100 m floor at night, dry deposition at 0.2 cm/s removes about 7 % of a parcel's mass per hour, so parcels fall below 1 % of their release mass within a few days.

### Sampling noise
Measured from the stored runs at four city cells. "Dominant tag" is the tag with the largest window-mean concentration there; "zero hours" is the share of the 144 hours in which that tag's value is exactly zero; "CV vs 3 h" is the standard deviation of (hourly total minus its centred 3-hour running mean) divided by the mean of the running mean. Lower is smoother.

| City (cell) | dominant tag | zero hours, before | zero hours, now | CV vs 3 h, before | CV vs 3 h, now | window mean before / now, µg/m³ |
|---|---|---|---|---|---|---|
| Delhi (77.21 E, 28.61 N) | industry_delhi_ncr | 0.0 % | 0.0 % | 0.18 | 0.15 | 114.1 / 147.3 |
| Patna (85.14 E, 25.61 N) | residential_bihar | 8.3 % | 0.0 % | 0.36 | 0.20 | 43.0 / 43.5 |
| Lucknow (80.95 E, 26.85 N) | residential_uttar_pradesh | 10.4 % | 0.0 % | 0.45 | 0.26 | 29.3 / 41.2 |
| Mumbai (72.88 E, 19.08 N) | industry_rest_of_india | 45.8 % | 0.0 % | 0.86 | 0.24 | 95.0 / 115.9 |

"Before" is the version-1 run: instantaneous snapshot at each whole hour, no kernel, 100 parcels for every tag. fire_punjab at the Delhi cell is now non-zero in all 144 hours. Window means rose because each frame now averages over the hour including that hour's fresh release (parcels aged 0 to 50 minutes, still concentrated near their sources), where the old whole-hour snapshot saw parcels at least an hour old.

Plain statement of sampling uncertainty: every value is estimated from a finite number of parcels, so it carries sampling noise as well as model error. A residual hour-to-hour scatter of roughly 15-25 % at these cells (the CV column) is mostly sampling noise; small contributions (a few µg/m³, or tags far from a city) are less reliable than large local ones; the kernel spreads aged parcels over 10-25 km, so sharp gradients from distant sources are blurred by design. Differences between hours or between tags smaller than about a quarter of the value should not be interpreted.

### Sanity check, not tuned against anything
Simulated dry PM2.5 (hour mean, sum over all tags) at the Delhi cell (ix 112, iy 226). Directly emitted PM2.5 only, no background or secondary aerosol; nothing was adjusted in response to these numbers.

| Hour starting (UTC) | PM2.5 µg/m³ | top three tags |
|---|---|---|
| 11-03 00Z | 272.2 | industry_delhi_ncr 117.6, residential_delhi_ncr 63.7, fire_punjab 61.5 |
| 11-03 06Z | 24.3 | industry_delhi_ncr 10.6, residential_delhi_ncr 7.8, fire_punjab 4.5 |
| 11-03 12Z | 213.5 | residential_delhi_ncr 110.0, industry_delhi_ncr 84.7, fire_punjab 10.9 |
| 11-05 00Z | 208.9 | industry_delhi_ncr 78.9, residential_delhi_ncr 59.9, fire_punjab 49.6 |
| 11-06 00Z | 307.9 | industry_delhi_ncr 148.7, residential_delhi_ncr 133.8, industry_haryana 12.1 |
| 11-08 23Z | 248.1 | residential_delhi_ncr 88.7, industry_delhi_ncr 88.4, fire_punjab 44.8 |

Window mean 147.3 µg/m³; top contributors over the window: industry_delhi_ncr 65.2, residential_delhi_ncr 58.0, fire_punjab 9.7. The diurnal swing (night peaks, midday lows) follows the mixing height. Vehicles do not reach the top three, consistent with EDGAR's small road-transport total (see the inventory caveats above).

### History
Version 1 (first commit of this task) used whole-hour snapshots and no kernel. With 200 parcels for every tag the simulation stage took 128 s (cold wall 158.6 s; `MetField.sample` 82 s of it), so the default was lowered to 100 (warm wall 68.7 s, peak 215,047 parcels). That run's sampling noise (table above, "before") led to the current configuration.
