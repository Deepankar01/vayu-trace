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

### Current configuration (format version 3)
- Frames are trapezoid hour means over the seven states in an hour: 1/2 weight on the post-release state at the start, 1 on each of the five intermediate states, 1/2 on the state after the sixth step, divided by 6.
- Each tag's mass grid is smoothed with the age-dependent box kernel: none under 6 h, 3 x 3 from 6 to 24 h, 5 x 5 beyond.
- Parcels per tag-hour are 100, or 400 for the four `*_rest_of_india` sector tags (3 of them emit; dust has no data).
- `MetField.sample` has a faster path for a single sample time.
- The seven terrain look-ups in each step share their cell-index computations. `step` output is bit-identical to before, and a test asserts it.

| Stage | warm cache |
|---|---|
| fetching fires + inventory | 0.3 s |
| fetching weather (Open-Meteo archive, 22 batches, 193 hours) | 0.4 s |
| terrain | 0.0 s |
| simulating + writing frames | 52.8 s |
| **wall** | **53.5 s** |

Profile of the simulation stage (cProfile, 58.8 s):

| Component | Time |
|---|---|
| `particles.step` | 33.0 s |
| `MetField.sample` | 13.6 s |
| terrain look-ups (`_grounds`) | 7.7 s, was 30 s |
| building frames | 11.7 s |
| fire-age weighted median (within frame building) | 4.6 s |
| zlib frame compression | 7.7 s |

Machine load varies a lot between measurements here; another job was running in parallel. The previous round's 114 s profile had zlib at 13.7 s and `sample` at 23 s. That code did not change, so those components ran faster this time, not because of an optimisation. Expect variance of tens of percent between runs on this machine.

Peak live parcels 286,987. Dropped parcels over the run: left the domain 12,277; depleted below 1 % of release mass 334,929; missing met 0. These match the previous round exactly, as expected from a bit-identical `step`. `blh_estimated` is false: the archive returned `boundary_layer_height` for every lattice point and hour of this 2023 window.

Cold first run of a new date: the free Open-Meteo archive answers HTTP 429 when all 22 full-domain batches are requested at once, and the client's backoff (1+2+4+8+16 s) does not outlast it. A retry a minute or so later completes from the partly filled cache; with a cold weather cache the previous round measured 12.6 s for the fetch. Changing the requested hours changes every cache key and triggers this again. The terrain tiles add 20 s once per installation.

Most parcels end by depletion, not by leaving the domain. With mixing heights near the 100 m floor at night, dry deposition at 0.2 cm/s removes about 7 % of a parcel's mass per hour, so parcels fall below 1 % of their release mass within a few days.

### Sampling noise and how far to trust the numbers
Measured from the stored runs at four city cells:
- **Dominant tag**: the tag with the largest window-mean concentration there.
- **Zero hours**: the share of the 144 hours in which that tag's value is exactly zero.
- **CV vs 3 h**: the standard deviation of (hourly total minus its centred 3-hour running mean), divided by the mean of the running mean. Lower is smoother.

Columns: v1 = whole-hour snapshot, no kernel, 100 parcels for every tag; v2 = left-point hour mean, kernel, 100/400 parcels; v3 = current, trapezoid hour mean.

| City (cell) | dominant tag | zero hours v1 / v2 / v3 | CV vs 3 h v1 / v2 / v3 | window mean v1 / v2 / v3, µg/m³ |
|---|---|---|---|---|
| Delhi (77.21 E, 28.61 N) | industry_delhi_ncr | 0 / 0 / 0 % | 0.18 / 0.15 / 0.14 | 114.1 / 147.3 / 142.6 |
| Patna (85.14 E, 25.61 N) | residential_bihar | 8.3 / 0 / 0 % | 0.36 / 0.20 / 0.20 | 43.0 / 43.5 / 42.6 |
| Lucknow (80.95 E, 26.85 N) | residential_uttar_pradesh | 10.4 / 0 / 0 % | 0.45 / 0.26 / 0.27 | 29.3 / 41.2 / 39.1 |
| Mumbai (72.88 E, 19.08 N) | industry_rest_of_india | 45.8 / 0 / 0 % | 0.86 / 0.24 / 0.23 | 95.0 / 115.9 / 111.5 |

fire_punjab at the Delhi cell is non-zero in all 144 hours.

Why the window means changed:
- v1 to v2: means rose because hour means include each hour's own fresh release (parcels still concentrated near their sources), which a whole-hour snapshot never saw.
- v2 to v3: means fell by 2-5 % because the left-point average overweighted that fresh release by about dt / (2 tau) for a residence time tau. The trapezoid rule removes that bias.

Sampling uncertainty, in plain words. Every value is estimated from a finite number of parcels, so it carries sampling noise on top of model error.
- Hourly source shares are good to about ±5 percentage points at Delhi, and to about ±10-15 percentage points at Lucknow and Mumbai.
- When two sources' shares are within that margin of each other, their order is not resolved hourly. Do not say one is larger than the other.
- Present sources below about 5 % of the total as "minor", not as a number.
- For finer comparisons, use 3-6 hour or daily means. The hour-to-hour scatter (CV column) of roughly 15-25 % is mostly sampling noise and averages down.
- The kernel spreads aged parcels over 10-25 km, so sharp gradients from distant sources are blurred by design.

### Sanity check, not tuned against anything
Simulated dry PM2.5 (trapezoid hour mean, sum over all tags) at the Delhi cell (ix 112, iy 226). Directly emitted PM2.5 only, no background or secondary aerosol; nothing was adjusted in response to these numbers.

