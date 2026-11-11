# India Pollution Transport Simulator Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A locally run web app that simulates PM2.5 transport across India from satellite fire detections and inventory emissions, and shows per-city source breakdown, travel time and model-vs-measured error.

**Architecture:** A Python server fetches and caches fires, weather, terrain and emissions, runs a single-layer Lagrangian particle model with one tag per source, and serves hourly per-tag concentration grids plus per-city series. A React app draws the map and composes the per-tag grids with slider weights in the browser, so slider changes never re-run the model.

**Tech Stack:** Python 3.11+, FastAPI, NumPy, httpx, pytest. React 18, TypeScript, Vite, MapLibre GL JS, deck.gl, zustand, vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-pollution-transport-simulator-design.md` — section 7.6 overrides earlier sections where they conflict.

## Global Constraints

- API keys live in `.env` (`FIRMS_MAP_KEY`, `OPENAQ_API_KEY`, `DATA_GOV_IN_API_KEY`), are read server-side only, and never appear in browser bundles, logs, fixtures or commits. Scrub keys from recorded fixtures.
- No parameter is fitted to CPCB or Copernicus data. One global parameter set for all cities and dates.
- The model reports directly emitted PM2.5 only. There is no modelled background term.
- The value compared with CPCB is dry PM2.5. Humidity growth applies only to the separate "haze" quantity.
- Forecast hours are visually distinct wherever they appear, and the UI states "forecast assumes fires continue at recent levels".
- Missing data is shown as missing, never interpolated or zero-filled.
- Fire label is "Fires (satellite)". Dust label is "Road and construction dust". Gap label is "Not explained by model".
- AQI is labelled as PM2.5-based.
- India's boundaries follow the official Government of India depiction.
- Data clients are tested against recorded responses, never live services.
- Every physical constant in `vayu/constants.py` carries a comment citing its source.
- All times are UTC internally; the UI displays IST.

## Deviation from spec, for the user to confirm

Spec 7.5 defines a city's path as "the mean track of parcels present at the city". Keeping every parcel's history is too heavy for a laptop run. This plan draws the path as a 72-hour wind back-trajectory from the city (the standard HYSPLIT-style product). Travel time still comes from parcel age as specified.

## Review Focus

1. A date with no fire detections (e.g. July): the run completes, fire tags are zero, breakdown has no NaN. → Task 5, Task 10.
2. A city with no CPCB stations or a measurement gap: the "Not explained by model" row and error figure are absent, not zero. → Task 10, Task 15.
3. An upstream service fails or rate-limits (Open-Meteo 429, FIRMS 5xx): the run ends in `error` with a readable message and the UI shows it instead of spinning. → Task 3, Task 11, Task 13.
4. A date before the supported floor or after today: rejected with a clear message; the date picker cannot select it. → Task 11, Task 15.
5. All sliders at 0%: simulated PM2.5 is 0, AQI is 0, percentages render as "–" rather than NaN. → Task 10, Task 13.

---

## File Structure

```
server/
  pyproject.toml
  vayu/
    constants.py        physical constants and tunables, each cited
    domain.py           grid, regions, sectors, tag ids
    aqi.py              CPCB PM2.5 sub-index
    cache.py            disk cache for upstream responses and results
    clients/firms.py    NASA FIRMS
    clients/openmeteo.py weather + CAMS
    clients/openaq.py   CPCB history
    clients/datagov.py  CPCB live
    met.py              MetField: interpolation in space and time
    terrain.py          elevation grid from Terrarium tiles
    emissions/fires.py  detections -> tagged hourly emissions
    emissions/inventory.py  gridded inventory -> tagged hourly emissions
    emissions/dropped.py    user-placed sources
    sim/particles.py    one time step for a particle set
    sim/run.py          orchestration, gridding, caching, progress
    receptors.py        cities, breakdown, travel time, arrival, back-trajectory
    encode.py           binary frame format
    api.py              FastAPI app
    validate.py         validation report
  tests/                mirrors vayu/, plus tests/fixtures/
  data/                 git-ignored: cache/, inventory/, runs/
