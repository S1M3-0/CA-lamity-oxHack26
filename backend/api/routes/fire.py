"""Wildfire spread simulation, run by the cellular automaton in backend/CA.py."""

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import CA

router = APIRouter(prefix="/fire", tags=["fire"])


class FireRequest(BaseModel):
    area_map: list[list[str | int]] = Field(min_length=1)
    ignition_points: list[tuple[int, int]] = Field(min_length=1)
    wind_direction: float = Field(ge=0, lt=360, description="Degrees the wind blows from")
    wind_speed: float = Field(ge=0, description="m/s")
    humidity: float = Field(ge=0, le=100, description="Relative humidity, %")
    fuel_map: list[list[float]] | None = None
    elevation: list[list[float]] | None = None
    cell_size: float = Field(default=30.0, gt=0, description="Metres per cell")
    num_frames: int = Field(default=100, ge=1, le=500)
    seed: int | None = None


@router.post("/simulate")
def simulate_fire(data: FireRequest):
    rows, cols = len(data.area_map), len(data.area_map[0])
    for name in ("area_map", "fuel_map", "elevation"):
        grid = getattr(data, name)
        if grid is not None and (len(grid) != rows or any(len(row) != cols for row in grid)):
            raise HTTPException(422, f"{name} must be a {rows}x{cols} grid like area_map")
    return CA.run_simulation(**data.model_dump())
