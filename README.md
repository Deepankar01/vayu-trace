# Vayu Trace: India PM2.5 transport simulator

Vayu Trace replays how fine particulate pollution (PM2.5) moves across India hour by hour. For a chosen date it releases emissions from satellite-detected fires and from a gridded emission inventory into real weather, carries them with the wind, and shows on a map where each city's simulated PM2.5 came from, by what path and how long it took to arrive. For today's date the run continues through the next two days as a forecast.

It is a demonstration for atmospheric researchers. The simulated values are always shown next to government (CPCB) measurements and the Copernicus (CAMS) model so the error is visible, and the model's limits are stated rather than hidden. It runs locally on a laptop; there is no hosting, account or authentication.

## Quick start

Requirements: [uv](https://docs.astral.sh/uv/) (Python 3.12 is installed by uv), Node with npm (developed with Node 26 and npm 11), and `make`.

1. Put three API keys in a file named `.env` at the repository root (variable names below; the values are your own and are never sent to the browser):
   - `FIRMS_MAP_KEY`: NASA FIRMS map key (fire detections)
   - `OPENAQ_API_KEY`: OpenAQ v3 key (CPCB measurements)
   - `DATA_GOV_IN_API_KEY`: data.gov.in key (live CPCB feed; optional, the app does not use the live feed, see Data sources)
2. `make setup`: installs the Python and web dependencies and downloads the EDGAR emission inventory (nine zip files of a few MB each) if it is not there yet.
3. `make dev`: starts the API (port 8000) and the web app (port 5173) together and prints the address. Ctrl-C stops both. Other ports: `make dev API_PORT=8010 WEB_PORT=5183`.
4. Open http://localhost:5173. The first run of a date takes one to a few minutes (about a minute when the upstream data is already cached; weather download and simulation, with a progress bar); after that the stored run is reused while it is valid: a run is reused if it is final (its date is at least about 13 days old: the window ends 3 days after the date and upstream data is treated as final 10 days later) or if it is less than an hour old; otherwise opening the date simulates it again (about a minute). Pick another date with `?date=YYYY-MM-DD` or the date field.

Other targets: `make test` (server and web test suites), `make validate` (the validation report below), `make build` (production build of the web app into `web/dist/`).

## What you can do

- **Replay a date** from 2018-04-01 onwards: 144 hours of hourly output starting two days before the date, with play, pause and speed.
- **Forecast for today**: a window starting three days back and continuing through the next two days on the weather forecast. Forecast hours are marked as such everywhere, and the forecast assumes fires continue at their recent level; a "Fires stop now" switch shows the alternative.
- **Sliders and scenarios**: scale vehicles, industry and power, residential and road and construction dust from 0 to 200 %, scale all fire emissions, and switch on two illustrative Delhi NCR scenarios (odd-even traffic, construction ban). These reweight already simulated fields in the browser; nothing is re-simulated.
- **Drop a source**: click the map to add traffic, a construction site, a fireworks event or a custom source for a chosen period. The server simulates that source alone (a few seconds) and it joins the plume and the city breakdowns; it can be switched off or removed.
- **Compare with baseline**: show the difference your changes make against the unmodified run.
- **City breakdown**: click a city for simulated PM2.5 and AQI next to CPCB measurements and CAMS, the share from each source and region, "Not explained by model" (measured minus simulated), the travel path of the air (a back-trajectory along the mean wind for up to 72 hours, shorter early in the window because weather data starts 48 hours before it; stopped by terrain above the mixed layer) and smoke age and arrival times.
- **Validation**: the "Validation" button shows the model and CAMS against CPCB measurements for a reference episode (see below).

## How it works

- **Particles.** Emissions are released every hour as particles (parcels of mass), 100 per source tag per hour (400 for the "rest of India" sector tags). Each particle moves with the hourly wind from Open-Meteo plus a random turbulent step, every 10 minutes, and loses mass to dry deposition and rain washout.
- **One mixed layer.** Particles are well mixed through the boundary-layer (mixing) height; concentration is the mass in a 0.1 degree cell divided by the cell area and the mixing height. Terrain higher than the mixed layer blocks transport, so the Himalaya hold smoke back. There is no vertical structure above or within the layer.
- **Tags per source.** Every particle carries a tag (sector by region, or fires by state), so each city's value splits into its sources. The browser combines the per-tag fields with your slider weights.
- **Hour means.** Each map frame and city value is the mean over its hour. Each run starts 48 hours before the first shown hour so pollution already in transit is present.
- **Age-dependent smoothing.** Each source tag's mass is spread with a box kernel that grows with particle age: none under 6 hours, 3 x 3 cells from 6 to 24 hours, 5 x 5 cells beyond. The kernel conserves mass. It is a choice to reduce sampling noise from a finite number of particles, not physics.
- **City value.** A city's value is the mean over the 3 x 3 block of cells around its centre, roughly a 30 km square, not a point.
- **Measured values.** CPCB station averages are reported on the Indian clock (HH:30 UTC); each UTC hour is the overlap-weighted mean of the two periods it straddles, and the city value is the median over up to five stations within 25 km. Missing hours stay missing.

Each physical constant in `server/vayu/constants.py` is either cited or explicitly marked as a design choice or an unverified value (cited examples: deposition velocity, washout coefficients, fire emission factors after Akagi et al. 2011, biomass per unit fire radiative energy after Wooster et al. 2005, the fire diurnal cycle after Giglio 2007). A few constants live next to their code: `MIN_MASS_FRACTION` in `server/vayu/sim/particles.py`, the calm-wind threshold in `server/vayu/receptors.py` and the dropped-source factors in `server/vayu/emissions/dropped.py`. Particle counts and the run window are in `server/vayu/sim/run.py`. No parameter is fitted to CPCB or CAMS data; one global parameter set is used for every city and date.

## Data sources and licences

- **Fires**: NASA FIRMS, VIIRS active fire detections (S-NPP, NOAA-20, NOAA-21), fire radiative power. NASA data, free to use with acknowledgement of FIRMS (https://firms.modaps.eosdis.nasa.gov).
- **Weather and forecast**: Open-Meteo (https://open-meteo.com), historical (reanalysis) archive and forecast APIs; Open-Meteo data are offered under CC BY 4.0 with attribution to Open-Meteo.
- **CAMS PM2.5**: Copernicus Atmosphere Monitoring Service, via the Open-Meteo air-quality API. Contains modified Copernicus Atmosphere Monitoring Service information.
- **Measurements**: CPCB (Central Pollution Control Board) PM2.5 through OpenAQ (https://openaq.org), hourly history. A client for the live CPCB feed on data.gov.in (Government Open Data License - India) is implemented but disabled in the UI, because the service was unavailable during development and its schema could not be verified.
- **Emissions**: EDGAR v8.1 air pollutants, European Commission JRC, https://edgar.jrc.ec.europa.eu/dataset_ap81, CC BY 4.0. Gridded 2022 PM2.5 for nine sectors, mapped to vehicles, industry and power, and residential; changes: regridded to the model domain, cropped to India and converted to kg per hour. Details in `docs/data-notes.md`.
- **Terrain**: Terrarium elevation tiles from the AWS Terrain Tiles open dataset (Mapzen/Tilezen; sources include SRTM, GMTED and ETOPO1).
- **Basemap**: CARTO Dark Matter, © CARTO, © OpenStreetMap contributors (ODbL).
- **India boundary**: state polygons from the third-party repository datta07/INDIAN-SHAPEFILES (MIT licence), believed to follow the official Government of India depiction (Jammu and Kashmir including PoK, Ladakh including Aksai Chin, Arunachal Pradesh in full) and checked by inspection, not by any official certification. The upstream README says some data reflects 2019 boundaries; the outline is simplified to about 1 km and is not suitable for legal use. Drawn over the basemap, whose own boundaries are not relied on.

## What the model does NOT do

- **Secondary aerosol.** Nitrate, sulphate and secondary organic aerosol formed in the air are not simulated. In a north-Indian winter they are a large part of measured PM2.5, so simulated values are expected to read low.
- **Inflow from outside India (partly).** Satellite-detected fires anywhere in the map domain (66–98°E, 6–38°N), including Pakistan, Nepal and Bangladesh, ARE simulated and appear under "Fires (satellite) — other states and neighbouring countries". Anthropogenic inventory emissions (vehicles, industry, residential) outside India are NOT simulated, including Pakistani Punjab (upwind of Delhi in winter), Nepal and Bangladesh. Fires in the "other" group use the generic vegetation emission factor, not the crop-residue factor; for crop-residue fires in Pakistani Punjab this is a known approximation.
- **Vertical structure and chemistry.** One well-mixed layer only; no chemistry.
- **Dust baseline.** No usable gridded road and construction dust inventory was available, so its baseline is zero; dust enters only through dropped sources. About 30 % of the vehicles sector is resuspended road dust as reported by EDGAR.
- **Fire under-detection.** Satellites miss small and short-lived fires and fires under cloud or smoke; the fire scaling slider (default 1, no correction) is there for this.
- **Night fires** seen only at night are taken at their observed fire radiative power without scaling up to a daytime peak, so they are under-counted by design.
- **Emission timing.** Inventory emissions are annual means: no daily, weekly or seasonal profile (for example winter heating).
- **Sampling uncertainty.** Values come from a finite number of particles. Hourly source shares carry about ±5 percentage points at Delhi and ±10–15 at Lucknow and Mumbai (other cities were not measured and are likely similar or worse); shares within that margin are not ordered, and 3–6 hour or daily means are more reliable than single hours.
- **Measurement alignment.** CPCB hours are half-hour-offset averages aligned to UTC hours by overlap weighting; any hour needing a missing period is missing.
- **Forecast fires.** The forecast assumes fires persist at the mean of the last three complete days.

## Validation

`make validate` compares the model with CPCB measurements at the 28 northern cities (Delhi to Muzaffarpur) for 2025-11-03 to 2025-11-09, hourly, at default weights, and writes `docs/validation/2025-11.md` and the data behind the in-app Validation dialog. CAMS is compared over the same hours as the model. Headline numbers:

| | n | NMB | FAC2 | pooled r | median per-city r |
|---|---|---|---|---|---|
| All 28 cities, model | 4094 | -0.62 | 0.30 | 0.24 | 0.18 |
| All 28 cities, CAMS | 4094 | -0.29 | 0.72 | 0.20 | 0.38 |
| Delhi NCR (5 cities), model | 745 | -0.50 | 0.38 | 0.02 | 0.06 |
| Delhi NCR (5 cities), CAMS | 745 | -0.52 | 0.57 | 0.12 | 0.29 |

- The model reads low: pooled NMB -0.62 (mean 34 against 90 µg/m³ measured), lower than measured in 27 of 28 cities, by day and at night.
- About 30 % of the model's hours are within a factor of two of the measurement, against 72 % for CAMS.
- Hour-to-hour agreement with measurements is weak for both: the median per-city r is 0.18 for the model and 0.38 for CAMS.
- CAMS is closer in level (pooled NMB -0.29). In Delhi NCR both read low by about half.
- Pooled r is a correlation across all city-hours and includes differences between cities. The pooled r difference between model and CAMS is not a meaningful ranking; the model's r exceeds CAMS's in 4 of 28 cities.

No parameter was fitted to these measurements. The full tables, method and reading are in [docs/validation/2025-11.md](docs/validation/2025-11.md).

## Known limitations of the app

- **Measured-data gap.** CPCB PM2.5 in OpenAQ has a gap from about October 2022 to 2025-02-18; dates in between show "No CPCB data for these dates" (the simulation itself still runs). This is why the validation episode is November 2025, not November 2023.
- **No live feed.** The data.gov.in live CPCB feed could not be checked against real replies because the service was down during development, so the app does not request it (the API fetches it only with `?live=1` on `/measured`); all measurements come from OpenAQ.
- **First-run time.** A new date takes one to a few minutes (about a minute when upstream data is already cached); the free Open-Meteo archive may answer "too many requests" for a cold date, in which case retrying a minute later completes from the partly filled cache.
- **Storage.** Everything is stored under `server/data/` (git-ignored), which grows without bound and can be deleted safely at any time (stop the server first):
  - `runs/`: stored runs, about 200 MB each (one current run per date, plus superseded runs kept for two hours). `rm -rf server/data/runs` frees most space; dates are simulated again when opened.
  - `cache/`: upstream responses (FIRMS fires, Open-Meteo weather and CAMS, OpenAQ measurements, terrain tiles and the terrain grid), a few hundred MB after a handful of dates. Deleting it means downloading again.
  - `inventory/`: the EDGAR inventory and its converted grids, about 220 MB; `make setup` downloads it again.
  - `validation.json`: the Validation dialog's data; `make validate` writes it again.

## Project layout

```
server/                 Python API and model (package vayu, FastAPI, uv)
  vayu/api.py           HTTP API used by the web app
  vayu/sim/             particle model (particles.py) and runs (run.py)
  vayu/emissions/       fires, EDGAR inventory, dropped sources
  vayu/clients/         FIRMS, Open-Meteo (weather, CAMS), OpenAQ, data.gov.in
  vayu/receptors.py     city series, breakdown, back-trajectory
  vayu/validate.py      validation against CPCB (make validate)
  vayu/constants.py     physical constants with citations
  scripts/              inventory download, fixture recording
  tests/                pytest suite (recorded responses, no network)
web/                    React + TypeScript + Vite app (MapLibre, deck.gl)
docs/data-notes.md      what was learned about every data source
docs/validation/        validation reports
Makefile                setup, dev, test, validate, build
```

## Licence

TBD by the owner.

## Deviations from the design as built

- **Validation episode.** The design named November 2023; CPCB data in OpenAQ has no measurements for it, so the episode is 2025-11-03 to 2025-11-09.
- **City path.** A city's dotted path is a back-trajectory along the mean wind, not the mean track of the particles that arrived there (design 7.5).
- **Frames.** Map frames and city values are hour means with age-dependent smoothing (see How it works), not instantaneous snapshots.
- **Live measurement.** The data.gov.in live value is not shown; all measurements come from OpenAQ.
- **Map labels.** City labels and markers on the map read "model AQI", because they show the simulated value.
