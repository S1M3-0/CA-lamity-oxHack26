"""Fastest safe routes for fire crews and local authorities, planned by backend/routing.py.

Roads, fire stations, police stations and ambulance stations come from OpenStreetMap.
They're fetched once per area and cached in backend/data/cache, since a city's roads
can take a minute to download. That's longer than the proxies in front of the API
will hold a request open (Next.js gives up after 30 s), so the download runs in the
background: until it's done the endpoint answers 202 "preparing" and the browser
asks again.
"""

import base64
import gzip
import json
import threading
import urllib.parse
import urllib.request
from concurrent.futures import Future, ThreadPoolExecutor, wait
from functools import lru_cache
from pathlib import Path
from typing import Literal

import numpy as np
from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

import routing
from api.tiger import OVERPASS_URL

router = APIRouter(prefix="/responders", tags=["responders"])

CACHE_DIR = Path(__file__).resolve().parents[2] / "data" / "cache"
# Stations and the main roads to them are fetched this far (~5 km) past the simulated area.
MARGIN_DEG = 0.05
NEVER_FRAME = 255
# The main Overpass server is often overloaded, so fall back to public mirrors.
OVERPASS_URLS = [
    OVERPASS_URL,
    "https://overpass.kumi.systems/api/interpreter",
    "https://overpass.private.coffee/api/interpreter",
]
MINOR = "|".join(routing.SPEED_KMH)
MAJOR = "motorway|trunk|primary|secondary|tertiary|motorway_link|trunk_link|primary_link|secondary_link|tertiary_link"
ROADS_QUERY = """[out:json][timeout:120];
(
  way["highway"~"^({minor})$"]({s},{w},{n},{e});
  way["highway"~"^({major})$"]({ms},{mw},{mn},{me});
);
out body geom qt;
(
  nwr["amenity"~"^(fire_station|police)$"]({ms},{mw},{mn},{me});
  nwr["emergency"="ambulance_station"]({ms},{mw},{mn},{me});
);
out center tags qt;"""


class Bounds(BaseModel):
    west: float
    south: float
    east: float
    north: float


class RouteRequest(BaseModel):
    bounds: Bounds = Field(description="Edges of the grid the frames were simulated on")
    w: int = Field(ge=1, le=1024)
    h: int = Field(ge=1, le=1024)
    frames_per_hour: int = Field(ge=1, le=60)
    arrival: str = Field(description=f"base64, one byte per cell, row 0 north: frame the hazard first reaches it, {NEVER_FRAME} = never")


class Station(BaseModel):
    name: str
    kind: str
    lon: float
    lat: float


class Target(BaseModel):
    lon: float
    lat: float
    hazard_eta_h: float | None = Field(description="Simulated hour the hazard reaches this street, if it does")
    residential: bool


class ResponderRoute(BaseModel):
    hour: float
    goal: Literal["people", "front"] = Field(description="people: a street the hazard reaches next; front: the nearest open road to its edge")
    station: Station
    target: Target
    travel_s: float
    distance_m: float
    spare_s: float | None = Field(description="Time the crew arrives before the hazard (negative: after it); None for the front")
    path: list[tuple[float, float]] = Field(description="[lon, lat] from the station to the target")


def _area(b: Bounds) -> tuple[float, float, float, float]:
    # Rounded so the browser grid and the backend's LA grid for one place share a cache entry.
    return round(b.south, 3), round(b.west, 3), round(b.north, 3), round(b.east, 3)


def _fetch(area: tuple[float, float, float, float]) -> list[dict]:
    """Overpass elements for an area, from the disk cache when possible."""
    s, w, n, e = area
    cache_file = CACHE_DIR / f"roads_{s}_{w}_{n}_{e}.json.gz"
    if cache_file.is_file():
        with gzip.open(cache_file, "rt", encoding="utf-8") as f:
            return json.load(f)
    query = ROADS_QUERY.format(minor=MINOR, major=MAJOR, s=s, w=w, n=n, e=e,
                               ms=s - MARGIN_DEG, mw=w - MARGIN_DEG, mn=n + MARGIN_DEG, me=e + MARGIN_DEG)
    body = urllib.parse.urlencode({"data": query}).encode()
    elements, error = None, None
    for url in OVERPASS_URLS:
        request = urllib.request.Request(url, data=body, headers={"User-Agent": "CA-lamity/0.1 (hackathon)"})
        try:
            with urllib.request.urlopen(request, timeout=150) as response:
                elements = json.load(response)["elements"]
            break
        except (OSError, ValueError, KeyError) as exc:  # busy (429/502/504), unreachable or a garbled reply: try the next
            error = exc
    if elements is None:
        raise error
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    # Write then rename, so a server stopped mid-write doesn't leave a broken cache file behind.
    partial = cache_file.with_suffix(".partial")
    with gzip.open(partial, "wt", encoding="utf-8") as f:
        json.dump(elements, f, separators=(",", ":"))
    partial.replace(cache_file)
    return elements


