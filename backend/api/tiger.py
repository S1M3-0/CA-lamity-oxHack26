"""Tiger Data (TimescaleDB + PostGIS) storage for simulation runs.

  sim_run        one row per generated simulation: the place, hazard and the
                 conditions the user picked, so scenarios survive a refresh
  sim_perimeter  hypertable: outline of the affected area at every simulated hour
  sim_stat       hypertable: affected area, active area and rainfall per frame
  facility       evacuation centres (schools, community centres, shelters) from
                 OpenStreetMap, fetched the first time an area is simulated

Timestamps are simulated time: the run's created_at plus the hours simulated.
Needs DATABASE_URL to point at a Tiger Cloud service (see backend/.env.example).
"""

import json
import urllib.parse
import urllib.request

from sqlalchemy import text

from api.db import IS_SQLITE, engine


class TigerUnavailable(RuntimeError):
    """Tiger Data isn't configured or can't be reached."""


SCHEMA = [
    "CREATE EXTENSION IF NOT EXISTS timescaledb",
    "CREATE EXTENSION IF NOT EXISTS postgis",
    """CREATE TABLE IF NOT EXISTS sim_run (
        id BIGSERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
        hazard TEXT NOT NULL,
        place_name TEXT NOT NULL,
        center_lon DOUBLE PRECISION NOT NULL,
        center_lat DOUBLE PRECISION NOT NULL,
        params JSONB NOT NULL,
        origin_lon DOUBLE PRECISION,
        origin_lat DOUBLE PRECISION,
        seed BIGINT NOT NULL,
        source TEXT NOT NULL,
        bounds geometry(Polygon, 4326) NOT NULL,
        w INT NOT NULL,
        h INT NOT NULL,
        cell_m DOUBLE PRECISION NOT NULL
    )""",
    """CREATE TABLE IF NOT EXISTS sim_perimeter (
        run_id BIGINT NOT NULL REFERENCES sim_run (id) ON DELETE CASCADE,
        t TIMESTAMPTZ NOT NULL,
        hour REAL NOT NULL,
        area_km2 DOUBLE PRECISION NOT NULL,
        geom geometry(MultiPolygon, 4326),
        PRIMARY KEY (run_id, t)
    )""",
    "SELECT create_hypertable('sim_perimeter', 't', if_not_exists => TRUE)",
    "CREATE INDEX IF NOT EXISTS sim_perimeter_geom_idx ON sim_perimeter USING GIST (geom)",
    """CREATE TABLE IF NOT EXISTS sim_stat (
        run_id BIGINT NOT NULL REFERENCES sim_run (id) ON DELETE CASCADE,
        t TIMESTAMPTZ NOT NULL,
        hour REAL NOT NULL,
        area_km2 DOUBLE PRECISION NOT NULL,
        active_km2 DOUBLE PRECISION NOT NULL,
        rain_mm DOUBLE PRECISION NOT NULL,
        PRIMARY KEY (run_id, t)
    )""",
    "SELECT create_hypertable('sim_stat', 't', if_not_exists => TRUE)",
    """CREATE TABLE IF NOT EXISTS facility (
        id BIGSERIAL PRIMARY KEY,
        osm_id TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        geom geometry(Point, 4326) NOT NULL
    )""",
    "CREATE INDEX IF NOT EXISTS facility_geom_idx ON facility USING GIST (geom)",
    """CREATE TABLE IF NOT EXISTS facility_fetch (
        area_key TEXT PRIMARY KEY,
        fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )""",
]

_schema_ready = False


def ensure_schema() -> None:
    global _schema_ready
    if _schema_ready:
        return
    if IS_SQLITE:
        raise TigerUnavailable(
            "Tiger Data isn't configured. Set DATABASE_URL in backend/.env to your Tiger Cloud service."
        )
    try:
        with engine.begin() as conn:
            for stmt in SCHEMA:
                conn.execute(text(stmt))
    except Exception as exc:
        raise TigerUnavailable(f"Couldn't set up Tiger Data: {exc.__class__.__name__}: {exc}") from exc
    _schema_ready = True


# ---- runs -------------------------------------------------------------------

_RUN_COLUMNS = """id, created_at, hazard, place_name, center_lon, center_lat, params,
    origin_lon, origin_lat, seed, source, w, h, cell_m,
    ST_XMin(bounds) AS west, ST_YMin(bounds) AS south, ST_XMax(bounds) AS east, ST_YMax(bounds) AS north"""


