"""Flood simulation for any place, run by the river-routing automaton in backend/flood.py.

The browser sends the grid it already loaded for the place (elevation, plus land
cover from OpenStreetMap), so this works anywhere, not just where the backend has maps.
Frames come back like the fire's: base64, one byte per cell, row 0 north, with
0 dry, 20 water inside a river channel, and 40..255 flood depth.
"""

import base64

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

import flood

router = APIRouter(prefix="/flood", tags=["flood"])


class FloodRequest(BaseModel):
    w: int = Field(ge=2, le=512)
    h: int = Field(ge=2, le=512)
    cell_m: float = Field(gt=0)
    elevation: str = Field(description="base64 float32 little-endian metres, row 0 north")
    cover: str = Field(description="base64 uint8 per cell: 0 land, 1 river or lake, 2 sea")
    runoff: str = Field(description="base64 uint8 per cell: share of rain that runs off dry ground, 0..255")
    rainfall_mm_h: float = Field(ge=0, le=200, description="Average intensity over the storm")
    storm_hours: float = Field(gt=0, le=24)
    saturation: float = Field(ge=0, le=100, description="How wet the soil is before the storm, %")
    num_frames: int = Field(default=96, ge=1, le=500)
    minutes_per_frame: float = Field(default=15, ge=1, le=60)


def _grid(name: str, b64: str, dtype, shape: tuple[int, int]) -> np.ndarray:
    try:
        a = np.frombuffer(base64.b64decode(b64), dtype=dtype)
    except ValueError as exc:
        raise HTTPException(422, f"{name} isn't valid base64") from exc
    if a.size != shape[0] * shape[1]:
        raise HTTPException(422, f"{name} has {a.size} cells, expected {shape[0]}x{shape[1]}")
    return a.reshape(shape)


@router.post("/simulate")
def simulate_flood(data: FloodRequest):
    shape = (data.h, data.w)
    elevation = _grid("elevation", data.elevation, "<f4", shape)
    cover = _grid("cover", data.cover, np.uint8, shape)
    runoff = _grid("runoff", data.runoff, np.uint8, shape) / 255.0
    if not np.isfinite(elevation).all():
        raise HTTPException(422, "elevation has missing values")

    frames, areas = flood.simulate(
        elevation, cover, runoff, data.cell_m,
        rainfall_mm_h=data.rainfall_mm_h,
        storm_hours=data.storm_hours,
        saturation=data.saturation / 100,
        num_frames=data.num_frames,
        minutes_per_frame=data.minutes_per_frame,
    )
    return {
        "w": data.w,
        "h": data.h,
        "cellM": data.cell_m,
        "frames": [base64.b64encode(f.tobytes()).decode("ascii") for f in frames],
        "area": [round(a, 3) for a in areas],
    }
