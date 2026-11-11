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

# --- Fire emissions (vayu.emissions.fires) ---

# Local solar time of peak fire activity: mid-afternoon, matching the geostationary diurnal-cycle
# literature (e.g. Giglio 2007, Remote Sens. Environ. 108, 407-421; Mu et al. 2011, JGR 116,
# D24303). IST = UTC + 5:30, so 14.5 h IST = 09:00 UTC. Design choice, not fitted.
FIRE_PEAK_HOUR_IST = 14.5

# Standard deviation (hours) of the Gaussian diurnal fire-activity profile. Design choice within
# the 2-3 h widths used in the same literature (Mu et al. 2011). Not fitted.
FIRE_SIGMA_H = 2.5

# Biomass burned per unit fire radiative energy: 0.368 kg per MJ (Wooster et al. 2005,
# J. Geophys. Res. 110, D24311, "Retrieval of biomass combustion rates and totals from fire
# radiative power observations").
BIOMASS_KG_PER_MJ = 0.368

# PM2.5 emission factors, g per kg dry biomass burned: Akagi et al. 2011, Atmos. Chem. Phys. 11,
# 4039-4072, Table 1 row "PM2.5" (values confirmed against the paper): crop residue 6.26,
# savanna 7.17 (used for non-crop vegetation fires).
EF_PM25_CROP_G_PER_KG = 6.26
EF_PM25_VEG_G_PER_KG = 7.17

# States whose fires are treated as crop-residue burning (north-Indian stubble burning belt).
CROP_STATES = ("punjab", "haryana", "uttar_pradesh", "madhya_pradesh")

# Multiplier applied by the UI (not by fire_emissions) to the FRP-derived emissions. 1.0 = no
# correction for small-fire under-detection by VIIRS (Randerson et al. 2012, J. Geophys. Res. 117,
# G04012; van der Werf et al. 2017, Earth Syst. Sci. Data 9, 697-720).
FIRE_SCALING_DEFAULT = 1.0

# Lower bound on the diurnal profile value when dividing FRP by it (night-time or far-from-peak
# detections would otherwise be inflated without limit). Design choice, not fitted.
FIRE_PROFILE_FLOOR = 0.05
