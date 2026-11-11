"""Point sources a researcher drops on the map: what-if traffic, construction, fireworks or a
custom PM2.5 rate at one cell.

Every factor below is derived from a published emission factor; the arithmetic is written out
next to it, and everything that is an assumption rather than a published number says so. These
are order-of-magnitude scenario tools, not an inventory: a real site, road or event can differ
from them by a factor of several.
"""
import math
from collections.abc import Callable
from dataclasses import dataclass

from vayu.domain import cell_index, inside
from vayu.emissions import Emissions

MAX_DURATION_H = 72

# --- traffic -------------------------------------------------------------------------------
# PM2.5 per vehicle-km, exhaust plus non-exhaust, for an ASSUMED fleet mix.
#
# Exhaust, g/km (ARAI 2010 Indian emission factors as tabulated by TERI, "Development of
# spatially resolved air pollution emission inventory of India", Table 18, newest vintage given):
#   petrol two-wheeler 4-stroke, post 2010 ......... 0.003
#   petrol car (LDV-4s), post 2010 ................. 0.00  (the table rounds it to zero)
#   diesel three-wheeler 4-stroke, post 2010 ....... 0.090
#   diesel heavy-duty truck, post 2010 ............. 0.39
# Non-exhaust, g/km, tyre + brake + road-surface wear (EMEP/EEA Tier 1 values as applied in the
# German inventory, UBA IIR 1.A.3.b.vi and 1.A.3.b.vii, mg/km converted to g/km):
#   two-wheeler  0.00193 + 0.00144 + 0.00162 = 0.00499
#   car          0.00449 + 0.00293 + 0.00405 = 0.01147
#   three-wheeler (light-duty values) 0.00710 + 0.00456 + 0.00405 = 0.01571
#   truck        0.0189  + 0.0127  + 0.0205  = 0.0521
# ASSUMED mix (roughly an Indian urban fleet by vehicle count, not from a cited survey):
#   70 % two-wheelers, 20 % cars, 5 % three-wheelers, 5 % trucks
#   0.70 x 0.00799 + 0.20 x 0.01147 + 0.05 x 0.10571 + 0.05 x 0.4421 = 0.03528 g/km
# ASSUMED distance: 30 km per vehicle per day, spread evenly over 24 h:
#   0.03528 g/km x 30 km / 24 h = 0.0441 g per vehicle per hour = 4.41e-5 kg/h per vehicle.
# Not included: resuspended road dust, which for Indian roads can exceed all of the above.
TRAFFIC_SOURCE = "https://www.teriin.org/sites/default/files/files/ap-Chapter6.pdf"
_UBA_ROAD = ("https://iir.umweltbundesamt.de/2025/sector/energy/fuel_combustion/transport/"
             "road_transport/abrasive_emissions_from_road_vehicles/")
TRAFFIC_NONEXHAUST_SOURCES = (_UBA_ROAD + "tyre_and_brake_wear", _UBA_ROAD + "road_abrasion")
_FLEET = {  # class: (share of vehicles, exhaust g/km, (tyre, brake, road) g/km)
    "two_wheeler": (0.70, 0.003, (0.00193, 0.00144, 0.00162)),
    "car": (0.20, 0.0, (0.00449, 0.00293, 0.00405)),
    "three_wheeler": (0.05, 0.090, (0.00710, 0.00456, 0.00405)),
    "truck": (0.05, 0.39, (0.0189, 0.0127, 0.0205)),
}
FLEET_G_PER_KM = sum(share * (exhaust + sum(wear)) for share, exhaust, wear in _FLEET.values())
KM_PER_VEHICLE_DAY = 30.0  # assumption, see above
TRAFFIC_KG_PER_VEHICLE_HOUR = FLEET_G_PER_KM * 1e-3 * KM_PER_VEHICLE_DAY / 24.0

# --- construction --------------------------------------------------------------------------
# Site-average PM10 from construction: 0.11 short ton PM10 per acre per month of activity
# (Midwest Research Institute 1996, with watering controlling dust by 50 %), and PM2.5 as
# 4.89 % / 48.93 % = 0.0999 of PM10 (CARB speciation profile 420); both as used by the Bay Area
# AQMD emission inventory methodology (source URL). The month is 30 days of activity, as in
# US EPA AP-42 13.2.3, spread evenly over 720 h:
#   0.11 x 907.185 kg / 4046.86 m2 = 0.024659 kg PM10 per m2 per month
#   x 0.0999 = 0.0024644 kg PM2.5 per m2 per month; / 720 h = 3.423e-6 kg/h per m2 of site.
# A 1 hectare site is therefore about 0.034 kg PM2.5 per hour.
CONSTRUCTION_SOURCE = "https://baaqmd.github.io/BY2015-methodology/10-01-misc-construction.html"
SHORT_TON_KG = 907.18474
ACRE_M2 = 4046.8564224
PM10_SHORT_TON_PER_ACRE_MONTH = 0.11
PM25_OF_PM10 = 4.89 / 48.93
HOURS_PER_ACTIVITY_MONTH = 30 * 24
CONSTRUCTION_KG_PER_M2_HOUR = (PM10_SHORT_TON_PER_ACRE_MONTH * SHORT_TON_KG / ACRE_M2
                               * PM25_OF_PM10 / HOURS_PER_ACTIVITY_MONTH)

