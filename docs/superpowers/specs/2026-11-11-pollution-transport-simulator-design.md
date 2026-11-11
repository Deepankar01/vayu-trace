# India Pollution Transport Simulator — Design

Date: 2026-11-11
Status: awaiting approval
Working name: "Vayu Trace" (placeholder, Claude's invention)

Throughout this document, items marked **(user)** were stated or confirmed by the user. Items marked **(call)** are Claude's choices; the user has seen most of them in summary but has not individually approved them.

## 1. Intent

A web-based simulator that shows air pollution travelling across India, hour by hour, from where it is emitted to the cities that receive it. It exists so that a researcher can pick a date, press play, and see where a city's pollution came from, by what path, and when it arrives elsewhere. **(user)**

Audience: a demo for researchers. **(user)** They will judge the physics, so the plume must come from real wind data moving real emissions through a defensible model, and the simulated result must be shown against measured values so the error is visible. It must also look polished and chic. **(user)**

## 2. Goals

1. Real paddy-fire detections from NASA satellites drive smoke emissions for the chosen date. **(user)**
2. Real wind speed and direction, humidity, temperature, rain and terrain act on the physics, not only on the backdrop. **(user)**
3. Other sources — vehicles, construction, industry, festivals — come from real data where it exists; otherwise the user adds or scales them and sees the effect. **(user)**
4. Any date can be replayed; for today the run continues 2–3 days ahead as a forecast. **(user)**
5. Clicking a city shows: simulated vs measured AQI, a breakdown of where its pollution came from, the smoke's travel path and travel time, and arrival times for downstream cities. **(user confirmed Claude's guess)**
6. Measured AQI comes from government (CPCB) data only, for now. **(user)**
7. The main pollutant is PM2.5, converted to AQI on the Indian CPCB scale. **(user confirmed Claude's guess)**
8. The map covers all of India; model quality effort is focused on the north (Punjab, Haryana, Delhi, UP, Bihar). **(user confirmed Claude's guess)**
9. The main screen matches the approved mockup (section 6). **(user)**

## 3. Non-goals

- aqi.in data. It has no public API; deferred by the user. Leave a clean slot for a second "measured" provider.
- Atmospheric chemistry and secondary aerosol formation.
- Multiple vertical layers. One well-mixed layer only.
- Public hosting, accounts, authentication, mobile layout. Runs on the user's laptop first. **(call)**
- Pollutants other than PM2.5.

## 4. Anti-goals

These would make it a failure even if it runs:

- An animation that is not driven by the model.
- Tuning the model per city or per date so it matches measurements. One global set of parameters only.
- Hiding or softening the model-vs-measured error.
- Presenting the forecast portion as if it were observed.

## 5. Data sources

All three keys are present in `.env` at the project root (git-ignored) and were verified working on 2026-11-11: `FIRMS_MAP_KEY`, `OPENAQ_API_KEY`, `DATA_GOV_IN_API_KEY`. Keys must stay server-side; never ship them to the browser.

| Need | Source | Verified facts |
|---|---|---|
| Fires | NASA FIRMS area API, `https://firms.modaps.eosdis.nasa.gov/api/area/csv/{key}/{product}/{w,s,e,n}/{days}/{date}` | `VIIRS_SNPP_SP` covers 2012-01-20 to 2026-07-31; `VIIRS_NOAA20_SP` from 2018-04-01; `VIIRS_NOAA21_SP` from 2023-03-01. NRT products cover roughly the last 3 months. `VIIRS_SNPP_NRT` was stale (ended 2026-11-02) while NOAA-20 and NOAA-21 NRT were current. A Punjab-region query for 2023-11-05 returned 3,777 detections with `frp`, `confidence`, `acq_time`, `daynight`. Limit: 5,000 transactions per 10 minutes. Max days per request is 5 or 10 (sources disagree). The `data_availability` endpoint gives current date ranges. |
| Weather | Open-Meteo, no key. Forecast: `api.open-meteo.com/v1/forecast`. History: `archive-api.open-meteo.com/v1/archive` | Hourly `wind_speed_10m`, `wind_direction_10m`, `wind_speed_100m`, `temperature_2m`, `relative_humidity_2m`, `precipitation`, `boundary_layer_height` accepted by both; history answered for 2018; several coordinates per request work. Not verified: that `boundary_layer_height` is non-null in the archive for all years. |
| Measured PM2.5, history | OpenAQ v3, header `X-API-Key` | CPCB stations present with `pm25` sensors (e.g. Delhi Technological University). |
| Measured AQI, live | data.gov.in resource `3b01bcb8-0b14-4abf-b6f2-c1bfd384ba69` ("Real time Air Quality Index from various locations", CPCB) | Responds with the key; updated hourly. Current readings only. |
| Second model for comparison | Copernicus CAMS PM2.5 via `air-quality-api.open-meteo.com/v1/air-quality` | Real values for Nov 2022; null for Nov 2020. Forecast available. |
| Terrain | AWS Terrarium elevation tiles, `s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png`, no key | Responds. |
| Baseline emissions | EDGAR v8.1 gridded PM2.5 by sector, 0.1° **(call)** | Reported to exist with 1971–2022 coverage; not downloaded or inspected. An India-specific 0.1° inventory (ESSD 2023-310, on Zenodo) is an alternative. Published inventories for India differ by up to 37%. |

No dataset was found for construction specifically or for festival fireworks. Those are user-driven (section 7.4).

## 6. The screen

Approved mockup: `.superpowers/brainstorm/25571-1794369182/content/main-screen.html`. One full-screen dark map with four floating glass panels.

- **Map (centre).** 3D terrain. Layers: PM2.5 plume, fire detections, animated wind, city markers. Cities downstream of the plume carry an arrival label ("arrives +9 h"). Selecting a city draws a dotted path back to the sources feeding it.
- **Top bar.** Date and hour; layer toggles (PM2.5, AQI, Wind, Fires, Terrain 3D); readouts for wind, humidity, temperature and mixing height at the selected city.
- **Left panel — sources.** Fires (real, not adjustable apart from the global fire scaling in 7.3). Sliders for vehicles, construction dust, industry and power. What-if scenarios (e.g. odd-even traffic in Delhi, Diwali fireworks). "Drop source on map". "Compare with baseline". A short readout of weather effects in force (night inversion, rain washout, terrain blocking).
- **Right panel — selected city.** Simulated AQI large, measured CPCB AQI beside it with percentage error. "Where it came from" stacked bar and legend. Smoke travel time. Chart of our model vs CPCB stations vs Copernicus over the window, forecast part dashed.
- **Bottom bar.** Play/pause, current time, speed, timeline. Solid section is replay of real data, dashed section is forecast.

Visual quality bar: the mockup's restraint — dark neutral base, one warm accent, tabular numerals, no chart junk. Colour for sources must stay consistent between map, sliders and breakdown.

## 7. The model

### 7.1 Method **(call, user saw summary)**

A Lagrangian particle model, the same family as NOAA HYSPLIT, simplified to one mixed layer. Each source releases parcels every hour. Each parcel carries a mass of PM2.5 and a tag naming its source. Every time step a parcel is:

- moved by the wind interpolated to its position and time;
- nudged by a random horizontal step representing turbulence;
- reduced in mass by dry settling and, when it rains, by washout;
- stopped from moving into terrain that stands above the mixed layer (it slides along instead). This is what lets the Himalaya wall in the plains.

Concentration in a grid cell is the parcel mass in the cell divided by cell area times mixing-layer height. A shallow night-time layer therefore concentrates pollution without any special rule. Humidity raises reported PM2.5 through a standard hygroscopic growth factor.

Why this method: because every parcel remembers its source, the breakdown, travel path and arrival time fall out directly rather than being inferred.

### 7.2 Grid and time **(call)**

- Domain: 66–98°E, 6–38°N.
- Output grid: 0.1° (about 10 km).
- Weather sampled on a coarser lattice (about 1°) and interpolated; cached on disk per date.
- Transport wind: a blend of 10 m and 100 m wind as a proxy for mixed-layer wind.
- Output every hour. Window for a past date: two days before to three days after. For today: three days back, three days forward. Add a spin-up before the window so the first frame is not empty.

### 7.3 Fire emissions **(call)**

Per detection, fire radiative power is converted to smoke: FRP → radiative energy over an assumed burn duration with a daytime-peaked profile → biomass burned (Wooster et al. 2005 coefficient) → PM2.5 using a published emission factor for crop residue. Satellites miss small and short-lived fires and fires under cloud or thick smoke, so emissions are known to be underestimated; one global "fire scaling" factor is exposed in the UI with a documented default. It is a single number for the whole run, never per city.

Product choice: `_SP` products where the date is covered, NRT otherwise. Where several satellites cover the same day, combine them per grid cell so the same fire is not counted once per satellite. Fire tags are by state (Punjab, Haryana, Uttar Pradesh, Madhya Pradesh, other) so the breakdown can name them.

### 7.4 Other sources

- **Baseline** from the gridded inventory, grouped into the tags shown in the UI: vehicles, industry and power, construction and road dust, residential/other.
- **Sliders** scale a tag from 0% to 200%. Because concentration is proportional to emission, each tag's field is computed once and the browser rescales it. Slider changes must feel instant and must not trigger a re-run.
- **Scenarios** are named presets of slider values, optionally limited to a region (odd-even in Delhi).
- **Dropped source**: the user places a point, picks a kind (traffic cluster, construction site, fireworks/festival, custom), an amount in friendly units (number of vehicles, site area, a festival size) and hours. Friendly units convert to PM2.5 per hour through documented factors **(builder to choose and cite)**. Only that source is simulated afresh.
- **Background**: a term for what the model does not represent (secondary aerosol, long-range inflow). Shown as "Other / background" in the breakdown, never folded into a named source.

### 7.5 Outputs per city

- Simulated PM2.5 and AQI. AQI uses the CPCB PM2.5 sub-index breakpoints on a 24-hour average and is labelled as PM2.5-based, since official AQI takes the worst of several pollutants.
- Measured value: the median of the city's CPCB stations. History from OpenAQ; the live value for today from data.gov.in.
- Source breakdown: tag shares in the city's cell.
- Arrival time: first hour the fire contribution passes a fixed threshold **(builder to set, one value for all cities)**.
- Path: the mean track of parcels present at the city, by tag.
- A fixed list of roughly 40 cities with CPCB stations, weighted towards the north **(builder to pick)**.

### 7.6 Decisions made after builder review

These override anything above that conflicts. The first is the user's; the rest are Claude's calls.

- **Unexplained gap, no fitting. (user)** The model reports only what it simulates: directly emitted PM2.5. There is no modelled background term. Where measurements exist, the difference between measured and simulated is shown in the breakdown as "Not explained by model" and is clearly not a model output; where measurements are missing, that row is absent. The simulated AQI is computed from simulated PM2.5 alone and is expected to read low, often by 30–50% in a north India winter; the UI says why (secondary aerosol and inflow are not simulated). No parameter is fitted to CPCB or Copernicus data. The fire scaling default comes from published studies, cited, and is not fitted. This replaces the "Background" bullet in 7.4 and the "Other / background" row in the mockup.

- **Source tags are sector by region.** Regions: Delhi NCR, Punjab, Haryana, Uttar Pradesh, Bihar, rest of India. Sectors: vehicles, industry and power, road and construction dust, residential. "Local" in a city's breakdown means emitted in the city's own region; everything else is shown as transported, by region. Region-limited scenarios (odd-even in Delhi) work on these regions only. If the field count threatens the one-minute target, merge sectors for "rest of India" first.
- **Residential is a visible row** with its own colour, slider and legend entry. This is an addition to the approved mockup.
- **Dust.** The slider is "Road and construction dust". Prefer the India-specific inventory (ESSD 2023-310) if it carries a dust sector; EDGAR does not. If no usable dust field exists, the baseline for this tag is zero, the UI says so, and construction enters only through dropped sources. Do not invent a proxy.
- **Fires are labelled "Fires (satellite)", not "paddy fires".** Exclude static heat sources (the `type` field in `_SP` products; a persistence filter for NRT). Use a crop-residue emission factor in the cropland states and a generic vegetation factor elsewhere; the builder may use a land-cover mask if it is cheap.
- **Fires in forecast hours.** Assume persistence: the average of the last three complete days of detections, with the usual daily profile. The UI states "forecast assumes fires continue at recent levels" and offers a "fires stop now" alternative. Today's incomplete hours are filled the same way.
- **Humidity.** The value compared with CPCB is dry PM2.5, because monitors report approximately dry mass. Humidity growth is applied only to a separate "haze" quantity that drives how thick the plume is drawn and is offered as a readout. Humidity is otherwise shown as context.
- **Arrival and travel time.** Parcels carry their age. "Travel time" at a city is the median age of fire parcels present there. A downstream label reads "arrives +N h" when the fire contribution is below the threshold now and crosses it N hours after the playhead; when smoke is already present it reads "smoke present · N h old".

## 8. Architecture **(call)**

- **Server:** Python, FastAPI, NumPy. Fetches and caches data, runs the simulation, serves results. Results cached per date so a second visit is instant.
- **Browser:** React, TypeScript, Vite. MapLibre GL for the map and 3D terrain; deck.gl for plume, fires, wind and paths.
- **Contract between them:** per run, hourly fields per source tag in a compact binary form, plus per-city series and metadata. The browser composes tags with the current slider weights.
- **Runs locally with one command.** Hosting is a later, separate piece of work.
- **Basemap:** a dark style needing no key. India's boundaries must follow the official Government of India depiction; overlay an official boundary layer rather than trusting the basemap's.

First run for a new date should finish in about a minute on a laptop, with visible progress; this is a target, not a promise.

## 9. Honesty and validation

- Simulated, measured and Copernicus values always appear together where a city is shown.
- A validation view or report for at least one known episode (early November 2023) giving correlation and bias at the northern cities. The numbers are reported whatever they are.
- Missing data is shown as missing: a date with no measured values, a station gap, or Copernicus before 2022.
- Forecast is visually distinct everywhere it appears.

## 10. Testing

- Mass is conserved when deposition is off.
- A uniform wind moves a puff the right distance in the right direction.
- A wall of terrain above the mixed layer stops parcels.
- AQI conversion matches the CPCB table at every breakpoint.
- Slider rescaling in the browser equals a server re-run with scaled emissions.
- Data clients are tested against recorded responses, not live services.

## 11. Left to the builder

Particle counts and time step; turbulence and deposition constants (cite sources); exact emission factors; inventory file handling and sector mapping; binary format; city list; arrival threshold; dropped-source unit factors; basemap style; project layout; progress reporting.

## 12. Known unknowns

- Whether Open-Meteo's archive returns mixing-layer height for all years. If not, estimate it from time of day, temperature and wind, and say so in the UI.
- Earliest date with enough CPCB stations in OpenAQ. The date picker's floor should be set from what the data supports; the intent is 2018 onwards.
- EDGAR file sizes and sector names have not been inspected.
- Open-Meteo free-tier request limits against the number of weather points per run.
- The project folder is not a git repository yet.
