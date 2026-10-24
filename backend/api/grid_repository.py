"""Read and atomically publish immutable prepared grids in PostGIS."""

from __future__ import annotations

import gzip
import hashlib
import json
import math
import struct
import uuid
from datetime import date
from typing import Any

from sqlalchemy import text
from sqlalchemy.exc import SQLAlchemyError

from api.db import DatabaseConfigurationError, DatabaseUnavailableError, get_engine


class GridUnavailableError(LookupError):
    pass


class GridIntegrityError(RuntimeError):
    pass


class GridPublishConflictError(RuntimeError):
    pass


_HAZARDS = {"wildfire", "flood"}
_NAMESPACE = uuid.UUID("5b779dba-17a5-40c7-b3c8-868b78aef415")


def _db_error(exc: SQLAlchemyError) -> DatabaseUnavailableError:
    return DatabaseUnavailableError(
        "TerraShift grid database is unavailable; check the backend DATABASE_URL and migrations"
    )


def _set_postgis_path(conn: Any) -> None:
    # Transaction-local for Supabase's transaction pooler. This also supports
    # local PostGIS images that preinstall the non-relocatable extension in public.
    conn.execute(text("SET LOCAL search_path TO public, extensions"))


def _json(value: Any) -> str:
    return json.dumps(value, sort_keys=True, separators=(",", ":"), allow_nan=False)


def _geom(value: Any) -> str:
    if not isinstance(value, dict) or value.get("type") not in ("Polygon", "MultiPolygon"):
        raise ValueError("Expected a GeoJSON Polygon or MultiPolygon geometry")
    return _json(value)


def _metadata(row: Any) -> dict[str, Any]:
    data = dict(row)
    footprint = json.loads(data["footprint_json"])
    coords = footprint["coordinates"][0]
    if len(coords) < 5:
        raise GridIntegrityError("Published footprint has fewer than four corners")
    # The prepared footprint records NW, NE, SE, SW, NW in that order.
    corners = [[float(x), float(y)] for x, y in coords[:4]]
    dates = data["source_dates"]
    if not isinstance(dates, dict):
        raise GridIntegrityError("Published source date summary is invalid")
    acquisitions = dates.get("acquisitions", dates.get("dates"))
    if not isinstance(acquisitions, list) or not all(isinstance(d, str) for d in acquisitions):
        raise GridIntegrityError("Published acquisition dates must be strings")
    return {
        "id": str(data["id"]),
        "version": data["version"],
        "place": data["place_slug"],
        "hazard": data["hazard"],
        "crs": f"EPSG:{data['metric_crs']}",
        "transform": list(data["affine"]),
        "width": data["width"],
        "height": data["height"],
        "cellSizeM": data["cell_size_m"],
        "footprint": footprint,
        "displayCorners": corners,
        "sourceDates": acquisitions,
        "processingVersion": data["processing_version"],
        "modelVersion": data["model_version"],
        "quality": data["quality"],
        "fuelLabel": "fuel proxy",
    }


_GRID_SELECT = """
SELECT g.id, g.version, g.place_slug, g.hazard, g.metric_crs, g.affine,
       g.width, g.height, g.cell_size_m, g.processing_version,
       g.model_version, g.source_dates, g.quality, g.checksum,
       ST_AsGeoJSON(g.footprint) AS footprint_json
       {arrays_column}
FROM public.places p
JOIN public.grid_versions g ON g.id = CASE
    WHEN :hazard = 'wildfire' THEN p.active_wildfire_grid_id
    ELSE p.active_flood_grid_id END
WHERE p.slug = :place AND g.hazard = :hazard
"""


def _get_grid(place: str, hazard: str, include_arrays: bool) -> dict[str, Any]:
    if hazard not in _HAZARDS:
        raise GridUnavailableError(f"Unknown hazard: {hazard}")
    query = _GRID_SELECT.format(arrays_column=", g.arrays" if include_arrays else "")
    try:
        with get_engine().connect() as conn:
            _set_postgis_path(conn)
            row = conn.execute(text(query), {"place": place, "hazard": hazard}).mappings().first()
    except SQLAlchemyError as exc:
        raise _db_error(exc) from exc
    if row is None:
        raise GridUnavailableError(f"No active {hazard} grid is published for {place}")
    result = _metadata(row)
    if include_arrays:
        arrays = bytes(row["arrays"])
        checksum = str(row["checksum"]).strip()
        if hashlib.sha256(arrays).hexdigest() != checksum:
            raise GridIntegrityError(f"Checksum mismatch for published grid {result['id']}")
        result.update({"arrays": arrays, "checksum": checksum})
    return result


