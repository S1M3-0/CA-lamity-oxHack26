"""Saved simulation runs, their evacuation safe points and statistics, stored in Tiger Data (api/tiger.py)."""

import base64
import json
from datetime import datetime
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field
from rasterio.features import shapes, sieve
from rasterio.transform import from_bounds

import flood
from api import tiger
from api.weather import WeatherDay, hourly_rain_total

router = APIRouter(prefix="/runs", tags=["runs"])

Hazard = Literal["wildfire", "flood"]
# Evacuation centres must stay at least this far from anywhere the hazard reaches during the run.
SAFE_BUFFER_M: dict[str, float] = {"wildfire": 1000.0, "flood": 150.0}
MAX_SAFE_DISTANCE_M = 15_000.0
MIN_PATCH_CELLS = 4


class Bounds(BaseModel):
    west: float
    south: float
    east: float
    north: float


class RunCreate(BaseModel):
    hazard: Hazard
    place_name: str = Field(min_length=1, max_length=100)
    center: tuple[float, float] = Field(description="[lon, lat]")
    params: dict[str, float | WeatherDay]
    origin: tuple[float, float] | None = Field(default=None, description="[lon, lat] ignition point")
    seed: int = Field(ge=0)
    source: Literal["backend", "browser"]
    bounds: Bounds = Field(description="Edges of the grid the frames were simulated on")
    w: int = Field(ge=1, le=1024)
    h: int = Field(ge=1, le=1024)
    cell_m: float = Field(gt=0)
    frames_per_hour: int = Field(ge=1, le=60)
    area_km2: list[float] = Field(min_length=2, description="Affected area for every frame")
    active_km2: list[float] = Field(min_length=2, description="Burning (fire) or 1 m+ deep (flood) area per frame")
    hourly_masks: list[str] = Field(min_length=1, description="Affected cells at each whole hour, base64 bit-packed, row 0 north")


class SavedRun(BaseModel):
    id: int
    created_at: datetime
    hazard: Hazard
    place_name: str
    center: tuple[float, float]
    params: dict[str, float | WeatherDay]
    origin: tuple[float, float] | None
    seed: int
    source: str
    bounds: Bounds
    w: int
    h: int
    cell_m: float


class SafePoint(BaseModel):
    hour: float
    sector: int = Field(description="0 = north, then clockwise in 45° steps")
    facility_id: int
    name: str
    kind: str
    lon: float
    lat: float
    distance_m: float


class HourStat(BaseModel):
    hour: int
    area_km2: float
    growth_km2: float
    peak_active_km2: float
    rain_mm: float


class RunStats(BaseModel):
    hazard: Hazard
    hourly: list[HourStat]
    summary: dict[str, float]


def _storm_hours(params: dict) -> float:
    # Runs saved before storms had a duration rained for the whole day.
    return params.get("stormHours", 24.0)


def _rain_total(params: dict, hour: float) -> float:
    if params.get("weather"):
        return hourly_rain_total(hour, [h["rainfall"] for h in params["weather"]["hours"]])
    return flood.rain_total(hour, params.get("rainfall", 0.0), _storm_hours(params))


def _tiger(fn, *args):
    try:
        return fn(*args)
    except tiger.TigerUnavailable as exc:
        raise HTTPException(503, str(exc)) from exc


def _saved(row: dict) -> SavedRun:
    origin = (row["origin_lon"], row["origin_lat"]) if row["origin_lon"] is not None else None
    return SavedRun(
        **{k: row[k] for k in ("id", "created_at", "hazard", "place_name", "params", "seed", "source", "w", "h", "cell_m")},
        center=(row["center_lon"], row["center_lat"]),
        origin=origin,
        bounds=Bounds(west=row["west"], south=row["south"], east=row["east"], north=row["north"]),
    )


def _perimeter(mask: np.ndarray, transform) -> str | None:
    """Compact GeoJSON MultiPolygon outlining the affected cells, or None if there are none.

    Patches under MIN_PATCH_CELLS (lone flooded puddles, specks of unburnt ground) are
    smoothed away, which turns a flood's thousands of puddles into tens of outlines and
    keeps the upload to Tiger Data small. Areas are still counted from every cell.
    """
    patches = sieve(mask.astype(np.uint8), size=MIN_PATCH_CELLS, connectivity=8)
    if not patches.any():
        return None
    polys = [
        [[[round(x, 6), round(y, 6)] for x, y in ring] for ring in geom["coordinates"]]
        for geom, _ in shapes(patches, mask=patches.astype(bool), transform=transform, connectivity=8)
    ]
    return json.dumps({"type": "MultiPolygon", "coordinates": polys}, separators=(",", ":"))