| Hour starting (UTC) | PM2.5 µg/m³ | top three tags |
|---|---|---|
| 11-03 00Z | 267.6 | industry_delhi_ncr 113.0, residential_delhi_ncr 63.9, fire_punjab 61.5 |
| 11-03 06Z | 23.4 | industry_delhi_ncr 10.0, residential_delhi_ncr 7.6, fire_punjab 4.4 |
| 11-03 12Z | 198.1 | residential_delhi_ncr 101.2, industry_delhi_ncr 78.3, fire_punjab 10.9 |
| 11-05 00Z | 205.2 | industry_delhi_ncr 75.2, residential_delhi_ncr 60.1, fire_punjab 49.7 |
| 11-06 00Z | 302.0 | industry_delhi_ncr 146.6, residential_delhi_ncr 130.1, industry_haryana 11.9 |
| 11-08 23Z | 234.1 | residential_delhi_ncr 84.4, industry_delhi_ncr 78.8, fire_punjab 45.0 |

Window mean 142.6 µg/m³; top contributors over the window: industry_delhi_ncr 62.9, residential_delhi_ncr 55.6, fire_punjab 9.7.
- The diurnal swing (night peaks, midday lows) follows the mixing height.
- Vehicles do not reach the top three, consistent with EDGAR's small road-transport total (see the inventory caveats above).

### History
- **Version 1** used whole-hour snapshots and no kernel. With 200 parcels for every tag, the simulation stage took 128 s (cold wall 158.6 s, of which `MetField.sample` was 82 s), so the default was lowered to 100 (warm wall 68.7 s, peak 215,047 parcels).
- **Version 2** added left-point hour means, the kernel, the 400-parcel rest_of_india budget and the met fast path, at a warm wall of 114.1 s, measured under heavier machine load.
- **Version 3** changed to trapezoid hour means and faster terrain look-ups, at a warm wall of 53.5 s.

## Measured data coverage (`server/vayu/clients/openaq.py`, Task 16)

### The CPCB gap in OpenAQ
CPCB-provider PM2.5 in OpenAQ v3 runs to about October 2022 and starts again on 2025-02-18; dates in between return no measurements (all hours NaN, station count 0). The `caaqm` provider is not used: its Delhi sensors also end by 2022-10-31 and it would duplicate sites. Consequences:
- November 2023, the episode the design named for validation, cannot be validated. The validation episode is **2025-11-03 to 2025-11-09** instead.
- `MIN_DATE` stays **2018-04-01** (fires from two VIIRS satellites from then on). It is not raised to the start of measured data: a replay without measurements is still a valid simulation, and the UI says "No CPCB data for these dates". The plan's rule ("the earliest year in which at least 10 northern cities have CPCB data") was not applied for this reason, and was not evaluated year by year.

### Validation week coverage (2025-11-03 00Z to 2025-11-09 23Z, 168 hours)
All 28 northern cities have CPCB data that week. Stations are those `city_pm25` used (up to 5 within 25 km that reported in the window); hours are UTC hours with an overlap-aligned measured value.

| city | CPCB stations used | hours with a measured value (of 168) |
|---|---|---|
| Delhi | 5 | 149 |
| Gurugram | 5 | 149 |
| Noida | 5 | 149 |
| Ghaziabad | 5 | 149 |
| Faridabad | 5 | 149 |
| Amritsar | 1 | 148 |
| Ludhiana | 1 | 139 |
| Jalandhar | 1 | 148 |
| Patiala | 1 | 144 |
| Bathinda | 1 | 142 |
| Chandigarh | 5 | 149 |
| Ambala | 1 | 148 |
| Hisar | 1 | 147 |
| Rohtak | 1 | 120 |
| Karnal | 1 | 147 |
| Panipat | 1 | 138 |
| Meerut | 3 | 149 |
| Agra | 5 | 149 |
| Kanpur | 3 | 149 |
| Lucknow | 5 | 149 |
| Prayagraj | 3 | 149 |
| Varanasi | 4 | 149 |
| Gorakhpur | 1 | 141 |
| Bareilly | 2 | 148 |
| Moradabad | 5 | 149 |
| Patna | 5 | 149 |
| Gaya | 3 | 149 |
| Muzaffarpur | 3 | 149 |

The validation generator compares the missing-hour sets of all 28 cities: 19 hours are missing in every city (11-03 06Z-07Z, 11-03 15Z to 11-04 03Z, 11-04 06Z-07Z and 11-06 10Z-11Z), and 16 cities miss exactly those 19; the other 12 miss further hours of their own (Rohtak 29 more, Panipat 11, Ludhiana 10, Gorakhpur 8, Bathinda 7, Patiala 5, Hisar 2, Karnal 2, Amritsar, Jalandhar, Ambala and Bareilly 1 each). Hours missing in every city point at the CPCB feed or its ingestion into OpenAQ, not at single monitors. Missing hours are left missing, not filled.

### Mixing height in the Open-Meteo archive by year
Checked on 2026-11-11 with `fetch_met` for one UTC day each over the whole 33 x 33 lattice (24 hours, all 1089 points): the archive returned `boundary_layer_height` for every point and hour on **2018-11-05** (range 10-4775 m) and on **2023-11-05** (range 10-3720 m); temperature was complete too. For these two dates the archive returned real `boundary_layer_height` at every lattice point and hour; other dates were not checked. Wherever the archive returns null, `MetField` falls back to the time-of-day estimate from temperature and wind (`estimate_blh`), the run records `blh_estimated`, and the UI marks the mixing height "est.". (The raw minimum of 10 m is below `BLH_MIN_M`, the 100 m floor the model applies.) The fetch took several minutes because the free archive answered HTTP 429 to part of the 22 batches and the client backed off.