def get_active_grid(place: str, hazard: str) -> dict[str, Any]:
    """Load one active prepared blob, validating its stored SHA-256."""
    return _get_grid(place, hazard, True)


def get_grid_metadata(place: str, hazard: str) -> dict[str, Any]:
    """Return display metadata without fetching analytical arrays."""
    return _get_grid(place, hazard, False)


def list_places() -> dict[str, list[dict[str, Any]]]:
    query = text("""
        SELECT p.slug, p.name, ST_X(p.centre) AS lon,
               ST_Y(p.centre) AS lat,
               ST_AsGeoJSON(p.city_aoi) AS city_aoi_json,
               p.city_aoi_source, w.id AS wildfire_id, w.version AS wildfire_version,
               f.id AS flood_id, f.version AS flood_version,
               CASE WHEN p.city_aoi IS NULL THEN NULL
                    ELSE ST_Area(p.city_aoi::geography) / 1000000 END AS city_area_km2,
               CASE WHEN p.city_aoi IS NULL OR coalesce(w.footprint, f.footprint) IS NULL THEN NULL
                    ELSE ST_Area(ST_Intersection(
                         p.city_aoi, coalesce(w.footprint, f.footprint))::geography) / 1000000
               END AS intersection_km2
        FROM public.places p
        LEFT JOIN public.grid_versions w ON w.id = p.active_wildfire_grid_id
        LEFT JOIN public.grid_versions f ON f.id = p.active_flood_grid_id
        ORDER BY CASE p.slug WHEN 'fort-mcmurray' THEN 1 WHEN 'oxford' THEN 2
                 WHEN 'brisbane' THEN 3 WHEN 'los-angeles' THEN 4 ELSE 5 END, p.name
    """)
    try:
        with get_engine().connect() as conn:
            _set_postgis_path(conn)
            rows = conn.execute(query).mappings().all()
    except SQLAlchemyError as exc:
        raise _db_error(exc) from exc
    places = []
    for row in rows:
        area = row["city_area_km2"]
        overlap = row["intersection_km2"]
        coverage = None if area is None or overlap is None or area <= 0 else {
            "cityAreaKm2": float(area),
            "intersectionKm2": float(overlap),
            "percent": float(overlap / area * 100),
        }
        places.append({
            "slug": row["slug"], "name": row["name"],
            "center": [row["lon"], row["lat"]],
            "cityAoi": json.loads(row["city_aoi_json"]) if row["city_aoi_json"] else None,
            "cityAoiSource": row["city_aoi_source"],
            "coverage": coverage,
            "grids": {
                "wildfire": {"available": True, "id": str(row["wildfire_id"]), "version": row["wildfire_version"]}
                if row["wildfire_id"] else None,
                "flood": {"available": True, "id": str(row["flood_id"]), "version": row["flood_version"]}
                if row["flood_id"] else None,
            },
        })
    return {"places": places}


def _validate_prepared_blob(blob: bytes, width: int, height: int) -> None:
    try:
        raw = gzip.decompress(blob)
    except (OSError, EOFError) as exc:
        raise GridIntegrityError("Prepared grid is not valid gzip") from exc
    n = width * height
    if len(blob) < 10 or blob[:2] != b"\x1f\x8b" or blob[4:8] != b"\x00\x00\x00\x00":
        raise GridIntegrityError("Prepared gzip must use mtime=0")
    if not raw.startswith(b"TSGRID1\n") or len(raw) != 8 + n * 12:
        raise GridIntegrityError("Prepared grid header or array length is invalid")
    elevation = struct.unpack_from(f"<{n}f", raw, 8)
    fuel = struct.unpack_from(f"<{n}f", raw, 8 + n * 4)
    if any(not math.isfinite(x) for x in elevation):
        raise GridIntegrityError("Prepared elevation contains missing or nonfinite cells")
    if any(not math.isfinite(x) or x < 0 or x > 1 for x in fuel):
        raise GridIntegrityError("Prepared fuel proxy is outside [0,1]")
    offset = 8 + n * 8
    valid, water, burnable, sink = (raw[offset + j*n:offset + (j+1)*n] for j in range(4))
    if any(v != 1 for v in valid):
        raise GridIntegrityError("Prepared grid has unresolved cells")
    if any(v not in (0, 1) for mask in (water, burnable, sink) for v in mask):
        raise GridIntegrityError("Prepared masks must be binary")
    if any(water[k] and (burnable[k] or fuel[k] != 0) for k in range(n)):
        raise GridIntegrityError("Water cells cannot have fuel or be burnable")