def create_run(run: dict, perimeters: list[dict], stats: list[dict]) -> int:
    """Store a run with its hourly perimeters and per-frame stats; returns its id."""
    ensure_schema()
    with engine.begin() as conn:
        run_id = conn.execute(text("""
            INSERT INTO sim_run (hazard, place_name, center_lon, center_lat, params, origin_lon, origin_lat,
                                 seed, source, bounds, w, h, cell_m)
            VALUES (:hazard, :place_name, :center_lon, :center_lat, CAST(:params AS jsonb), :origin_lon, :origin_lat,
                    :seed, :source, ST_MakeEnvelope(:west, :south, :east, :north, 4326), :w, :h, :cell_m)
            RETURNING id
        """), {**run, "params": json.dumps(run["params"])}).scalar_one()

        # Outlines come from raster cells, so smooth the stair-steps to about half a cell.
        conn.execute(text("""
            INSERT INTO sim_perimeter (run_id, t, hour, area_km2, geom)
            SELECT r.id, r.created_at + make_interval(secs => :hour * 3600), :hour, :area_km2,
                   CASE WHEN CAST(:geom AS text) IS NULL THEN NULL ELSE ST_Multi(ST_CollectionExtract(ST_MakeValid(
                       ST_SimplifyPreserveTopology(ST_SetSRID(ST_GeomFromGeoJSON(CAST(:geom AS text)), 4326), :tol)
                   ), 3)) END
            FROM sim_run r WHERE r.id = :run_id
        """), [{**p, "run_id": run_id} for p in perimeters])

        conn.execute(text("""
            INSERT INTO sim_stat (run_id, t, hour, area_km2, active_km2, rain_mm)
            SELECT r.id, r.created_at + make_interval(secs => :hour * 3600), :hour, :area_km2, :active_km2, :rain_mm
            FROM sim_run r WHERE r.id = :run_id
        """), [{**s, "run_id": run_id} for s in stats])
    return run_id


def list_runs(limit: int) -> list[dict]:
    ensure_schema()
    with engine.connect() as conn:
        rows = conn.execute(
            text(f"SELECT {_RUN_COLUMNS} FROM sim_run ORDER BY created_at DESC LIMIT :limit"), {"limit": limit}
        )
        return [dict(r._mapping) for r in rows]


def get_run(run_id: int) -> dict | None:
    ensure_schema()
    with engine.connect() as conn:
        row = conn.execute(text(f"SELECT {_RUN_COLUMNS} FROM sim_run WHERE id = :id"), {"id": run_id}).first()
        return dict(row._mapping) if row else None


def delete_run(run_id: int) -> bool:
    ensure_schema()
    with engine.begin() as conn:
        return conn.execute(text("DELETE FROM sim_run WHERE id = :id"), {"id": run_id}).rowcount > 0


# ---- evacuation centres -------------------------------------------------------

OVERPASS_URL = "https://overpass-api.de/api/interpreter"
FACILITY_MARGIN_DEG = 0.05  # also look ~5 km past the simulated area, where people can still go
FACILITY_QUERY = """[out:json][timeout:60];
(
  nwr["amenity"~"^(school|college|university|community_centre)$"]({s},{w},{n},{e});
  nwr["social_facility"="shelter"]({s},{w},{n},{e});
);
out center tags;"""


def ensure_facilities(run: dict) -> None:
    """Fetch evacuation centres around a run's area from OpenStreetMap, once per area."""
    s, w = run["south"] - FACILITY_MARGIN_DEG, run["west"] - FACILITY_MARGIN_DEG
    n, e = run["north"] + FACILITY_MARGIN_DEG, run["east"] + FACILITY_MARGIN_DEG
    area_key = f"{s:.3f},{w:.3f},{n:.3f},{e:.3f}"
    with engine.connect() as conn:
        if conn.execute(text("SELECT 1 FROM facility_fetch WHERE area_key = :k"), {"k": area_key}).first():
            return

    body = urllib.parse.urlencode({"data": FACILITY_QUERY.format(s=s, w=w, n=n, e=e)}).encode()
    request = urllib.request.Request(OVERPASS_URL, data=body, headers={"User-Agent": "TerraShift/0.1 (hackathon)"})
    with urllib.request.urlopen(request, timeout=90) as response:
        elements = json.load(response)["elements"]

    rows = []
    for el in elements:
        tags = el.get("tags", {})
        lat, lon = el.get("lat") or el.get("center", {}).get("lat"), el.get("lon") or el.get("center", {}).get("lon")
        if lat is None or lon is None:
            continue
        kind = "shelter" if tags.get("social_facility") == "shelter" else tags.get("amenity", "facility")
        name = tags.get("name") or kind.replace("_", " ").title()
        rows.append({"osm_id": f"{el['type']}/{el['id']}", "name": name, "kind": kind, "lon": lon, "lat": lat})

    with engine.begin() as conn:
        if rows:
            conn.execute(text("""
                INSERT INTO facility (osm_id, name, kind, geom)
                VALUES (:osm_id, :name, :kind, ST_SetSRID(ST_MakePoint(:lon, :lat), 4326))
                ON CONFLICT (osm_id) DO NOTHING
            """), rows)
        conn.execute(text("INSERT INTO facility_fetch (area_key) VALUES (:k) ON CONFLICT DO NOTHING"), {"k": area_key})


