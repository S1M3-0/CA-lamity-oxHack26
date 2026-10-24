"""Wildfire spread simulations, run by the cellular automaton in backend/CA.py.

Frames come back as base64 strings, one byte per cell (row 0 is north), using
the values the frontend's renderFrame expects: 0 unburnt, 255 burning, 110 burnt.
"""

import base64

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import CA
from fire_maps import LA_BOUNDS, load_fire_maps

router = APIRouter(prefix="/fire", tags=["fire"])

FRAME_CODES = np.array([0, 255, 110], dtype=np.uint8)  # indexed by CA state


class Weather(BaseModel):
    wind_direction: float = Field(ge=0, lt=360, description="Degrees the wind blows from")
    wind_speed_kmh: float = Field(ge=0, le=200)
    humidity: float = Field(ge=0, le=100, description="Relative humidity, %")
    num_frames: int = Field(default=100, ge=1, le=500)
    steps_per_frame: int = Field(default=1, ge=1, le=20, description="Automaton steps between frames")
    seed: int | None = Field(default=None, ge=0)


class Bounds(BaseModel):
    west: float
    south: float
    east: float
    north: float


class LaFireRequest(Weather):
    ignition_points: list[tuple[float, float]] = Field(min_length=1, description="[lon, lat] pairs")
    bounds: Bounds | None = Field(default=None, description="Area to simulate; all of LA County if omitted")
    max_cells: int = Field(default=256, ge=16, le=1024, description="Cells on the grid's long side")


class GridFireRequest(Weather):
    area_map: list[list[int]] = Field(min_length=1, description="NLCD land-cover codes")
    ignition_points: list[tuple[int, int]] = Field(min_length=1, description="[row, col] pairs")
    fuel_map: list[list[float]] | None = None
    elevation: list[list[float]] | None = None
    cell_size: float = Field(default=30.0, gt=0, description="Metres per cell")


def _run(data: Weather, area_map, ignition, **grids) -> np.ndarray:
    return CA.simulate(
        area_map, ignition,
        wind_direction=data.wind_direction,
        wind_speed=data.wind_speed_kmh / 3.6,
        humidity=data.humidity,
        num_frames=data.num_frames,
        steps_per_frame=data.steps_per_frame,
        seed=data.seed,
        **grids,
    )


def _payload(frames: np.ndarray, cell_size: float, bounds: Bounds | None = None) -> dict:
    cell_km2 = (cell_size / 1000) ** 2
    return {
        "bounds": bounds,
        "w": frames.shape[2],
        "h": frames.shape[1],
        "cellM": cell_size,
        "frames": [base64.b64encode(f.tobytes()).decode("ascii") for f in FRAME_CODES[frames]],
        "area": [round(float(np.count_nonzero(f)) * cell_km2, 3) for f in frames],
    }


@router.post("/la")
def simulate_la(data: LaFireRequest):
    bounds = data.bounds or Bounds(**dict(zip(("west", "south", "east", "north"), LA_BOUNDS)))
    try:
        maps = load_fire_maps((bounds.west, bounds.south, bounds.east, bounds.north), data.max_cells)
    except ValueError as exc:
        raise HTTPException(422, str(exc)) from exc
    except FileNotFoundError as exc:
        raise HTTPException(503, f"{exc}. Download the LA maps into backend/data/maps") from exc

    ignition = [maps.to_cell(lon, lat) for lon, lat in data.ignition_points]
    if None in ignition:
        raise HTTPException(422, "Every ignition point must lie inside bounds")
    fuel = CA.derive_fuel_map(maps.land_cover)
    # Light a 3x3 patch, like a real ignition, so a single unlucky cell doesn't fizzle out.
    ignition = [(r + dr, c + dc) for r, c in (_nearest_fuel(fuel, cell) for cell in ignition)
                for dr in (-1, 0, 1) for dc in (-1, 0, 1)]

    frames = _run(data, maps.land_cover, ignition,
                  elevation=maps.elevation, cell_size=maps.cell_size)
    grid_bounds = Bounds(**dict(zip(("west", "south", "east", "north"), maps.bounds)))
    return _payload(frames, maps.cell_size, grid_bounds)


def _nearest_fuel(fuel: np.ndarray, cell: tuple[int, int], min_fuel: float = 0.2,
                  radius: int = 30) -> tuple[int, int]:
    """Nearest cell with enough fuel to catch, so a click on a road or roof still starts a fire."""
    r, c = cell
    r0, c0 = max(r - radius, 0), max(c - radius, 0)
    rows, cols = np.nonzero(fuel[r0:r + radius + 1, c0:c + radius + 1] >= min_fuel)
    if not rows.size:
        return cell
    k = np.argmin((rows + r0 - r) ** 2 + (cols + c0 - c) ** 2)
    return int(rows[k] + r0), int(cols[k] + c0)


@router.post("/simulate")
def simulate_grid(data: GridFireRequest):
    rows, cols = len(data.area_map), len(data.area_map[0])
    for name in ("area_map", "fuel_map", "elevation"):
        grid = getattr(data, name)
        if grid is not None and (len(grid) != rows or any(len(row) != cols for row in grid)):
            raise HTTPException(422, f"{name} must be a {rows}x{cols} grid like area_map")
    frames = _run(data, data.area_map, data.ignition_points,
                  fuel_map=data.fuel_map, elevation=data.elevation, cell_size=data.cell_size)
    return _payload(frames, data.cell_size)
