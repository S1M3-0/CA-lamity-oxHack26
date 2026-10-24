"""Loads the Los Angeles wildfire maps as grids for the cellular automaton in CA.py.

Source rasters (backend/data/maps, not in git):
  LA_DEM_3DEP_1arcsec.tif      USGS 3DEP 1 arc-second (~30 m) elevation, metres
  LA_NLCD_2021_Land_Cover.tif  NLCD 2021 land cover, 30 m class codes

`load_fire_maps` crops both to the requested bounds, downsamples them onto
one regular lon/lat grid (row 0 is north, the layout the frontend uses) and
caches the result in memory and in backend/data/cache.
"""

import math
from dataclasses import dataclass
from functools import lru_cache
from pathlib import Path

import numpy as np
import rasterio
from rasterio.enums import Resampling
from rasterio.transform import from_bounds
from rasterio.warp import reproject

DATA_DIR = Path(__file__).resolve().parent / "data"
DEM_PATH = DATA_DIR / "maps" / "LA_DEM_3DEP_1arcsec.tif"
LAND_COVER_PATH = DATA_DIR / "maps" / "LA_NLCD_2021_Land_Cover.tif"
CACHE_DIR = DATA_DIR / "cache"

# Mainland Los Angeles County, (west, south, east, north) in degrees.
LA_BOUNDS = (-118.95, 33.70, -117.64, 34.83)

NATIVE_CELL_M = 30.0   # resolution of both source maps
METRES_PER_DEG = 111_320.0

Bounds = tuple[float, float, float, float]


@dataclass(frozen=True)
class FireMaps:
    bounds: Bounds          # (west, south, east, north) of the grid's outer edges
    cell_size: float        # metres per cell
    elevation: np.ndarray   # float32, metres
    land_cover: np.ndarray  # uint8, NLCD class codes (0 = no data)

    @property
    def shape(self) -> tuple[int, int]:
        return self.elevation.shape

    def to_cell(self, lon: float, lat: float) -> tuple[int, int] | None:
        """(row, col) of the cell holding a point, or None if it's outside the grid."""
        west, south, east, north = self.bounds
        rows, cols = self.shape
        col = math.floor((lon - west) / (east - west) * cols)
        row = math.floor((north - lat) / (north - south) * rows)
        return (row, col) if 0 <= row < rows and 0 <= col < cols else None


def load_fire_maps(bounds: Bounds = LA_BOUNDS, max_cells: int = 256) -> FireMaps:
    """Elevation and land cover for `bounds`, at most `max_cells` cells on the long side.

    Cells are roughly square in metres and never finer than the 30 m source data.
    """
    west, south, east, north = bounds
    la_west, la_south, la_east, la_north = LA_BOUNDS
    if not (west < east and south < north):
        raise ValueError("bounds must be (west, south, east, north)")
    if west < la_west or south < la_south or east > la_east or north > la_north:
        raise ValueError(f"bounds must lie inside Los Angeles County {LA_BOUNDS}")
    if max_cells < 2:
        raise ValueError("max_cells must be at least 2")
    # Round so near-identical requests share a cache entry (~10 m).
    return _load(tuple(round(v, 4) for v in bounds), max_cells)


@lru_cache(maxsize=16)
def _load(bounds: Bounds, max_cells: int) -> FireMaps:
    west, south, east, north = bounds
    mid_lat = math.radians((south + north) / 2)
    width_m = (east - west) * METRES_PER_DEG * math.cos(mid_lat)
    height_m = (north - south) * METRES_PER_DEG
    cell = max(max(width_m, height_m) / max_cells, NATIVE_CELL_M)
    cols, rows = max(1, round(width_m / cell)), max(1, round(height_m / cell))
    cell_size = (width_m / cols + height_m / rows) / 2

    cache_file = CACHE_DIR / f"fire_{west}_{south}_{east}_{north}_{max_cells}.npz"
    if cache_file.is_file():
        with np.load(cache_file) as cached:
            return FireMaps(bounds, cell_size, cached["elevation"], cached["land_cover"])

    transform = from_bounds(west, south, east, north, cols, rows)
    # Averaging smooths elevation; land cover keeps the most common class per cell.
    elevation = _resample(DEM_PATH, transform, (rows, cols), np.float32, Resampling.average)
    land_cover = _resample(LAND_COVER_PATH, transform, (rows, cols), np.uint8, Resampling.mode)
    elevation[~np.isfinite(elevation)] = 0.0  # gaps in the DEM are offshore

    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    np.savez_compressed(cache_file, elevation=elevation, land_cover=land_cover)
    return FireMaps(bounds, cell_size, elevation, land_cover)


def _resample(path: Path, transform, shape: tuple[int, int], dtype, method: Resampling) -> np.ndarray:
    if not path.is_file():
        raise FileNotFoundError(f"Missing map {path}")
    fill = np.nan if dtype == np.float32 else 0
    out = np.full(shape, fill, dtype=dtype)
    with rasterio.open(path) as src:
        reproject(
            source=rasterio.band(src, 1),
            destination=out,
            src_nodata=src.nodata,
            dst_transform=transform,
            dst_crs="EPSG:4326",
            dst_nodata=fill,
            resampling=method,
        )
    return out