def safe_points(run_id: int, buffer_m: float, max_distance_m: float) -> list[dict]:
    """For each simulated hour and each of 8 compass sectors around the affected area,
    the nearest evacuation centre the hazard never comes within `buffer_m` of.

    "Never" covers the whole run, not just that hour, so a centre isn't recommended
    shortly before the fire or flood reaches it.
    """
    # Geometry is moved once into the run's UTM zone (metres) so distances and buffers are
    # cheap planar maths; flood outlines can hold thousands of patches. MATERIALIZED makes
    # Postgres build the danger zone and the safe-centre list once, not per hour x centre.
    with engine.connect() as conn:
        rows = conn.execute(text("""
            WITH run AS MATERIALIZED (
                SELECT bounds,
                       (CASE WHEN center_lat < 0 THEN 32700 ELSE 32600 END
                        + floor((center_lon + 180) / 6)::int + 1) AS utm
                FROM sim_run WHERE id = :run_id
            ), hours AS MATERIALIZED (
                SELECT p.hour, ST_Transform(p.geom, run.utm) AS geom, ST_Centroid(ST_Transform(p.geom, run.utm)) AS centre
                FROM sim_perimeter p, run WHERE p.run_id = :run_id AND NOT ST_IsEmpty(p.geom)
            ), danger AS MATERIALIZED (
                SELECT ST_Buffer(ST_Union(geom), :buffer_m) AS geom FROM hours
            ), safe AS MATERIALIZED (
                SELECT f.id, f.name, f.kind, f.geom AS lonlat, ST_Transform(f.geom, run.utm) AS geom
                FROM facility f, run, danger d
                WHERE f.geom && ST_Expand(run.bounds, :margin)
                  AND NOT ST_Intersects(ST_Transform(f.geom, run.utm), d.geom)
            ), candidates AS (
                SELECT h.hour, s.id, s.name, s.kind, s.lonlat AS geom,
                       floor(mod(degrees(ST_Azimuth(h.centre, s.geom))::numeric + 22.5, 360) / 45)::int AS sector,
                       ST_Distance(h.geom, s.geom) AS distance_m
                FROM hours h
                JOIN safe s ON ST_DWithin(h.geom, s.geom, :max_distance_m)
                WHERE NOT ST_Equals(s.geom, h.centre)
            )
            SELECT DISTINCT ON (hour, sector)
                   hour, sector, id, name, kind, ST_X(geom) AS lon, ST_Y(geom) AS lat, distance_m
            FROM candidates
            ORDER BY hour, sector, distance_m
        """), {"run_id": run_id, "buffer_m": buffer_m, "max_distance_m": max_distance_m,
               "margin": FACILITY_MARGIN_DEG})
        return [dict(r._mapping) for r in rows]


# ---- statistics ---------------------------------------------------------------

def hourly_stats(run_id: int) -> list[dict]:
    """One row per simulated hour h (h = 0 is the start): affected area at the end of
    the hour, peak active area during it, and rainfall so far.

    Buckets are aligned to the run's start and shifted by a second so each one runs
    (h-1, h], ending on the frame at exactly h hours.
    """
    with engine.connect() as conn:
        rows = conn.execute(text("""
            SELECT (extract(epoch FROM time_bucket(INTERVAL '1 hour', s.t - INTERVAL '1 second', r.created_at)
                    - r.created_at) / 3600)::int + 1 AS hour,
                   last(s.area_km2, s.t) AS area_km2,
                   max(s.active_km2) AS peak_active_km2,
                   last(s.rain_mm, s.t) AS rain_mm
            FROM sim_stat s JOIN sim_run r ON r.id = s.run_id
            WHERE s.run_id = :run_id
            GROUP BY 1
            ORDER BY 1
        """), {"run_id": run_id})
        return [dict(r._mapping) for r in rows]
