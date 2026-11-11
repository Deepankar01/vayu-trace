import numpy as np

from vayu.emissions import Emissions


def _empty(em, tag, h):
    iy, ix, kg = em.hour(tag, h)
    return len(iy) == len(ix) == len(kg) == 0


def test_empty_and_unknown_tag():
    em = Emissions()
    assert em.tags == []
    assert _empty(em, "nope", 0)


def test_add_and_hour():
    em = Emissions()
    em.add("a", 3, [1, 2], [4, 5], [1.0, 2.0])
    iy, ix, kg = em.hour("a", 3)
    assert dict(zip(zip(iy.tolist(), ix.tolist()), kg.tolist())) == {(1, 4): 1.0, (2, 5): 2.0}
    assert _empty(em, "a", 4)
    assert em.tags == ["a"]


def test_hour_unions_constant_and_sparse_summing_coincident_cells():
    em = Emissions()
    grid = np.zeros((320, 320))
    grid[1, 4] = 10.0
    grid[7, 7] = 1.0
    em.set_constant("a", grid)
    em.add("a", 0, [1, 9], [4, 9], [0.5, 2.0])
    iy, ix, kg = em.hour("a", 0)
    assert dict(zip(zip(iy.tolist(), ix.tolist()), kg.tolist())) == {
        (1, 4): 10.5, (7, 7): 1.0, (9, 9): 2.0}
    iy, ix, kg = em.hour("a", 1)  # constant applies to every hour
    assert sorted(kg.tolist()) == [1.0, 10.0]


def test_merge_sums_and_keeps_other_untouched():
    a, b = Emissions(), Emissions()
    a.add("t", 0, [1], [1], [1.0])
    b.add("t", 0, [1], [1], [2.0])
    b.add("u", 2, [3], [3], [4.0])
    g = np.zeros((320, 320))
    g[0, 0] = 1.0
    a.set_constant("c", g)
    b.set_constant("c", g)
    a.merge(b)
    assert a.hour("t", 0)[2].tolist() == [3.0]
    assert a.hour("u", 2)[2].tolist() == [4.0]
    assert a.hour("c", 5)[2].tolist() == [2.0]
    assert b.hour("t", 0)[2].tolist() == [2.0]
    assert b.hour("c", 5)[2].tolist() == [1.0]


def test_scaled_returns_new_and_leaves_original():
    em = Emissions()
    em.add("t", 0, [1], [1], [2.0])
    g = np.zeros((320, 320))
    g[5, 5] = 4.0
    em.set_constant("c", g)
    s = em.scaled(0.5)
    assert s.hour("t", 0)[2].tolist() == [1.0]
    assert s.hour("c", 0)[2].tolist() == [2.0]
    assert em.hour("t", 0)[2].tolist() == [2.0]
    assert em.hour("c", 0)[2].tolist() == [4.0]
