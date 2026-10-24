"""GeoJSON areas of interest served to the map through the existing /api proxy."""

import json
from pathlib import Path

from fastapi import APIRouter, HTTPException
from fastapi.responses import JSONResponse

router = APIRouter(prefix="/aoi", tags=["map"])
LA_GEOJSON = Path(__file__).resolve().parents[2] / "data" / "aoi" / "la.geojson"


@router.get("/la")
def get_la_aoi():
    if not LA_GEOJSON.is_file():
        raise HTTPException(404, "Save your GeoJSON at backend/data/aoi/la.geojson")

    try:
        data = json.loads(LA_GEOJSON.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as exc:
        raise HTTPException(500, "Could not read backend/data/aoi/la.geojson as JSON") from exc

    if not isinstance(data, dict) or data.get("type") not in {
        "FeatureCollection", "Feature", "Point", "MultiPoint", "LineString",
        "MultiLineString", "Polygon", "MultiPolygon", "GeometryCollection",
    }:
        raise HTTPException(500, "backend/data/aoi/la.geojson must contain GeoJSON")

    return JSONResponse(content=data, media_type="application/geo+json")