# --- fireworks -----------------------------------------------------------------------------
# PM2.5 per tonne of fireworks product burnt: 40,080 g/t (German inventory, New Year's Eve 2023,
# measured values from the pyrotechnics industry association VPI; UBA IIR 2.G(a)). The amount
# of product per event is an ASSUMPTION, chosen as round orders of magnitude:
#   1 small  =    10 kg product (a street celebration)  ->  0.40 kg PM2.5
#   2 medium =   100 kg product (a neighbourhood)       ->  4.0 kg PM2.5
#   3 large  = 1,000 kg product (a large public show)   -> 40.1 kg PM2.5
# The event total is spread evenly over the requested duration. `kg_per_hour` gives the rate
# for a FIREWORKS_NOMINAL_H event, for display.
FIREWORKS_SOURCE = ("https://iir.umweltbundesamt.de/2025/sector/ippu/other_product_use/"
                    "fireworks/start")
FIREWORKS_PM25_KG_PER_KG = 40_080.40 / 1e6
FIREWORKS_PRODUCT_KG = {1: 10.0, 2: 100.0, 3: 1000.0}
FIREWORKS_SIZE_NAMES = {1: "small", 2: "medium", 3: "large"}
FIREWORKS_TOTAL_KG = {k: v * FIREWORKS_PM25_KG_PER_KG for k, v in FIREWORKS_PRODUCT_KG.items()}
FIREWORKS_NOMINAL_H = 3


def _fireworks_total(size: float) -> float:
    if size not in FIREWORKS_TOTAL_KG:
        raise ValueError("fireworks amount must be an event size: 1 small, 2 medium, 3 large")
    return FIREWORKS_TOTAL_KG[int(size)]


@dataclass(frozen=True)
class Kind:
    label: str
    unit: str
    kg_per_hour: Callable[[float], float]  # kg PM2.5 per hour for `amount` units
    source: str  # citation URL for the factor
    total_kg: Callable[[float], float] | None = None  # event kinds: total kg PM2.5 per event


KINDS: dict[str, Kind] = {
    "traffic": Kind(
        "Traffic (assumed mixed Indian fleet, 30 km per vehicle per day, no road dust)",
        "vehicles", lambda n: n * TRAFFIC_KG_PER_VEHICLE_HOUR, TRAFFIC_SOURCE),
    "construction": Kind(
        "Construction site (US site-average dust factor, watered)",
        "m² of site", lambda m2: m2 * CONSTRUCTION_KG_PER_M2_HOUR, CONSTRUCTION_SOURCE),
    "fireworks": Kind(
        "Fireworks (assumed 10 / 100 / 1000 kg of product per event)",
        "small / medium / large event",
        lambda size: _fireworks_total(size) / FIREWORKS_NOMINAL_H, FIREWORKS_SOURCE,
        total_kg=_fireworks_total),
    # No factor: the user gives kg PM2.5 per hour directly. The link is where to look one up.
    "custom": Kind("Custom source", "kg PM2.5 per hour", lambda kg: kg,
                   "https://www.eea.europa.eu/publications/emep-eea-guidebook-2023"),
}


def dropped_emissions(kind: str, lon: float, lat: float, amount: float, start_hour: int,
                      duration_h: int, hours: int, *, tag_id: str = "user") -> Emissions:
    """A constant-rate point source in the cell containing (lon, lat), emitting in hours
    [start_hour, start_hour + duration_h) of a `hours`-hour window (truncated at its end).

    Event kinds (fireworks) spread their total over `duration_h`; the others emit
    `kg_per_hour(amount)` every hour. Raises ValueError for an unknown kind, a point outside the
    domain, a non-positive or non-finite amount, `start_hour` outside 0..hours-1 or `duration_h`
    outside 1..MAX_DURATION_H.
    """
    spec = KINDS.get(kind)
    if spec is None:
        raise ValueError(f"unknown kind {kind!r}; expected one of {', '.join(KINDS)}")
    if not (math.isfinite(amount) and amount > 0):
        raise ValueError("amount must be a positive finite number")
    if not 0 <= start_hour < hours:
        raise ValueError(f"start_hour must be in 0..{hours - 1}")
    if not 1 <= duration_h <= MAX_DURATION_H:
        raise ValueError(f"duration_h must be in 1..{MAX_DURATION_H}")
    ix, iy = cell_index(lon, lat)
    if not inside(ix, iy):
        raise ValueError(f"({lon}, {lat}) is outside the model domain")
    rate = (spec.total_kg(amount) / duration_h if spec.total_kg is not None
            else spec.kg_per_hour(amount))
    em = Emissions()
    for h in range(start_hour, min(start_hour + duration_h, hours)):
        em.add(tag_id, h, [int(iy)], [int(ix)], [rate])
    return em
