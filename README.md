# CA-lamity

See the [architecture diagram](docs/architecture.md).

Our OxHack 2026 project. **TerraShift** (the app) simulates wildfires, floods and hurricanes on real places using cellular automata. Pick a location and a disaster, set the conditions, and watch it unfold over 24 hours. For wildfire and flood runs, it also shows the nearest evacuation centres that stay safe as the disaster spreads.

Repo: https://github.com/S1M3-0/CA-lamity-oxHack26

## Features

- **Wildfire.** Click the map to start a fire, then set wind speed, wind direction and humidity.
  - **Inside LA County:** the fire runs on real 30 m maps, USGS 3DEP elevation and NLCD 2021 land cover. Chaparral and grass burn readily, cities and roads barely burn, and rivers stop the fire.
  - **Everywhere else:** land cover comes from OpenStreetMap tiles.
- **Flood.** Set rainfall intensity, storm duration and soil saturation.
  - **Where the water goes:** runoff drains downhill into river channels. Rivers rise (teal), then spill onto the floodplain (blue) once they're over their banks.
  - **What changes how much runs off:** paved ground sheds rain, forest soaks it up, and the soil gets wetter as the storm goes on.
- **Evacuation safe points.** For every simulated hour, the app checks 8 compass directions around the disaster. In each one it pins the nearest school, college, community centre or shelter that the disaster never comes near during the run. The centres come from OpenStreetMap.
- **Statistics.** After a run, the Statistics panel shows totals and an hourly chart:
  - **Fire:** area burned, fastest and average spread, and peak burning area.
  - **Flood:** total rainfall, peak flooded area and deep-water area.
- **Hurricane.** Set wind speed and direction, then click the map to place the storm. Browser simulations show storm bands, a calm eye and estimated residential warnings; these runs stay in the current session.
- **Saved scenarios.** Wildfire and flood runs are saved to Tiger Data (TimescaleDB + PostGIS), so your scenarios and last settings come back after a refresh. Press **Clear simulation** before starting a new one.
- **Map.** Switch between satellite and street basemaps, or turn on 3D terrain.

These are illustrations, not forecasts. The models are simplified and uncalibrated, so don't use them for real evacuation decisions.

## How it works

| Part | What it does |
|---|---|
| `backend/CA.py` | Wildfire automaton (numpy). Each burning cell can ignite its 8 neighbours. The chance depends on fuel, humidity, wind and slope (after Alexandridis et al., 2008). |
| `backend/flood.py` | Flood automaton. It carves rivers into the elevation and fills pits so water always drains, computes flow directions and upstream area, sizes each channel to its catchment, routes runoff downhill at Manning speeds, and spreads overbank water across the floodplain. |
| `backend/fire_maps.py` | Crops, downsamples and caches the LA elevation and land-cover maps. |
| `backend/api/tiger.py` | Tiger Data storage. A hypertable holds each hour's outline of the affected area, another holds per-frame statistics, and PostGIS runs the evacuation-centre queries. |
| `frontend/src/lib/sim/` | Loads terrain in the browser (elevation tiles, plus land cover from OSM tiles), draws frames, and holds fallback in-browser models. |

## Project structure

```
package.json                 runs both sides with `npm run dev` (npm workspace root)
backend/                     FastAPI
  CA.py                      wildfire cellular automaton
  flood.py                   flood cellular automaton (river routing)
  fire_maps.py               LA map loader (crop, downsample, cache)
  api/index.py               app + router registration
  api/db.py                  SQLite locally, Postgres/Tiger Data when DATABASE_URL is set
  api/tiger.py               Tiger Data schema, run storage, safe-point and stats queries
  api/routes/fire.py         POST /api/fire/la, /api/fire/simulate
  api/routes/flood.py        POST /api/flood/simulate
  api/routes/runs.py         saved runs, /safe-points, /stats
  data/maps/                 LA rasters (not in git, see below)
  requirements.txt
frontend/                    Next.js (App Router) + Tailwind CSS v4 + MapLibre
  src/components/terrashift/ Simulator, SimMap, StatsPanel, InfoTip
  src/lib/sim/               terrain loading, rendering, browser fallback models
  src/lib/api.ts             typed client for /api/*
  next.config.ts             forwards /api/* to the backend (API_URL)
```

## Run locally

