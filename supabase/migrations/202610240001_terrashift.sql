-- TerraShift v1 schema. Run with a direct Postgres connection, not the pooler.
BEGIN;
CREATE SCHEMA IF NOT EXISTS extensions;
CREATE EXTENSION IF NOT EXISTS postgis WITH SCHEMA extensions;
SET LOCAL search_path = public, extensions;

CREATE TABLE public.places (
    slug text PRIMARY KEY CHECK (slug ~ '^[a-z][a-z0-9-]*$'),
    name text NOT NULL UNIQUE,
    centre geometry(Point, 4326) NOT NULL,
    city_aoi geometry(MultiPolygon, 4326),
    city_aoi_source text,
    active_wildfire_grid_id uuid,
    active_flood_grid_id uuid,
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK ((city_aoi IS NULL) = (city_aoi_source IS NULL))
);

CREATE TABLE public.source_assets (
    id uuid PRIMARY KEY,
    provider text NOT NULL CHECK (length(provider) > 0),
    product text NOT NULL CHECK (length(product) > 0),
    kind text NOT NULL CHECK (length(kind) > 0),
    url text NOT NULL CHECK (length(url) > 0),
    acquisition_start date,
    acquisition_end date,
    source_crs text NOT NULL,
    resolution_m double precision NOT NULL CHECK (resolution_m > 0),
    vertical_datum text,
    licence text NOT NULL CHECK (length(licence) > 0),
    attribution text NOT NULL CHECK (length(attribution) > 0),
    footprint geometry(Geometry, 4326),
    sha256 char(64) NOT NULL CHECK (sha256 ~ '^[0-9a-f]{64}$'),
    created_at timestamptz NOT NULL DEFAULT now(),
    CHECK (acquisition_end IS NULL OR acquisition_start IS NOT NULL),
    CHECK (acquisition_end IS NULL OR acquisition_end >= acquisition_start),
    UNIQUE (provider, product, kind, sha256)
);

CREATE TABLE public.grid_versions (
    id uuid PRIMARY KEY,
    place_slug text NOT NULL REFERENCES public.places(slug),
    hazard text NOT NULL CHECK (hazard IN ('wildfire', 'flood')),
    version text NOT NULL CHECK (version ~ '^[a-zA-Z0-9._-]+$'),
    metric_crs integer NOT NULL CHECK (metric_crs BETWEEN 1000 AND 999999),
    affine double precision[] NOT NULL CHECK (array_length(affine, 1) = 6),
    width integer NOT NULL CHECK (width > 0),
    height integer NOT NULL CHECK (height > 0),
    cell_size_m double precision NOT NULL CHECK (cell_size_m > 0),
    footprint geometry(Polygon, 4326) NOT NULL,
    processing_version text NOT NULL,
    model_version text NOT NULL,
    source_dates jsonb NOT NULL CHECK (jsonb_typeof(source_dates) = 'object'),
    quality jsonb NOT NULL CHECK (jsonb_typeof(quality) = 'object'),
    array_codec text NOT NULL CHECK (array_codec = 'tsgrid1+gzip'),
    checksum char(64) NOT NULL CHECK (checksum ~ '^[0-9a-f]{64}$'),
    arrays bytea NOT NULL CHECK (octet_length(arrays) > 0),
    created_at timestamptz NOT NULL DEFAULT now(),
    UNIQUE (place_slug, hazard, version),
    CHECK (ST_IsValid(footprint)),
    CHECK (ST_Area(footprint::geography) > 0),
    CHECK (affine[2] > 0 AND affine[6] < 0 AND affine[3] = 0 AND affine[5] = 0),
    CHECK (abs(affine[2] - cell_size_m) < 1e-8 AND abs(affine[6] + cell_size_m) < 1e-8)
);

ALTER TABLE public.places
    ADD CONSTRAINT places_active_wildfire_fk FOREIGN KEY (active_wildfire_grid_id)
        REFERENCES public.grid_versions(id) DEFERRABLE INITIALLY DEFERRED,
    ADD CONSTRAINT places_active_flood_fk FOREIGN KEY (active_flood_grid_id)
        REFERENCES public.grid_versions(id) DEFERRABLE INITIALLY DEFERRED;