def publish_grid(grid: dict[str, Any], source_assets: list[dict[str, Any]]) -> dict[str, Any]:
    """Insert assets and a validated immutable grid, then activate atomically.

    Publishing the same version and checksum is idempotent. A version with a
    different checksum raises a conflict and leaves the active pointer intact.
    """
    place, hazard, version = grid["place"], grid["hazard"], grid["version"]
    if hazard not in _HAZARDS:
        raise ValueError("hazard must be wildfire or flood")
    if not source_assets:
        raise ValueError("At least one source asset is required")
    width, height = int(grid["width"]), int(grid["height"])
    if width != 200 or height != 200 or float(grid["cellSizeM"]) != 60:
        raise ValueError("v1 prototype grids must be 200 x 200 at 60 m")
    affine = list(grid["transform"])
    if len(affine) != 6 or affine[1] != 60 or affine[2] != 0 or affine[4] != 0 or affine[5] != -60:
        raise ValueError("Grid affine must be north-up with exact 60 m cells")
    arrays = bytes(grid["arrays"])
    checksum = hashlib.sha256(arrays).hexdigest()
    if checksum != grid["checksum"]:
        raise GridIntegrityError("Prepared grid checksum does not match bytes")
    _validate_prepared_blob(arrays, width, height)
    crs = grid["crs"]
    if not isinstance(crs, str) or not crs.startswith("EPSG:"):
        raise ValueError("Grid CRS must be an EPSG identifier")
    metric_crs = int(crs[5:])
    footprint = _geom(grid["footprint"])
    gid = str(grid.get("id") or uuid.uuid5(_NAMESPACE, f"grid:{place}:{hazard}:{version}:{checksum}"))
    if not isinstance(grid["quality"], dict):
        raise ValueError("Grid quality metadata must be an object")
    dates = grid["sourceDates"]
    if not isinstance(dates, dict) or not isinstance(dates.get("acquisitions"), list) or not dates["acquisitions"]:
        raise ValueError("Grid sourceDates must include a nonempty acquisitions list")
    for acquisition in dates["acquisitions"]:
        if not isinstance(acquisition, str):
            raise ValueError("Acquisition dates must be ISO date strings")
        date.fromisoformat(acquisition)
    quality = _json(grid["quality"])
    source_dates = _json(dates)
    args = {
        "id": gid, "place": place, "hazard": hazard, "version": version,
        "metric_crs": metric_crs, "affine": affine, "width": width,
        "height": height, "cell_size_m": float(grid["cellSizeM"]),
        "footprint": footprint, "processing_version": grid["processingVersion"],
        "model_version": grid["modelVersion"], "source_dates": source_dates,
        "quality": quality, "checksum": checksum, "arrays": arrays,
    }
    try:
        with get_engine().begin() as conn:
            _set_postgis_path(conn)
            if conn.execute(text("SELECT slug FROM public.places WHERE slug=:place FOR UPDATE"),
                            {"place": place}).scalar_one_or_none() is None:
                raise GridUnavailableError(f"Unknown place: {place}")
            other_hazard = "flood" if hazard == "wildfire" else "wildfire"
            other = conn.execute(text("""
                SELECT g.metric_crs, g.affine, g.width, g.height, g.cell_size_m,
                       ST_Equals(g.footprint,
                           ST_SetSRID(ST_GeomFromGeoJSON(:footprint),4326)) AS same_footprint
                FROM public.places p JOIN public.grid_versions g ON g.id = CASE
                    WHEN :other_hazard = 'wildfire' THEN p.active_wildfire_grid_id
                    ELSE p.active_flood_grid_id END
                WHERE p.slug=:place
            """), {"place": place, "other_hazard": other_hazard, "footprint": footprint}).mappings().first()
            if other and (other["metric_crs"] != metric_crs or list(other["affine"]) != affine
                          or other["width"] != width or other["height"] != height
                          or other["cell_size_m"] != float(grid["cellSizeM"])
                          or not other["same_footprint"]):
                raise GridPublishConflictError("Hazard grids for this place must align exactly")
            old = conn.execute(text("""
                SELECT id, checksum, metric_crs, affine, width, height, cell_size_m,
                       processing_version, model_version, source_dates, quality,
                       ST_Equals(footprint,
                           ST_SetSRID(ST_GeomFromGeoJSON(:footprint),4326))
                           AS same_footprint
                FROM public.grid_versions
                WHERE place_slug=:place AND hazard=:hazard AND version=:version
            """), args).mappings().first()
            if old and (str(old["id"]) != gid or str(old["checksum"]).strip() != checksum):
                raise GridPublishConflictError("Version already exists with a different grid ID or checksum")
            if old and (old["metric_crs"] != metric_crs or list(old["affine"]) != affine
                        or old["width"] != width or old["height"] != height
                        or old["cell_size_m"] != float(grid["cellSizeM"])
                        or old["processing_version"] != grid["processingVersion"]
                        or old["model_version"] != grid["modelVersion"]
                        or old["source_dates"] != grid["sourceDates"]
                        or old["quality"] != grid["quality"] or not old["same_footprint"]):
                raise GridPublishConflictError("Existing version has different metadata")
            asset_ids = []
            for asset in source_assets:
                asset_sha = asset["sha256"]
                if len(asset_sha) != 64 or any(ch not in "0123456789abcdef" for ch in asset_sha):
                    raise ValueError("Source asset SHA-256 must be lowercase hex")
                aid = str(asset.get("id") or uuid.uuid5(_NAMESPACE, f"source:{asset['provider']}:{asset['product']}:{asset['kind']}:{asset_sha}"))
                source_args = {
                    "id": aid, "provider": asset["provider"], "product": asset["product"],
                    "kind": asset["kind"], "url": asset["url"],
                    "start": asset.get("acquisition_start"), "end": asset.get("acquisition_end"),
                    "crs": asset["crs"], "resolution": asset["resolution_m"],
                    "vertical_datum": asset.get("vertical_datum"),
                    "licence": asset["licence"], "attribution": asset["attribution"],
                    "footprint": _geom(asset["footprint"]) if asset.get("footprint") else None,
                    "sha256": asset_sha,
                }
                conn.execute(text("""
                    INSERT INTO public.source_assets
                    (id, provider, product, kind, url, acquisition_start, acquisition_end,
                     source_crs, resolution_m, vertical_datum, licence, attribution, footprint, sha256)
                    VALUES (CAST(:id AS uuid), :provider, :product, :kind, :url,
                            CAST(:start AS date), CAST(:end AS date),
                            :crs, :resolution, :vertical_datum, :licence, :attribution,
                            ST_SetSRID(ST_GeomFromGeoJSON(CAST(:footprint AS text)),4326),
                            :sha256)
                    ON CONFLICT (provider, product, kind, sha256) DO NOTHING
                """), source_args)
                actual_id = conn.execute(text("""
                    SELECT id FROM public.source_assets
                    WHERE provider=:provider AND product=:product AND kind=:kind AND sha256=:sha256
                """), source_args).scalar_one()
                asset_ids.append(str(actual_id))
            if old:
                linked = {str(x) for x in conn.execute(text("""
                    SELECT source_asset_id FROM public.grid_source_assets WHERE grid_id=CAST(:id AS uuid)
                """), {"id": gid}).scalars()}
                if linked != set(asset_ids):
                    raise GridPublishConflictError("Existing version has different source assets")
            else:
                conn.execute(text("""
                    INSERT INTO public.grid_versions
                    (id, place_slug, hazard, version, metric_crs, affine, width, height,
                     cell_size_m, footprint, processing_version, model_version, source_dates,
                     quality, array_codec, checksum, arrays)
                    VALUES (CAST(:id AS uuid), :place, :hazard, :version, :metric_crs,
                            :affine, :width, :height, :cell_size_m,
                            ST_SetSRID(ST_GeomFromGeoJSON(:footprint),4326),
                            :processing_version, :model_version, CAST(:source_dates AS jsonb),
                            CAST(:quality AS jsonb), 'tsgrid1+gzip', :checksum, :arrays)
                """), args)
                for aid in set(asset_ids):
                    conn.execute(text("""
                        INSERT INTO public.grid_source_assets (grid_id, source_asset_id)
                        VALUES (CAST(:grid_id AS uuid), CAST(:asset_id AS uuid))
                    """), {"grid_id": gid, "asset_id": aid})
            pointer = "active_wildfire_grid_id" if hazard == "wildfire" else "active_flood_grid_id"
            conn.execute(text(f"UPDATE public.places SET {pointer}=CAST(:id AS uuid) WHERE slug=:place"), args)
    except SQLAlchemyError as exc:
        raise _db_error(exc) from exc
    return {"id": gid, "version": version, "checksum": checksum, "active": True}


def set_place_aoi(slug: str, geometry: dict[str, Any], source: str) -> None:
    """Store a real city boundary used only for coverage and map display."""
    if not source.strip():
        raise ValueError("City AOI source is required")
    geom = _geom(geometry)
    try:
        with get_engine().begin() as conn:
            _set_postgis_path(conn)
            updated = conn.execute(text("""
                UPDATE public.places SET city_aoi=ST_Multi(
                    ST_SetSRID(ST_GeomFromGeoJSON(:geometry),4326)),
                    city_aoi_source=:source WHERE slug=:slug
            """), {"slug": slug, "geometry": geom, "source": source})
            if updated.rowcount != 1:
                raise GridUnavailableError(f"Unknown place: {slug}")
    except SQLAlchemyError as exc:
        raise _db_error(exc) from exc
