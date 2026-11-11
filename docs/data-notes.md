# Data notes

## India states boundary (`server/vayu/assets/india-states.geojson`)

- Source: https://github.com/datta07/INDIAN-SHAPEFILES, file `INDIA/INDIA_STATES.geojson` (37 state and union-territory polygons; census-style attributes `STNAME_SH` etc.).
- Licence: MIT (repository LICENSE).
- Depiction: follows the official Government of India / Survey of India outline. Jammu & Kashmir includes Pakistan-occupied Kashmir (west to 73.39 E) and Ladakh includes Aksai Chin (north to 37.08 N, east to 80.33 E); Arunachal Pradesh is shown in full (to 97.41 E).
- Processing: kept only the state name (property `name`, from `STNAME_SH`); geometry repaired with `buffer(0)`, simplified with Douglas-Peucker tolerance 0.01 degree (topology preserved), coordinates rounded to 3 decimals. About 300 KB. Source file was about 2.2 MB.
- The source README says some data reflects 2019 boundaries and asks users to verify for legal purposes; this is used for 0.1 degree rasterisation and a map line only.
- Used for: `region_mask()` / `fire_state_mask()` (cell centres tested with `shapely.contains_xy`), and the web map in Task 12.
