from vayu import cities


def test_forty_unique_cities_with_slug_ids():
    assert len(cities.CITIES) == 40
    assert len({c.id for c in cities.CITIES}) == 40
    assert all(c.id == c.name.lower() for c in cities.CITIES)


def test_delhi_centre_and_india_bounds():
    delhi = cities.BY_ID["delhi"]
    assert (delhi.lat, delhi.lon) == (28.6139, 77.2090)
    assert all(8 < c.lat < 37 and 68 < c.lon < 98 for c in cities.CITIES)