web/
  src/api/              client.ts, decode.ts, types.ts
  src/state/store.ts    zustand store
  src/lib/              compose.ts, aqi.ts, colors.ts, format.ts
  src/map/              MapView.tsx, layers/*.ts
  src/panels/           TopBar, SourcesPanel, CityPanel, Timeline, DropSourceDialog, ValidationDialog
  public/india-boundary.geojson
Makefile
README.md
```

---

### Task 1: Repository, domain model, AQI

**Files:**
- Create: `server/pyproject.toml`, `server/vayu/__init__.py`, `server/vayu/constants.py`, `server/vayu/domain.py`, `server/vayu/aqi.py`, `Makefile`
- Modify: `.gitignore` (add `server/data/`, `.venv/`, `node_modules/`, `__pycache__/`, `web/dist/`)
- Test: `server/tests/test_domain.py`, `server/tests/test_aqi.py`

**Interfaces:**
- Produces, in `domain.py`:
  - `LON_MIN=66.0, LON_MAX=98.0, LAT_MIN=6.0, LAT_MAX=38.0, CELL=0.1, NX=320, NY=320`
  - `REGIONS = ("delhi_ncr","punjab","haryana","uttar_pradesh","bihar","rest_of_india")`
  - `SECTORS = ("vehicles","industry","dust","residential")`
  - `FIRE_STATES = ("punjab","haryana","uttar_pradesh","madhya_pradesh","other")`
  - `TAGS: tuple[Tag, ...]` — 34 tags: `fire_{state}` (observed), `firefc_{state}` (persistence assumption), `{sector}_{region}`. `Tag(id: str, kind: Literal["fire","firefc","sector","user"], sector: str|None, region: str, label: str, color: str)`.
  - `cell_index(lon, lat) -> tuple[np.ndarray, np.ndarray]` (ix, iy; −1 outside), `cell_center(ix, iy)`, `cell_area_m2() -> np.ndarray (NY,)`
  - `region_mask() -> np.ndarray (NY,NX) int8` indexing `REGIONS`; `fire_state_mask() -> np.ndarray (NY,NX) int8` indexing `FIRE_STATES`. Delhi NCR is every cell within 50 km of (28.61 N, 77.21 E) and takes precedence over the state. State polygons come from `server/vayu/assets/india-states.geojson`, which this task obtains: find a GeoJSON matching the official Survey of India depiction (national outline plus states) and record its source and licence in `docs/data-notes.md`. Task 12 reuses the same file for the map.
- Produces, in `aqi.py`: `pm25_to_aqi(pm25_24h: np.ndarray | float) -> np.ndarray | float`, `aqi_category(aqi: float) -> str` with CPCB names (Good, Satisfactory, Moderate, Poor, Very Poor, Severe).

- [ ] **Step 1:** `git init`; create the Python project with a `dev` extra (pytest, pytest-asyncio, respx, ruff). `make test` runs `pytest server/tests` and, once it exists, `npm --prefix web test`.
- [ ] **Step 2: Write failing tests**

```python
# test_aqi.py — CPCB PM2.5 24-hour breakpoints, linear inside each band
@pytest.mark.parametrize("pm,aqi", [(0,0),(30,50),(60,100),(90,200),(120,300),(250,400),(380,500),(1000,500),(45,75)])
def test_breakpoints(pm, aqi): assert round(pm25_to_aqi(pm)) == aqi
def test_nan_passes_through(): assert np.isnan(pm25_to_aqi(float("nan")))

# test_domain.py
def test_tag_count(): assert len(TAGS) == 34 and len({t.id for t in TAGS}) == 34
def test_cell_index_corners():
    ix, iy = cell_index(np.array([66.0, 97.99, 65.9]), np.array([6.0, 37.99, 10.0]))
    assert list(ix) == [0, 319, -1] and list(iy)[:2] == [0, 319]
def test_delhi_is_ncr(): assert REGIONS[region_mask()[cell_index(77.21, 28.61)[::-1]]] == "delhi_ncr"
def test_ludhiana_is_punjab(): assert REGIONS[region_mask()[cell_index(75.85, 30.90)[::-1]]] == "punjab"
def test_chennai_is_rest(): assert REGIONS[region_mask()[cell_index(80.27, 13.08)[::-1]]] == "rest_of_india"
```

- [ ] **Step 3:** Run `pytest server/tests -v`; expect import failures.
- [ ] **Step 4:** Implement `domain.py` and `aqi.py`. Above 250 µg/m³: `400 + (pm − 250) × 100 / 130`, capped at 500.
- [ ] **Step 5:** Run tests; expect PASS. Commit `chore: scaffold server, domain grid and CPCB AQI`.

---

### Task 2: Disk cache and FIRMS client

**Files:**
- Create: `server/vayu/cache.py`, `server/vayu/clients/firms.py`, `server/scripts/record_fixtures.py`
- Test: `server/tests/test_cache.py`, `server/tests/clients/test_firms.py`, fixtures under `server/tests/fixtures/firms/`

**Interfaces:**
- Produces: `cache.cached_bytes(namespace: str, key: str, fetch: Callable[[], bytes], ttl_s: float | None = None) -> bytes` storing under `server/data/cache/{namespace}/{sha1(key)}`.
- Produces: `firms.availability() -> dict[str, tuple[date, date]]`
- Produces: `firms.detections(day: date) -> Detections` where `Detections` is a dataclass of equal-length arrays `lon, lat, frp_mw, acq_utc (datetime64[m]), is_day (bool), satellite (str)`; domain bbox only.
- Product rule: for each of SNPP, NOAA-20, NOAA-21 use `_SP` if `day` is inside its availability range, else `_NRT` if inside that range, else skip. Keep only `type == 0` for `_SP`. For `_NRT`, drop detections in 0.01° cells that fired on 20 or more of the previous 30 days (static sources); the 30-day history is itself cached.
- Errors: non-200 or body `Invalid MAP_KEY.` raises `UpstreamError(service="firms", message=...)`, defined in `vayu/errors.py`.

- [ ] **Step 1:** Write `record_fixtures.py firms` that saves the availability CSV and the Punjab-box (73,28,78,33) `VIIRS_SNPP_SP` CSV for 2023-11-05 with the key removed from any stored URL. Run it once.
- [ ] **Step 2: Write failing tests** (respx-mocked): `test_parses_punjab_2023` asserts 3,777 rows, all `frp_mw > 0`, all inside the bbox; `test_prefers_sp_inside_range` and `test_falls_back_to_nrt` assert the requested product per satellite for 2023-11-05 and 2026-11-10 given the recorded availability; `test_skips_stale_satellite` asserts SNPP is not requested for 2026-11-10; `test_invalid_key_raises`; `test_cache_hits_once` asserts `fetch` is called once across two calls.
- [ ] **Step 3:** Run; expect FAIL. Implement. Run; expect PASS.
- [ ] **Step 4:** Commit `feat: disk cache and FIRMS client`.

---

### Task 3: Weather client and MetField

**Files:**
- Create: `server/vayu/clients/openmeteo.py`, `server/vayu/met.py`
- Test: `server/tests/clients/test_openmeteo.py`, `server/tests/test_met.py`

**Interfaces:**
- Constants: `MET_STEP_DEG = 1.0` (33×33 lattice), `MET_BATCH = 50` coordinates per request, `WIND_BLEND_100M = 0.7`, `BLH_MIN_M = 100`, `BLH_MAX_M = 4000`.
- Produces: `openmeteo.fetch_met(start: datetime, hours: int, now: datetime) -> MetRaw` — archive API for hours older than 5 days before `now`, forecast API (`past_days` + `forecast_days`) otherwise. On HTTP 429 retry with exponential backoff up to 5 times, then raise `UpstreamError`.
- Produces: `openmeteo.fetch_cams_pm25(lat, lon, start, hours) -> np.ndarray (hours,)` with NaN where null.
- Produces: `MetField(raw)` with `.sample(lon, lat, t_hours) -> MetSample(u, v, blh, rh, temp_c, precip_mm_h)` (arrays shaped like `lon`; bilinear in space, linear in time; `u`,`v` in m/s from the blended wind), `.grid(hour: int) -> dict[str, np.ndarray (33,33)]`, and `.blh_estimated: bool`.
- Produces: `estimate_blh(local_hour, temp_c, wind_ms) -> np.ndarray`, used only where `boundary_layer_height` is null; sets `blh_estimated`.

- [ ] **Step 1:** Record fixtures for one archive batch (2023-11-05) and one forecast batch.
- [ ] **Step 2: Write failing tests:** `test_wind_components` — speed 10 km/h from direction 270° gives `u ≈ +2.78, v ≈ 0`; `test_blend` — 10 m at 0 and 100 m at 10 m/s gives 7 m/s; `test_bilinear_midpoint`; `test_time_interpolation_half_hour`; `test_blh_clamped` (50 → 100, 9000 → 4000); `test_null_blh_uses_estimate_and_flags`; `test_429_then_success_retries`; `test_429_exhausted_raises_upstream_error`; `test_archive_vs_forecast_split` for a window straddling `now − 5 days`.
- [ ] **Step 3:** Run; FAIL. Implement. Run; PASS. Commit `feat: weather client and MetField`.

---

### Task 4: Terrain grid

**Files:**
- Create: `server/vayu/terrain.py`
- Test: `server/tests/test_terrain.py`

**Interfaces:**
- Produces: `terrain.elevation() -> np.ndarray (NY,NX) float32` metres, built from zoom-6 Terrarium tiles (`elevation = R*256 + G + B/256 − 32768`), averaged to the 0.1° grid, cached as `server/data/cache/terrain.npy`. Add Pillow as a dependency.

- [ ] **Step 1: Write failing tests** with two recorded tiles: `test_decode_terrarium` on a hand-built 2×2 PNG; `test_delhi_low` (150–300 m); `test_himalaya_high` (cell at 79.0 E, 31.0 N above 3,000 m); `test_sea_is_zero_or_below`.
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS. Commit `feat: terrain elevation grid`.

---

### Task 5: Fire emissions

**Files:**
- Create: `server/vayu/emissions/fires.py`; extend `constants.py`
- Test: `server/tests/emissions/test_fires.py`

**Interfaces:**
- Consumes: `firms.detections`, `domain.fire_state_mask`.
- Constants (cite each): `FIRE_PEAK_HOUR_IST = 14.5`, `FIRE_SIGMA_H = 2.5`, `BIOMASS_KG_PER_MJ = 0.368` (Wooster et al. 2005), `EF_PM25_CROP_G_PER_KG` and `EF_PM25_VEG_G_PER_KG` (Akagi et al. 2011 or Andreae 2019 — take the published values, do not adjust), `CROP_STATES = ("punjab","haryana","uttar_pradesh","madhya_pradesh")`, `FIRE_SCALING_DEFAULT = 1.0` (no correction; README cites the small-fire under-detection literature).
- Produces, in `server/vayu/emissions/__init__.py`: `Emissions`, a sparse container (dense arrays for all tags and hours would not fit in memory). `Emissions.tags -> list[str]`; `Emissions.hour(tag_id, h) -> tuple[iy, ix, kg]` (arrays of non-zero cells, kg PM2.5 in that hour); `Emissions.add(tag_id, h, iy, ix, kg)`; `Emissions.set_constant(tag_id, grid: np.ndarray (NY,NX))` for time-invariant sources; `Emissions.merge(other)`; `Emissions.scaled(factor)`.
- Produces: `fire_emissions(start: datetime, hours: int, now: datetime) -> Emissions`.
- Per satellite and day: sum daytime FRP per cell; divide by the profile value at the detection time; average across satellites that observed that day (not sum). Daily energy `= FRP_peak × sqrt(2π) × σ × 3600` MJ. Spread over the day with the Gaussian profile. If a cell has only night detections use them with the profile value floored at 0.05.
- Hours after `now`, and hours of the current incomplete UTC day, use the mean of the last three complete days and go to `firefc_{state}` tags. Observed hours go to `fire_{state}`.

- [ ] **Step 1: Write failing tests:** `test_single_fire_mass` — one 10 MW daytime detection at profile peak yields `10 × 2.5066 × 2.5 × 3600 × 0.368 × EF / 1000` kg over 24 h within 1%; `test_two_satellites_average_not_sum`; `test_profile_peaks_at_0900_utc` (14:30 IST); `test_tagged_by_state` (Ludhiana → `fire_punjab`, a fire at 85 E 20 N → `fire_other` with the vegetation factor); `test_forecast_hours_use_three_day_mean_in_firefc_tags`; `test_no_detections_gives_zero_arrays` (Review Focus 1).
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS. Commit `feat: fire emissions from FRP`.

---

### Task 6: Inventory emissions

**Files:**
- Create: `server/scripts/fetch_inventory.py`, `server/vayu/emissions/inventory.py`, `docs/data-notes.md`
- Test: `server/tests/emissions/test_inventory.py`

**Interfaces:**
- Produces: `inventory_emissions() -> Emissions` (see Task 5) holding one constant grid, in kg PM2.5 per hour at the annual mean rate, for each of the 24 `{sector}_{region}` tags; and `inventory_notes() -> dict` with `source`, `year`, `dust_available: bool`.

- [ ] **Step 1: Inspect the data before writing code.** Download EDGAR v8.1 PM2.5 gridded sector files (0.1°) and open the Zenodo record for ESSD 2023-310. Record in `docs/data-notes.md`: file names, units, sector codes, sizes, licence, and whether either carries a road or construction dust field.
- [ ] **Step 2:** Fix the mapping in `docs/data-notes.md`: vehicles ← road transport; industry ← power + manufacturing + refineries; residential ← residential and commercial combustion; dust ← the India inventory's dust sector if one exists, otherwise zeros with `dust_available = False`. Do not construct a proxy.
- [ ] **Step 3: Write failing tests** on a tiny synthetic NetCDF: `test_unit_conversion` (kg m⁻² s⁻¹ × cell area × 3600); `test_split_by_region_conserves_mass` (sum over regions equals sector total inside India; cells outside India are dropped); `test_dust_zero_when_unavailable`; `test_all_24_tags_present`.
- [ ] **Step 4:** Run; FAIL. Implement, cropping to the domain and caching the result as `.npz`. Run; PASS. Commit `feat: inventory emissions by sector and region`.

---

### Task 7: Particle step

**Files:**
- Create: `server/vayu/sim/particles.py`; extend `constants.py`
- Test: `server/tests/sim/test_particles.py`

**Interfaces:**
- Constants (cite each): `DT_S = 600`, `K_H_M2_S = 3000`, `V_DEP_M_S = 0.002`, `WASHOUT_A = 8.4e-5`, `WASHOUT_B = 0.79`, `Z_RELAX_S = 21600`.
- Produces: `Particles` dataclass of arrays `lon, lat, mass_kg, age_s, z_m, tag (int16)`; `Particles.concat`, `Particles.keep(mask)`.
- Produces: `step(p: Particles, met: MetField, elev: np.ndarray, t_hours: float, rng: np.random.Generator, *, deposition: bool = True) -> Particles`.

Algorithm, in order:
1. Sample met at each parcel. Proposed move: `dx = u·DT + N(0, sqrt(2·K_H·DT))`, same for `dy`; convert metres to degrees at the parcel's latitude.
2. Blocking: a move is refused if `elev(new) > z_m + blh/2`. Try the full move, then x-only, then y-only, else stay.
3. `z_m` relaxes toward `elev(pos) + blh/2` with time constant `Z_RELAX_S`. Parcels are released with `z_m = elev + blh/2`.
4. If `deposition`: `mass *= exp(−(V_DEP/blh + WASHOUT_A · precip^WASHOUT_B) · DT)`.
5. `age_s += DT`. Drop parcels outside the domain or below 1% of release mass.

- [ ] **Step 1: Write failing tests** with stub `MetField` objects: `test_uniform_wind_distance` — 5 m/s westerly, `K_H` patched to 0, 6 steps: mean eastward displacement 18 km ±1%, no northward drift; `test_mass_conserved_without_deposition` (exact); `test_dry_deposition_rate` — blh 500 m, 1 h: mass ratio `exp(−0.002·3600/500)` within 0.1%; `test_rain_removes_more`; `test_wall_blocks` — elevation step to 3,000 m, blh 500 m, wind toward the wall for 24 h: no parcel beyond the wall; `test_gentle_slope_passes` — 1,000 m rise over 500 km is crossed; `test_diffusion_variance` — zero wind, variance after 1 h ≈ `2·K_H·3600` within 5% (20,000 parcels); `test_leaves_domain_dropped`; `test_seeded_rng_is_deterministic`.
- [ ] **Step 2:** Run; FAIL. Implement, fully vectorised. Run; PASS. Commit `feat: particle transport step`.

---

### Task 8: Run orchestration and gridding

**Files:**
- Create: `server/vayu/sim/run.py`
- Test: `server/tests/sim/test_run.py`

**Interfaces:**
- Consumes: Tasks 3–7.
- Constants: `WINDOW_H = 144`, `SPINUP_H = 48`, `PARTICLES_PER_TAG_HOUR = 200`.
- Window: for a past date `D`, hours start at `D−2 00:00 UTC`; when `D` is today, at `D−3 00:00 UTC`. `forecast_from` is the first hour index later than `now`, or `None`.
- Produces: `run_window(date) -> tuple[datetime, int | None]`.
- Produces: `simulate(emissions: Emissions, met: MetField, elev, start, hours, out_dir: Path, *, seed=0, progress: Callable[[float, str], None] = noop) -> RunResult`. All tags for all hours do not fit in memory (34 × 144 × 320 × 320 floats), so each hour is written to `out_dir` as it is gridded and `RunResult` reads lazily: `RunResult.hours: int`, `.tags: list[str]`, `.frame(h) -> dict[tag_id, np.ndarray (NY,NX) float32]` (dry PM2.5, µg/m³), `.haze(h) -> np.ndarray (NY,NX)`, `.fire_age_h(h) -> np.ndarray (NY,NX)` (mass-weighted median age of `fire_*`/`firefc_*` parcels, NaN where none).
- Produces: `run_date(date, now, progress) -> RunResult`, stored under `server/data/runs/{date}/`; `load_run(date) -> RunResult | None`.
- Release: each hour, per tag, draw `PARTICLES_PER_TAG_HOUR` parcels from cells with probability proportional to emission, each carrying equal mass; skip tags with zero emission that hour.
- Gridding at each whole hour: `conc = Σ mass / (cell_area · blh_cell) × 1e9`. Haze factor `f(RH) = 1 + 0.25·RH²/(1−RH)` with RH capped at 0.95 (cite).

- [ ] **Step 1: Write failing tests:** `test_window_past_date` (2023-11-05 → start 2023-11-03T00Z, no forecast); `test_window_today` (start today−3, `forecast_from` = hours since start + 1); `test_concentration_units` — 1 kg in one cell, blh 500 m → `1e9 / (area × 500)` µg/m³; `test_linearity` — same seed, emissions ×2 gives fields ×2 exactly (this is what makes browser rescaling valid); `test_spinup_not_in_output` (output has exactly `hours` frames); `test_zero_emission_tag_is_zero_field`; `test_progress_monotonic_and_ends_at_1`; `test_cached_second_call_does_not_simulate`.
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS.
- [ ] **Step 3:** Time a real run for 2023-11-05 and record wall time in `docs/data-notes.md`. If above 90 s, lower `PARTICLES_PER_TAG_HOUR` or merge sectors for `rest_of_india`, per spec 7.6. Commit `feat: simulation run and gridding`.

---

### Task 9: Measured-data clients

**Files:**
- Create: `server/vayu/clients/openaq.py`, `server/vayu/clients/datagov.py`, `server/vayu/cities.py`
- Test: `server/tests/clients/test_openaq.py`, `server/tests/clients/test_datagov.py`

**Interfaces:**
- Produces: `cities.CITIES: tuple[City, ...]` with `City(id, name, lat, lon)` for: Delhi, Gurugram, Noida, Ghaziabad, Faridabad, Amritsar, Ludhiana, Jalandhar, Patiala, Bathinda, Chandigarh, Ambala, Hisar, Rohtak, Karnal, Panipat, Meerut, Agra, Kanpur, Lucknow, Prayagraj, Varanasi, Gorakhpur, Bareilly, Moradabad, Patna, Gaya, Muzaffarpur, Jaipur, Jodhpur, Bhopal, Indore, Ahmedabad, Mumbai, Pune, Hyderabad, Bengaluru, Chennai, Kolkata, Guwahati.
- Produces: `openaq.city_pm25(city: City, start: datetime, hours: int) -> MeasuredSeries(values: np.ndarray (hours,) with NaN gaps, station_count: int)` — hourly median across up to 5 CPCB-provider PM2.5 sensors within 25 km. Respect the rate limit (read it from response headers); cache per city and day.
- Produces: `datagov.live_pm25(city: City) -> float | None` — latest PM2.5 average across the city's stations from resource `3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69`.

- [ ] **Step 1:** Record fixtures (Delhi locations, one sensor's hours for 2023-11-05, one data.gov.in page), keys scrubbed.
- [ ] **Step 2: Write failing tests:** `test_median_across_stations`; `test_gap_is_nan`; `test_no_stations_returns_all_nan_and_zero_count`; `test_only_cpcb_provider_used`; `test_live_value_parsed`; `test_live_missing_city_returns_none`; `test_401_raises_upstream_error`.
- [ ] **Step 3:** Run; FAIL. Implement. Run; PASS. Commit `feat: CPCB measured data clients and city list`.

---

### Task 10: City outputs

**Files:**
- Create: `server/vayu/receptors.py`
- Test: `server/tests/test_receptors.py`

**Interfaces:**
- Consumes: `RunResult`, `CITIES`, `MetField`.
- Constant: `FIRE_ARRIVAL_UGM3 = 15.0`.
- Produces: `city_series(run: RunResult, met: MetField) -> dict[city_id, CitySeries]` with `by_tag: dict[tag_id, np.ndarray (hours,)]`, `fire_age_h (hours,)`, `met: dict[str, np.ndarray]` (`wind_ms, wind_dir_deg, rh, temp_c, blh_m`).
- Produces: `breakdown(by_tag_now: dict[tag_id, float], weights: dict[tag_id, float], city_region: str, measured: float | None) -> list[BreakdownRow]` — rows grouped as "Fires (satellite) — {state}", "Local {sector}" (tag region equals the city's region), "Transported {sector} — {region}", and, only when `measured` is not None and exceeds the simulated total, "Not explained by model". Shares are of `max(measured, simulated)` when measured exists, else of simulated. This function is the reference for the TypeScript port in Task 13.
- Produces: `arrival(fire_series: np.ndarray, hour: int) -> ArrivalLabel` — `{"kind":"present","age_h":…}` if at or above threshold at `hour`; `{"kind":"arrives","in_h":N}` for the first later crossing; `{"kind":"none"}` otherwise.
- Produces: `back_trajectory(met: MetField, elev, lon, lat, hour: int, hours_back: int = 72) -> list[tuple[float, float]]` — hourly points, mean wind only, same blocking rule.

- [ ] **Step 1: Write failing tests:** `test_local_vs_transported_grouping` (Delhi: `vehicles_delhi_ncr` is local, `vehicles_punjab` transported); `test_unexplained_row_when_measured_higher` (sim 100, measured 160 → row of 60, 37.5%); `test_no_unexplained_row_when_measured_missing` (Review Focus 2); `test_no_unexplained_row_when_sim_exceeds_measured`; `test_all_zero_has_no_nan` (Review Focus 1 and 5: empty shares are `None`); `test_arrival_present`, `test_arrival_future` (crosses 9 hours later → `in_h == 9`), `test_arrival_none`; `test_back_trajectory_uniform_wind` (5 m/s westerly, 10 h → start point 180 km west).
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS. Commit `feat: city breakdown, arrival and back-trajectory`.

---

### Task 11: Encoding and HTTP API

**Files:**
- Create: `server/vayu/encode.py`, `server/vayu/api.py`, `server/vayu/emissions/dropped.py`
- Test: `server/tests/test_encode.py`, `server/tests/test_api.py`, `server/tests/emissions/test_dropped.py`

**Interfaces:**
- Frame format (little-endian): magic `VAYU`, `uint16 version=1`, `uint16 n_tags`, `uint16 nx`, `uint16 ny`; then per tag: `uint8 id_len`, id bytes, `float32 scale`, `nx*ny uint16` row-major from the south-west corner. Value = `uint16 × scale`. A final pseudo-tag `__haze` carries the haze factor. Served with gzip.
- Produces: `encode_frame(fields_at_hour: dict[str, np.ndarray]) -> bytes`, `decode_frame(b) -> dict[str, np.ndarray]`.
- Endpoints (all under `/api`):
  - `POST /runs` body `{date}` → 202 `{run_id}`; `run_id` is the ISO date. 422 with `{detail}` if the date is before `MIN_DATE` or after today. `MIN_DATE` defaults to 2018-04-01 and is confirmed in Task 16.
  - `GET /runs/{id}` → `{status: "running"|"ready"|"error", progress: 0..1, stage: str, error: str|None}`. An `UpstreamError` becomes `status: "error"` with `"{service}: {message}"`.
  - `GET /runs/{id}/meta` → `{date, hours: [iso], forecast_from: int|null, grid, tags: [{id, kind, sector, region, label, color}], cities: [{id, name, lat, lon, region, by_tag, fire_age_h, met, cams: [..|null]}], notes: {blh_estimated, dust_available, inventory_source, fire_scaling_default}}`
  - `GET /runs/{id}/frames/{hour}?extra=user_1,user_2` → frame bytes.
  - `GET /runs/{id}/fires` → `[[lon, lat, frp_mw, hour_index]]`.
  - `GET /runs/{id}/wind/{hour}` → `{step: 1.0, lon0, lat0, nx: 33, ny: 33, u: [...], v: [...]}`.
  - `GET /runs/{id}/cities/{city}/measured` → `{values: [..|null], station_count, live: number|null}` fetched on demand.
  - `GET /runs/{id}/cities/{city}/path/{hour}` → `[[lon, lat], ...]`.
  - `POST /runs/{id}/sources` body `{kind, lon, lat, amount, start_hour, duration_h}` → `{tag: {id: "user_N", label, color}, by_city: {city_id: [...]}}`; simulates only that source and stores its fields beside the run.
  - `GET /validation` → the JSON written by Task 16, 404 if absent.
- Produces, in `dropped.py`: `KINDS: dict[str, Kind]` for `traffic` (unit: vehicles), `construction` (unit: m² of site), `fireworks` (unit: small / medium / large event), `custom` (unit: kg PM2.5 per hour); each `Kind(label, unit, kg_per_hour: Callable[[float], float], source: str)` where `source` is a citation URL for the factor. `dropped_emissions(kind, lon, lat, amount, start_hour, duration_h, hours) -> Emissions`.

- [ ] **Step 1: Write failing tests:** `test_roundtrip_within_quantisation` (max relative error < 1/65535 of tag max); `test_all_zero_tag_roundtrips`; `test_every_kind_has_citation` (`source` starts with `http`); `test_custom_is_identity`; `test_dropped_outside_domain_422`; API tests with `run_date` stubbed: `test_post_run_then_ready`; `test_future_date_422`; `test_before_min_date_422` (Review Focus 4); `test_upstream_error_surfaces_message` (Review Focus 3); `test_frame_decodes_and_matches_fields`; `test_extra_tags_included`; `test_measured_no_stations_returns_nulls`; `test_meta_contains_34_tags_and_40_cities`; `test_no_key_in_any_response` (response bodies never contain any `.env` value).
- [ ] **Step 2:** Run; FAIL. Implement; runs execute in a background thread with one run at a time. Run; PASS. Commit `feat: frame encoding and HTTP API`.

---

### Task 12: Web scaffold and base map

**Files:**
- Create: `web/` Vite React-TS project, `web/src/map/MapView.tsx`, `web/src/lib/colors.ts`, `web/public/india-boundary.geojson`, `web/src/styles/tokens.css`
- Test: `web/src/lib/colors.test.ts`

**Interfaces:**
- Produces: `<MapView/>` filling the viewport: MapLibre with a keyless dark style, raster-dem terrain from the Terrarium tiles (toggleable), a deck.gl overlay (`MapboxOverlay`, interleaved), initial view centre 79 E 27 N zoom 4.6 pitch 35.
- Boundary: copy `server/vayu/assets/india-states.geojson` (from Task 1) to `web/public/india-boundary.geojson`, draw it as a thin line layer, and hide the basemap's own country-boundary layers.
- Produces: `tokens.css` with the mockup's values: `--bg:#0b0e13`, panel `rgba(17,21,29,.82)` with 14 px blur and 14 px radius, `--accent:#ff8a3d`, `--mute:#8b93a5`, `--text:#e8eaf0`; tabular numerals for all numbers.
- Produces: `colors.ts` — `TAG_COLORS` (fires `#ff5a2b`, vehicles `#6aa8ff`, industry `#b98cff`, dust `#e0b45a`, residential `#5fd3c4`, unexplained `#5b6475`), `pm25Ramp(v: number): [r,g,b,a]` (transparent below 5 µg/m³, amber to deep red by 400), `aqiColor(aqi)` by CPCB category.
- Vite dev proxy: `/api` → `http://localhost:8000`.

- [ ] **Step 1:** Write `colors.test.ts`: `pm25Ramp(0)[3] === 0`; alpha rises monotonically to 400; `aqiColor(450)` is the Severe colour.
- [ ] **Step 2:** Run `npm --prefix web test`; FAIL. Implement. PASS.
- [ ] **Step 3:** Run `npm --prefix web run dev`, confirm in the browser: dark map, terrain relief visible when pitched, official boundary drawn, no console errors. Commit `feat: web scaffold and base map`.

---

### Task 13: Browser data layer and composition

**Files:**
- Create: `web/src/api/types.ts`, `web/src/api/client.ts`, `web/src/api/decode.ts`, `web/src/lib/compose.ts`, `web/src/lib/aqi.ts`, `web/src/lib/breakdown.ts`, `web/src/state/store.ts`
- Test: `web/src/api/decode.test.ts`, `web/src/lib/compose.test.ts`, `web/src/lib/aqi.test.ts`, `web/src/lib/breakdown.test.ts`, `web/src/state/store.test.ts`

**Interfaces:**
- Consumes: Task 11 endpoints and frame format.
- Produces: `decodeFrame(buf: ArrayBuffer): Frame` where `Frame = { tags: Map<string, { scale: number; data: Uint16Array }>; nx: number; ny: number }`.
- Produces: `composeField(frame: Frame, weights: Record<string, number>, opts?: { haze?: boolean }): Float32Array` — Σ `data × scale × weight`; `lerpFields(a, b, t)`.
- Produces: `pm25ToAqi(v)`, `rolling24h(series, i)` — mean of available values in the previous 24 h, `null` if fewer than 16.
- Produces: `breakdown(byTagNow, weights, cityRegion, measured)` — port of Task 10's function with the same grouping and labels.
- Produces: store fields `runId, status, progress, stage, error, meta, hour (float), playing, speed (1|2|4|8), layers {pm25, aqi, wind, fires, terrain}, sliders {vehicles, industry, dust, residential: 0..2}, fireScaling (0.5..5), firesContinue (bool), regionScenario {delhiOddEven, delhiConstructionBan}, userSources [], selectedCity, compareBaseline`; selector `weights(): Record<tagId, number>`; actions `startRun(date)`, `setHour`, `togglePlay`, `selectCity`, `addSource`, `resetScenario`.
- Weight rule: sector tag = its slider × region scenario factor (`delhiOddEven` → `vehicles_delhi_ncr × 0.7`; `delhiConstructionBan` → `dust_delhi_ncr × 0`); `fire_*` = `fireScaling`; `firefc_*` = `fireScaling` if `firesContinue` else 0; `user_*` = 1. With `compareBaseline` the map shows composed-minus-baseline.
- Frames: fetch on demand, keep a window of ±12 hours around `hour`, cancel stale requests.
- `startRun` polls `GET /runs/{id}` every second; on `error` it stops polling and stores the message.

- [ ] **Step 1: Write failing tests:** `decode` round-trips a hand-built buffer; `compose` — two tags, weights 1 and 0.5, equals manual sum; `compose` with all weights 0 is all zeros (Review Focus 5); `aqi` matches the Task 1 table; `rolling24h` returns null under 16 values; `breakdown` — the three cases from Task 10 with identical numbers, plus all-zero gives `share: null`; store — `weights()` for odd-even, for `firesContinue=false`, for `fireScaling=2`; store — polling stops and `error` is set on an error status (Review Focus 3).
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS. Commit `feat: browser data layer and tag composition`.

---

### Task 14: Map layers

**Files:**
- Create: `web/src/map/layers/plume.ts`, `fires.ts`, `wind.ts`, `cities.ts`, `path.ts`, `userSources.ts`; modify `web/src/map/MapView.tsx`
- Test: `web/src/map/layers/plume.test.ts`, `web/src/map/layers/cities.test.ts`

**Interfaces:**
- Consumes: store, `composeField`, `lerpFields`, `pm25Ramp`, `aqiColor`.
- `plume.ts`: `fieldToImageData(field: Float32Array, nx, ny, mode: "pm25"|"aqi"|"diff"): ImageData` (row order flipped north-up) drawn by a deck.gl `BitmapLayer` over the domain bounds with linear filtering. Uses the haze-weighted field for opacity and the dry field for colour. `diff` mode: blue for reduction, red for increase.
- `fires.ts`: `ScatterplotLayer`, radius by `sqrt(frp)`, showing detections from the 24 h before the playhead, additive glow.
- `wind.ts`: animated streaks advected through the `u, v` lattice for the current hour (about 3,000 streaks, fading trails).
- `cities.ts`: `cityLabel(city, hourIndex, weights): { primary: string; secondary: string; color }` — secondary is "AQI N", "arrives +N h" or "smoke present · N h old" using the fire tags' weighted series and the 15 µg/m³ threshold; marker coloured by AQI category.
- `path.ts`: dotted `PathLayer` for the selected city's back-trajectory, refetched when the city or whole hour changes.
- Clicking a city marker calls `selectCity`. Clicking the map while "Drop source" is armed opens the dialog at that point.

- [ ] **Step 1: Write failing tests:** `fieldToImageData` — value at south-west cell lands in the bottom-left pixel; zero field is fully transparent; `cityLabel` — "arrives +9 h", "smoke present · 17 h old", and plain AQI when fire weight is 0.
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS.
- [ ] **Step 3:** With the server running on 2023-11-05, confirm in the browser: plume animates smoothly between hours at 4× speed, fires glow in Punjab, wind streaks follow the readout direction, labels update. Commit `feat: plume, fire, wind, city and path layers`.

---

### Task 15: Panels

**Files:**
- Create: `web/src/panels/TopBar.tsx`, `SourcesPanel.tsx`, `CityPanel.tsx`, `Timeline.tsx`, `DropSourceDialog.tsx`, `RunStatus.tsx`, `web/src/lib/format.ts`; modify `web/src/App.tsx`
- Test: `web/src/panels/CityPanel.test.tsx`, `web/src/panels/SourcesPanel.test.tsx`, `web/src/panels/Timeline.test.tsx`, `web/src/lib/format.test.ts`

**Interfaces:**
- Consumes: store, `breakdown`, `pm25ToAqi`, `rolling24h`, measured endpoint.
- Layout and styling follow `.superpowers/brainstorm/25571-1794369182/content/main-screen.html`, with the 7.6 changes: a Residential row; "Road and construction dust"; "Fires (satellite)"; "Not explained by model" replaces "Other / background".
- `TopBar`: date picker bounded by `MIN_DATE` and today; IST clock; layer chips; wind, humidity, temperature and mixing-height readouts for the selected city (Delhi by default); mixing height marked "est." when `notes.blh_estimated`.
- `SourcesPanel`: fires row with the fire-scaling control and its explanatory tooltip; four sector sliders 0–200%; a note under the dust slider when `!notes.dust_available` ("No baseline dust data — add sites with Drop source"); scenario toggles (Odd-even traffic, Delhi; Construction ban, Delhi NCR; Fires stop now — forecast runs only); "Drop source on map"; "Compare with baseline"; "Reset"; weather-effects readout (night inversion strong/weak from mixing height < 300 m, rain washout from precipitation, terrain blocking on).
- `CityPanel`: simulated PM2.5-based AQI and category; measured CPCB value with station count and percentage error, or "No CPCB data for this hour"; a one-line explanation that secondary aerosol and inflow are not simulated; breakdown bar and legend; travel time; chart of our model, CPCB points and Copernicus over the window with the forecast section dashed and a "now" marker.
- `Timeline`: play/pause, speed, scrubber; solid before `forecast_from`, dashed after; the caption "forecast assumes fires continue at recent levels" whenever the forecast section exists.
- `RunStatus`: progress bar with stage text while running; the error message with a Retry button on error.
- `format.ts`: `fmtShare(x: number|null): string` → "–" for null; `fmtError(sim, measured)` → signed percent or "".

- [ ] **Step 1: Write failing tests** (Testing Library): CityPanel hides the gap row and error when measured is null and shows "No CPCB data for this hour" (Review Focus 2); shows "Not explained by model" with 37.5% for sim 100 / measured 160; renders "–" when everything is zero (Review Focus 5); SourcesPanel shows the dust note when `dust_available` is false and hides "Fires stop now" when `forecast_from` is null; Timeline shows the forecast caption only when `forecast_from` is set; date input has `min` and `max` attributes (Review Focus 4); RunStatus shows the server's error text.
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS.
- [ ] **Step 3:** In the browser at 1440×900, compare against the mockup side by side; fix spacing, colour and type differences. Check a drop-source round trip adds a tag, a legend entry and a visible plume. Commit `feat: panels, scenarios and timeline`.

---

### Task 16: Validation, date floor, one-command run

**Files:**
- Create: `server/vayu/validate.py`, `web/src/panels/ValidationDialog.tsx`, `README.md`, `docs/validation/2023-11.md` (generated); modify `Makefile`, `server/vayu/api.py` (`MIN_DATE`)
- Test: `server/tests/test_validate.py`

**Interfaces:**
- Produces: `validate.metrics(sim: np.ndarray, measured: np.ndarray) -> {n, r, bias, nmb, rmse}` over hours where both exist; `None` fields when `n < 24`.
- Produces: `python -m vayu.validate 2023-11-03 2023-11-09` → runs each date, writes `server/data/validation.json` and `docs/validation/2023-11.md` with a table per northern city (Delhi through Patna in the Task 9 list) and the CAMS metrics beside ours.
- `ValidationDialog`: opened from the top bar; renders the table; states that no parameter was fitted.
- `make dev` starts uvicorn on 8000 and Vite on 5173 together and stops both on Ctrl-C; `make test` runs both suites.

- [ ] **Step 1: Write failing tests:** `test_perfect_match` (r = 1, bias = 0); `test_constant_offset` (bias = −50, nmb = −0.5 for sim half of measured); `test_ignores_nan_pairs`; `test_too_few_points_returns_none`.
- [ ] **Step 2:** Run; FAIL. Implement. Run; PASS.
- [ ] **Step 3:** Run the validation command. Report the numbers as they are; do not change constants in response.
- [ ] **Step 4:** Set `MIN_DATE`: query OpenAQ for the earliest year in which at least 10 of the northern cities have CPCB PM2.5 data, and use the later of that and 2018-04-01. Record the finding in `docs/data-notes.md`. Also record whether the Open-Meteo archive returned mixing height for 2018 and 2023.
- [ ] **Step 5:** Write `README.md`: what it is, `cp`-free setup (keys already in `.env`), `make dev`, data sources and licences, what the model does not simulate, constants and their citations, the back-trajectory note.
- [ ] **Step 6:** From a clean clone state, run `make test` (all pass) and `make dev`, load today's date and 2023-11-05 end to end. Commit `feat: validation report and one-command run`.