CREATE TABLE public.grid_source_assets (
    grid_id uuid NOT NULL REFERENCES public.grid_versions(id) ON DELETE RESTRICT,
    source_asset_id uuid NOT NULL REFERENCES public.source_assets(id) ON DELETE RESTRICT,
    PRIMARY KEY (grid_id, source_asset_id)
);

CREATE INDEX places_city_aoi_gix ON public.places USING gist (city_aoi);
CREATE INDEX places_centre_gix ON public.places USING gist (centre);
CREATE INDEX source_assets_footprint_gix ON public.source_assets USING gist (footprint);
CREATE INDEX grid_versions_footprint_gix ON public.grid_versions USING gist (footprint);
CREATE INDEX grid_versions_place_hazard_idx ON public.grid_versions (place_slug, hazard, created_at DESC);
CREATE INDEX grid_source_assets_asset_idx ON public.grid_source_assets (source_asset_id);

CREATE FUNCTION public.terrashift_validate_active_grid() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE actual_place text; actual_hazard text;
BEGIN
    IF NEW.active_wildfire_grid_id IS NOT NULL THEN
        SELECT place_slug, hazard INTO actual_place, actual_hazard
        FROM public.grid_versions WHERE id = NEW.active_wildfire_grid_id;
        IF actual_place IS DISTINCT FROM NEW.slug OR actual_hazard IS DISTINCT FROM 'wildfire' THEN
            RAISE EXCEPTION 'active wildfire grid must belong to this place and hazard';
        END IF;
    END IF;
    IF NEW.active_flood_grid_id IS NOT NULL THEN
        SELECT place_slug, hazard INTO actual_place, actual_hazard
        FROM public.grid_versions WHERE id = NEW.active_flood_grid_id;
        IF actual_place IS DISTINCT FROM NEW.slug OR actual_hazard IS DISTINCT FROM 'flood' THEN
            RAISE EXCEPTION 'active flood grid must belong to this place and hazard';
        END IF;
    END IF;
    RETURN NEW;
END $$;
CREATE TRIGGER places_active_grid_guard BEFORE INSERT OR UPDATE OF active_wildfire_grid_id, active_flood_grid_id
ON public.places FOR EACH ROW EXECUTE FUNCTION public.terrashift_validate_active_grid();

CREATE FUNCTION public.terrashift_immutable_grid() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
    RAISE EXCEPTION 'published grid versions are immutable';
END $$;
CREATE TRIGGER grid_versions_immutable BEFORE UPDATE OR DELETE ON public.grid_versions
FOR EACH ROW EXECUTE FUNCTION public.terrashift_immutable_grid();

-- API access uses a backend-only Postgres credential. No public client policies.
ALTER TABLE public.places ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.source_assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grid_versions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.grid_source_assets ENABLE ROW LEVEL SECURITY;
DO $$
BEGIN
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN
        REVOKE ALL ON public.places, public.source_assets, public.grid_versions,
            public.grid_source_assets FROM anon;
    END IF;
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
        REVOKE ALL ON public.places, public.source_assets, public.grid_versions,
            public.grid_source_assets FROM authenticated;
    END IF;
END $$;

INSERT INTO public.places (slug, name, centre) VALUES
    ('fort-mcmurray', 'Fort McMurray', ST_SetSRID(ST_MakePoint(-111.38, 56.726), 4326)),
    ('oxford', 'Oxford', ST_SetSRID(ST_MakePoint(-1.255, 51.745), 4326)),
    ('brisbane', 'Brisbane', ST_SetSRID(ST_MakePoint(153.025, -27.47), 4326)),
    ('los-angeles', 'Los Angeles', ST_SetSRID(ST_MakePoint(-118.2437, 34.0522), 4326))
ON CONFLICT (slug) DO NOTHING;
COMMIT;