@router.post("", response_model=SavedRun, status_code=201)
def create_run(data: RunCreate):
    n_cells = data.w * data.h
    if len(data.active_km2) != len(data.area_km2):
        raise HTTPException(422, "area_km2 and active_km2 must have one value per frame")
    expected_hours = (len(data.area_km2) - 1) // data.frames_per_hour + 1
    if len(data.hourly_masks) != expected_hours:
        raise HTTPException(422, f"Expected {expected_hours} hourly masks, one per whole hour")

    b = data.bounds
    transform = from_bounds(b.west, b.south, b.east, b.north, data.w, data.h)
    tolerance = (b.east - b.west) / data.w / 2
    perimeters = []
    for hour, packed in enumerate(data.hourly_masks):
        try:
            bits = np.unpackbits(np.frombuffer(base64.b64decode(packed), dtype=np.uint8))
        except ValueError as exc:
            raise HTTPException(422, f"Hour {hour} mask isn't valid base64") from exc
        if bits.size < n_cells:
            raise HTTPException(422, f"Hour {hour} mask is too short for a {data.w}x{data.h} grid")
        mask = bits[:n_cells].reshape(data.h, data.w).astype(bool)
        perimeters.append({
            "hour": float(hour),
            "area_km2": float(mask.sum()) * (data.cell_m / 1000) ** 2,
            "geom": _perimeter(mask, transform),
            "tol": tolerance,
        })

    params = data.model_dump(mode="json")["params"]
    stats = [
        {"hour": i / data.frames_per_hour, "area_km2": area, "active_km2": active,
         "rain_mm": _rain_total(params, i / data.frames_per_hour) if data.hazard == "flood" else 0.0}
        for i, (area, active) in enumerate(zip(data.area_km2, data.active_km2))
    ]

    run = {
        "hazard": data.hazard, "place_name": data.place_name,
        "center_lon": data.center[0], "center_lat": data.center[1], "params": params,
        "origin_lon": data.origin[0] if data.origin else None, "origin_lat": data.origin[1] if data.origin else None,
        "seed": data.seed, "source": data.source,
        "west": b.west, "south": b.south, "east": b.east, "north": b.north,
        "w": data.w, "h": data.h, "cell_m": data.cell_m,
    }
    run_id = _tiger(tiger.create_run, run, perimeters, stats)
    return _saved(_tiger(tiger.get_run, run_id))


@router.get("", response_model=list[SavedRun])
def list_runs(limit: int = 6):
    return [_saved(r) for r in _tiger(tiger.list_runs, max(1, min(limit, 50)))]


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: int):
    if not _tiger(tiger.delete_run, run_id):
        raise HTTPException(404, "Run not found")


@router.get("/{run_id}/safe-points", response_model=list[SafePoint])
def get_safe_points(run_id: int):
    run = _tiger(tiger.get_run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    try:
        tiger.ensure_facilities(run)
    except (OSError, ValueError) as exc:  # network errors, timeouts or a garbled reply from OpenStreetMap
        raise HTTPException(502, f"Couldn't fetch evacuation centres from OpenStreetMap: {exc}") from exc
    rows = tiger.safe_points(run_id, SAFE_BUFFER_M[run["hazard"]], MAX_SAFE_DISTANCE_M)
    return [SafePoint(facility_id=r.pop("id"), **r) for r in rows]


@router.get("/{run_id}/stats", response_model=RunStats)
def get_stats(run_id: int):
    run = _tiger(tiger.get_run, run_id)
    if not run:
        raise HTTPException(404, "Run not found")
    hourly, prev = [], 0.0
    for row in tiger.hourly_stats(run_id):
        hourly.append(HourStat(**row, growth_km2=max(0.0, row["area_km2"] - prev) if row["hour"] else 0.0))
        prev = row["area_km2"]

    summary: dict[str, float] = {}
    if hourly:
        final = hourly[-1]
        peak_area = max(hourly, key=lambda s: s.area_km2)
        peak_active = max(hourly, key=lambda s: s.peak_active_km2)
        summary = {
            "final_area_km2": final.area_km2,
            "peak_area_km2": peak_area.area_km2,
            "peak_area_hour": peak_area.hour,
            "peak_active_km2": peak_active.peak_active_km2,
            "peak_active_hour": peak_active.hour,
        }
        if run["hazard"] == "wildfire":
            fastest = max(hourly, key=lambda s: s.growth_km2)
            spreading = [s.growth_km2 for s in hourly if s.growth_km2 > 0]
            summary |= {
                "peak_growth_km2": fastest.growth_km2,
                "peak_growth_hour": fastest.hour,
                "mean_growth_km2": sum(spreading) / len(spreading) if spreading else 0.0,
                "hours_spreading": float(len(spreading)),
            }
        else:
            summary |= {
                "total_rain_mm": final.rain_mm,
                "rain_rate_mm_h": final.rain_mm / 24 if run["params"].get("weather") else run["params"].get("rainfall", 0.0),
                "storm_hours": 24 if run["params"].get("weather") else _storm_hours(run["params"]),
                "hourly_weather": float(bool(run["params"].get("weather"))),
            }
    return RunStats(hazard=run["hazard"], hourly=hourly, summary=summary)
