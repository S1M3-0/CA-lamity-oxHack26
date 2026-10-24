# TerraShift

TerraShift is a **central-area prototype** for illustrative wildfire and flood
scenarios in Fort McMurray, Oxford, Brisbane, and Los Angeles. It is not an
operational hazard forecast. Each place has a 200 × 200 metric grid at 60 m
resolution, covering 12 × 12 km around its preset centre. The city boundary
and percentage covered are shown when a sourced city AOI is available.
The grid outline must not be interpreted as a whole-municipality simulation.

FastAPI loads immutable prepared grids from PostGIS and generates 97 frames
spanning 24 hours at 15-minute intervals. The browser only displays those
frames over MapLibre satellite or street tiles. Display tiles never supply
analytical elevation or fuel. Runs remain in browser memory (up to six); user
simulations are not stored in the database.

## Local setup

Use Node 20.9+ and Python 3.10+.

```bash
npm install
python3 -m venv backend/.venv
backend/.venv/bin/pip install -r backend/requirements.txt
cp backend/.env.example backend/.env.local
```

Configure `backend/.env.local` for one clearly identified Supabase project.
If you also keep a local PostGIS test database, put the Supabase URLs in
ignored `backend/.env.supabase.local` and source that file explicitly for
remote migrations or publication; it will override the local test URL in the
shell for that command.
From its Dashboard **Connect** menu, use the **Transaction pooler** URL as
`DATABASE_URL` for FastAPI and publishing, and the **Direct connection** URL
as `MIGRATION_DATABASE_URL` for migrations. Do not put connection strings in
frontend environment variables or commit the local file. The runtime disables
Psycopg prepared statements for transaction pooling. A missing `DATABASE_URL`
is a visible grid-API configuration failure, not a SQLite fallback.

Apply migrations in filename order against the direct connection:

```bash
cd backend
set -a; source .env.local; set +a
psql "$MIGRATION_DATABASE_URL" -v ON_ERROR_STOP=1 -f ../supabase/migrations/202610240001_terrashift.sql
```

The migration installs PostGIS in `extensions`, seeds the four place records,
and creates versioned `places`, `source_assets`, `grid_versions`, and
`grid_source_assets` tables. New application tables are migration-managed;
FastAPI does not call `create_all`. The tables are backend-only and have no
unauthenticated client read policy. When using the Supabase SQL editor rather
than `psql`, apply the exact migration file to the same selected project.

Start both processes from the repository root after activating the backend
environment:

```bash
source backend/.venv/bin/activate
npm run dev
```

The web app is at `http://localhost:3000`; FastAPI docs are at
`http://localhost:3000/api/docs`. `GET /api/places` lists publication status.
Generate remains disabled for any unpublished grid.

## Data and publishing

Ingestion is a separate dependency set so geospatial packages do not enlarge
the FastAPI function:

```bash
backend/.venv/bin/pip install -r backend/requirements-ingest.txt
cd backend
python -m api.ingest prepare --place oxford --hazard wildfire --dry-run
python -m api.ingest prepare --place oxford --hazard wildfire --publish
```

Repeat for both hazards in each place. Source manifests live in
`backend/ingest/manifests/{place}.json`. They identify Sentinel-2 L2A B04,
B08, and SCL assets, dated acquisitions, DEM tiles, licence, provenance,
CRS, no-data, and checksums. The public Earth Search STAC catalogue is an
available Sentinel-2 L2A source when Copernicus Data Space credentials are
not configured. Raw source COGs and QA output remain outside git. Dry-run
checks source metadata, alignment, required-cell coverage, masks, ranges,
and deterministic checksums, then writes a human-readable report and preview
map. Publishing revalidates the inputs and atomically switches a place's
active pointer while preserving older versions. A failed source or missing
required cell stops publication; there are no synthetic-elevation or
uniform-fuel substitutes.

The wildfire vegetation input is labelled **fuel proxy**. Its versioned rule
uses valid Sentinel-2 observations, masks cloud, shadow, cirrus, snow, and
no-data, sets water and clearly nonvegetated pixels to zero, and maps NDVI of
eligible vegetation to [0,1]. It is not a validated fuel dataset. DEM source
limits, vertical datum, DTM-versus-DSM status, water rules, and drainage-sink
rules are recorded in each source manifest and grid quality report.

See [grid and API contract](docs/grid-api-contract.md) for the byte format,
geometry, controls, frame codec, and model version. The API does not expose
analytical arrays to the browser. The flood model uses an explicit documented
sink mask; the previous browser model's `elevation <= 0.5 m` sea heuristic is
not used.

## Tests and deployment

```bash
cd backend
python -m unittest discover -s tests
cd ..
npm run typecheck
npm run build
```

The frontend production build uses Next's Webpack option. Deploy `backend/`
as the Python FastAPI project and `frontend/` as the Next.js project. Put the
Supabase **Transaction pooler** URL in the backend project's `DATABASE_URL`.
Set frontend `API_URL` to the backend deployment URL; Next rewrites `/api/*`
to FastAPI. Keep source rasters and ingestion-only geospatial dependencies out
of the backend function. The synchronous simulation response must stay under
Vercel's 4.5 MB Function body limit, and its duration must fit the configured
function limit. Measure both again after changing grid size or the model.

The present model is a deterministic illustrative cellular automaton and
shallow-water-style approximation. It does not model structures, firefighting,
weather evolution, river hydraulics, calibrated infiltration, or uncertainty.
Input acquisition dates and grid/model versions appear in the UI so a run can
be interpreted in the context of its prepared data.
