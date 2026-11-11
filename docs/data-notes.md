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
