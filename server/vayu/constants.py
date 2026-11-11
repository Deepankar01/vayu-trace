"""Physical constants. Every value cites its source."""

# Mean Earth radius, IUGG 1980 / WGS84 mean radius R1 = (2a + b) / 3 = 6371008.8 m.
EARTH_RADIUS_M = 6_371_008.8

# Meteorology lattice spacing: design choice (1 degree ~ 110 km, the scale of the Open-Meteo
# global-model fields it samples), giving a 33 x 33 lattice over the domain. Not fitted.
MET_STEP_DEG = 1.0

# Coordinates per Open-Meteo request: design choice to keep GET URLs well under server limits
# (Open-Meteo documentation, "multiple coordinates", accepts comma-separated lists).
MET_BATCH = 50

# Weight of the 100 m wind in the blended transport wind (10 m gets 1 - this). Design choice, not
# fitted: the 100 m level is closer to the mixed-layer mean wind that advects a well-mixed plume
# (Stull 1988, An Introduction to Boundary Layer Meteorology, ch. 2 and 9).
WIND_BLEND_100M = 0.7

# Bounds on mixing-layer height used by the model. Stull 1988 ch. 1 gives stable nocturnal layers
# of order 100 m and deep convective layers of up to a few km over land.
BLH_MIN_M = 100.0
BLH_MAX_M = 4000.0

# Heuristic fallback for mixing-layer height where Open-Meteo returns null (see met.estimate_blh).
# Shape and magnitudes follow typical ranges in Stull 1988 ch. 1 and 9 (nocturnal stable layer
# ~100-400 m, mid-afternoon convective layer ~1-3 km in warm conditions). Not fitted to any data.
BLH_NIGHT_BASE_M = 150.0  # calm-night floor
BLH_NIGHT_PER_MS = 30.0  # added per m/s of wind: mechanical mixing
BLH_DAY_BASE_M = 400.0  # daytime convective depth at 0 degC
BLH_DAY_PER_K = 60.0  # added per degC above 0 (more surface heating on warmer days)
BLH_PEAK_LOCAL_HOUR = 14.5  # mid-afternoon maximum
BLH_DAY_HALF_WIDTH_H = 5.0  # convective layer exists within +/- this many hours of the peak