def _stations(elements: list[dict]) -> list[routing.Station]:
    out = []
    for el in elements:
        tags = el.get("tags", {})
        kind = "ambulance_station" if tags.get("emergency") == "ambulance_station" else tags.get("amenity")
        if kind not in ("fire_station", "police", "ambulance_station"):
            continue
        lat, lon = el.get("lat") or el.get("center", {}).get("lat"), el.get("lon") or el.get("center", {}).get("lon")
        if lat is not None and lon is not None:
            out.append(routing.Station(tags.get("name") or kind.replace("_", " ").title(), kind, lon, lat))
    return out


@lru_cache(maxsize=8)
def _graph(area: tuple[float, float, float, float]) -> routing.RoadGraph:
    elements = _fetch(area)
    return routing.build_graph([el for el in elements if el["type"] == "way"], _stations(elements))


# One background download per area at a time; later requests for it wait on the same one.
_loader = ThreadPoolExecutor(max_workers=2, thread_name_prefix="roads")
_loading: dict[tuple[float, float, float, float], Future] = {}
_loading_lock = threading.Lock()


def _ready_graph(area: tuple[float, float, float, float], wait_s: float) -> routing.RoadGraph | None:
    """The area's road graph, or None if it's still downloading after `wait_s` seconds.
    Raises the download's error once, so the next request starts a fresh attempt."""
    with _loading_lock:
        future = _loading.get(area)
        if future is None:
            future = _loading[area] = _loader.submit(_graph, area)
    # wait() rather than result(timeout=...): a socket timeout inside the download is also a
    # TimeoutError, and must fail the request instead of looking like "still downloading".
    if not wait([future], timeout=wait_s).done:
        return None
    with _loading_lock:
        if _loading.get(area) is future:
            del _loading[area]  # on success _graph's lru_cache keeps the result; on failure retry fresh
    return future.result()


class RoutesReady(BaseModel):
    status: Literal["ready"] = "ready"
    routes: list[ResponderRoute]


class RoutesPreparing(BaseModel):
    status: Literal["preparing"] = "preparing"
    detail: str


# How long a request waits for a download before answering 202, well inside the proxies' 30 s.
WAIT_S = 15.0


@router.post("/routes", response_model=RoutesReady, responses={202: {"model": RoutesPreparing}})
def responder_routes(data: RouteRequest):
    try:
        frames = np.frombuffer(base64.b64decode(data.arrival, validate=True), dtype=np.uint8)
    except ValueError as exc:
        raise HTTPException(422, "arrival isn't valid base64") from exc
    if frames.size != data.w * data.h:
        raise HTTPException(422, f"arrival must have one byte per cell of the {data.w}x{data.h} grid")
    arrival = np.where(frames == NEVER_FRAME, routing.NEVER, frames / data.frames_per_hour).reshape(data.h, data.w)

    b = data.bounds
    try:
        graph = _ready_graph(_area(b), WAIT_S)
    except (OSError, ValueError, KeyError) as exc:  # network errors, timeouts or a garbled reply from OpenStreetMap
        raise HTTPException(502, f"Couldn't fetch roads and stations from OpenStreetMap: {exc}") from exc
    if graph is None:
        preparing = RoutesPreparing(detail="Downloading roads and stations for this area from OpenStreetMap")
        return JSONResponse(preparing.model_dump(), status_code=202)
    if not graph.stations:
        raise HTTPException(404, "No fire, police or ambulance stations found on the roads near this area")
    hours = [float(h) for h in range(int(np.max(frames[frames != NEVER_FRAME], initial=0)) // data.frames_per_hour + 1)]
    return RoutesReady(routes=routing.plan_routes(graph, (b.west, b.south, b.east, b.north), arrival, hours))
