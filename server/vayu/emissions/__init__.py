"""Sparse emission container shared by the fire, sector and user-source emitters."""
from collections import defaultdict

import numpy as np

from vayu.domain import NX, NY

_EMPTY = (np.empty(0, dtype=np.int64), np.empty(0, dtype=np.int64), np.empty(0, dtype=np.float64))


class Emissions:
    """kg PM2.5 per (tag, hour, cell). Hour-varying sources are sparse triples; time-invariant
    sources are one (NY, NX) grid per tag that applies to every hour."""

    def __init__(self) -> None:
        self._sparse: dict[str, dict[int, list[tuple[np.ndarray, np.ndarray, np.ndarray]]]] = (
            defaultdict(lambda: defaultdict(list)))
        self._const: dict[str, np.ndarray] = {}

    @property
    def tags(self) -> list[str]:
        return sorted(set(self._sparse) | set(self._const))

    def add(self, tag_id: str, h: int, iy, ix, kg) -> None:
        iy, ix = np.asarray(iy, dtype=np.int64), np.asarray(ix, dtype=np.int64)
        kg = np.asarray(kg, dtype=np.float64)
        if not (iy.shape == ix.shape == kg.shape):
            raise ValueError("iy, ix and kg must have the same shape")
        if iy.size:
            self._sparse[tag_id][h].append((iy.ravel(), ix.ravel(), kg.ravel()))

    def set_constant(self, tag_id: str, grid: np.ndarray) -> None:
        if grid.shape != (NY, NX):
            raise ValueError(f"grid must have shape {(NY, NX)}")
        self._const[tag_id] = np.array(grid, dtype=np.float64)

    def hour(self, tag_id: str, h: int) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
        """(iy, ix, kg) of cells with non-zero emission in hour `h`; coinciding cells summed."""
        iys, ixs, kgs = [], [], []
        const = self._const.get(tag_id)
        if const is not None:
            iy, ix = np.nonzero(const)
            iys.append(iy), ixs.append(ix), kgs.append(const[iy, ix])
        for iy, ix, kg in self._sparse.get(tag_id, {}).get(h, ()):
            iys.append(iy), ixs.append(ix), kgs.append(kg)
        if not iys:
            return tuple(a.copy() for a in _EMPTY)
        flat = np.concatenate(iys) * NX + np.concatenate(ixs)
        uniq, inv = np.unique(flat, return_inverse=True)
        total = np.zeros(uniq.size)
        np.add.at(total, inv, np.concatenate(kgs))
        keep = total != 0
        uniq, total = uniq[keep], total[keep]
        return uniq // NX, uniq % NX, total

    def merge(self, other: "Emissions") -> None:
        """Add all of `other` into this container (constants of the same tag are summed)."""
        for tag, by_hour in other._sparse.items():
            for h, parts in by_hour.items():
                self._sparse[tag][h].extend(parts)
        for tag, grid in other._const.items():
            self._const[tag] = self._const[tag] + grid if tag in self._const else grid.copy()

    def scaled(self, factor: float) -> "Emissions":
        out = Emissions()
        for tag, by_hour in self._sparse.items():
            for h, parts in by_hour.items():
                for iy, ix, kg in parts:
                    out.add(tag, h, iy, ix, kg * factor)
        for tag, grid in self._const.items():
            out._const[tag] = grid * factor
        return out
