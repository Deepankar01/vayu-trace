"""The 40 cities the simulator compares against CPCB measurements (city-centre coordinates)."""
from typing import NamedTuple


class City(NamedTuple):
    id: str  # lowercase slug
    name: str
    lat: float
    lon: float


CITIES: tuple[City, ...] = (
    City("delhi", "Delhi", 28.6139, 77.2090),
    City("gurugram", "Gurugram", 28.4595, 77.0266),
    City("noida", "Noida", 28.5355, 77.3910),
    City("ghaziabad", "Ghaziabad", 28.6692, 77.4538),
    City("faridabad", "Faridabad", 28.4089, 77.3178),
    City("amritsar", "Amritsar", 31.6340, 74.8723),
    City("ludhiana", "Ludhiana", 30.9010, 75.8573),
    City("jalandhar", "Jalandhar", 31.3260, 75.5762),
    City("patiala", "Patiala", 30.3398, 76.3869),
    City("bathinda", "Bathinda", 30.2110, 74.9455),
    City("chandigarh", "Chandigarh", 30.7333, 76.7794),
    City("ambala", "Ambala", 30.3782, 76.7767),
    City("hisar", "Hisar", 29.1492, 75.7217),
    City("rohtak", "Rohtak", 28.8955, 76.6066),
    City("karnal", "Karnal", 29.6857, 76.9905),
    City("panipat", "Panipat", 29.3909, 76.9635),
    City("meerut", "Meerut", 28.9845, 77.7064),
    City("agra", "Agra", 27.1767, 78.0081),
    City("kanpur", "Kanpur", 26.4499, 80.3319),
    City("lucknow", "Lucknow", 26.8467, 80.9462),
    City("prayagraj", "Prayagraj", 25.4358, 81.8463),
    City("varanasi", "Varanasi", 25.3176, 82.9739),
    City("gorakhpur", "Gorakhpur", 26.7606, 83.3732),
    City("bareilly", "Bareilly", 28.3670, 79.4304),
    City("moradabad", "Moradabad", 28.8386, 78.7733),
    City("patna", "Patna", 25.5941, 85.1376),
    City("gaya", "Gaya", 24.7914, 85.0002),
    City("muzaffarpur", "Muzaffarpur", 26.1209, 85.3647),
    City("jaipur", "Jaipur", 26.9124, 75.7873),
    City("jodhpur", "Jodhpur", 26.2389, 73.0243),
    City("bhopal", "Bhopal", 23.2599, 77.4126),
    City("indore", "Indore", 22.7196, 75.8577),
    City("ahmedabad", "Ahmedabad", 23.0225, 72.5714),
    City("mumbai", "Mumbai", 19.0760, 72.8777),
    City("pune", "Pune", 18.5204, 73.8567),
    City("hyderabad", "Hyderabad", 17.3850, 78.4867),
    City("bengaluru", "Bengaluru", 12.9716, 77.5946),
    City("chennai", "Chennai", 13.0827, 80.2707),
    City("kolkata", "Kolkata", 22.5726, 88.3639),
    City("guwahati", "Guwahati", 26.1445, 91.7362),
)

BY_ID: dict[str, City] = {c.id: c for c in CITIES}