Requires Node 20.9+ and Python 3.10+.

```bash
npm install                              # installs root + frontend
python -m venv backend/.venv
source backend/.venv/bin/activate        # Windows: backend\.venv\Scripts\activate
pip install -r backend/requirements.txt

npm run dev                              # Next on :3000 + FastAPI on :8000
```

Activate the venv in every new terminal before `npm run dev`, or the API won't start. Then open http://localhost:3000. API docs are at http://localhost:3000/api/docs.

### Tiger Data (saved runs, safe points, statistics)

1. Create a service on [Tiger Cloud](https://console.cloud.timescale.com).
2. Put its connection string in `backend/.env`. That file is gitignored, so never commit it.
   ```
   DATABASE_URL=postgres://tsdbadmin:<password>@<host>.tsdb.cloud.timescale.com:<port>/tsdb?sslmode=require
   ```
3. The tables, hypertables and the PostGIS extension are created automatically on the first request.

Without `DATABASE_URL`, the simulations still run, but nothing is saved and safe points and statistics are unavailable.

### LA maps (for the LA wildfire model)

The rasters are too big for git. Put them in `backend/data/maps/`:

| File | Source |
|---|---|
| `LA_DEM_3DEP_1arcsec.tif` | USGS 3DEP 1 arc-second DEM tiles `n34w119`, `n34w118`, `n35w119`, `n35w118` (from `prd-tnm.s3.amazonaws.com`), merged and cropped to 118.96°–117.63°W, 33.69°–34.84°N |
| `LA_NLCD_2021_Land_Cover.tif` | NLCD 2021 Land Cover from the MRLC WCS (`mrlc_download__NLCD_2021_Land_Cover_L48`), same area |

Without them, wildfires inside LA fall back to the in-browser model. Floods don't need them.

## Hurricane simulation

Select **Hurricane**, set the wind speed and direction, click the map to set the storm origin, then press **Generate simulation**. The browser runs a cellular automaton with Life-inspired neighbour birth and death rules: storm cells form patchy rotating bands around a calm eye, break apart, then dissipate late in the run. The storm travels downwind (following the arrow; the direction slider says where wind comes **from**) with a repeatable deviation bounded by ±15°.

Size and movement are illustrative and scaled to the 12 km map: storm travel uses 1% of the selected wind speed, and its radius grows before shrinking and fading over the 24-hour timeline. Cells also disappear as the storm leaves the simulated area. Purple shading shows relative storm intensity.

Warning signs group estimated residential cells into kilometre-sized areas wherever the simulated storm reaches them. Amber means arrival is ahead; red means the area is currently affected. Hover or focus a sign for details. Signs clear once the last forecast cells pass, and follow the timeline when rewinding. Residential estimates use the existing OSM tile colour sampling; if those tiles fail to load, warnings are hidden and the map reports that residential data is unavailable.

Run `npm run test:hurricane --workspace frontend` for the model checks.


## Deploying

- **Backend (Vultr):** run `uvicorn api.index:app` from `backend/`, without `--reload`, behind HTTPS (e.g. Caddy or nginx). Copy `data/maps/` onto the server and set `DATABASE_URL`.
- **Frontend (Vercel):** import the repo with **Root Directory** `frontend`, then set `API_URL` to the backend's URL, with no trailing slash.
- The browser only ever calls `/api/*` on the frontend's domain, so no CORS setup is needed, and the database credentials stay on the backend.

## Data and credits

- Elevation: USGS 3DEP (LA); Mapzen/AWS Terrain Tiles (in-browser)
- Land cover: NLCD 2021 (MRLC); © OpenStreetMap contributors
- Imagery: Esri World Imagery
- Evacuation centres: © OpenStreetMap contributors, via the Overpass API
- Fire spread model after Alexandridis et al. (2008), *A cellular automata model for forest fire spread prediction*

## Gotchas

- Every FastAPI route starts with `/api` (the router in `index.py` adds it). Don't put Next.js route handlers under `frontend/src/app/api`.
- On Windows, `uvicorn --reload` sometimes logs "Reloading" but keeps serving old code. Restart `npm run dev` if backend changes don't seem to apply.
- The first safe-point request for a new area fetches evacuation centres from OpenStreetMap, which can take a few seconds. After that they're cached in Tiger Data.
