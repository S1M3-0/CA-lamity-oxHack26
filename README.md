# Hackathon App

See the [architecture diagram](docs/architecture.md) for the frontend, backend, simulation engines, map data, and database connections.

Next.js (App Router) + Tailwind CSS v4 frontend, FastAPI backend, Postgres (Neon) on Vercel — one repo, two folders, two Vercel projects.

```
package.json            runs both with `npm run dev` (npm workspace root)
backend/                FastAPI (deployed as a Vercel Python function)
  api/index.py          app + router registration
  api/db.py             SQLite locally, Postgres when DATABASE_URL is set
  api/models.py         SQLModel tables + request schemas  (placeholder: Item)
  api/routes/items.py   example CRUD router
  requirements.txt
  vercel.json           sends every path to the FastAPI app
frontend/               Next.js
  src/app/              pages (layout.tsx, page.tsx, globals.css)
  src/components/       ApiStatus, ItemsPanel (placeholder feature)
  src/lib/api.ts        typed fetch client for /api/*
  src/lib/config.ts     app name + tagline
  next.config.ts        forwards /api/* to the backend (API_URL)
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

Activate the venv in each new terminal before `npm run dev`. To run one side only: `npm run dev:web` or `npm run dev:api`.

Open http://localhost:3000. The badge in the corner should say **API ok · sqlite**. API docs: http://localhost:3000/api/docs

No database setup needed locally — it writes `backend/local.db`. Changed a model? Delete it and restart.

## MapLibre + LA GeoJSON

MapLibre is already used by `frontend/src/components/terrashift/SimMap.tsx` for the basemap and simulation overlay. To add your LA area of interest:

1. Save valid GeoJSON to `backend/data/aoi/la.geojson`. Use WGS84 coordinates in `[longitude, latitude]` order. Commit this file when deploying.
2. Run `npm run dev` and open http://localhost:3000/api/aoi/la. The endpoint should return your GeoJSON; a 404 means the file has not been saved at that path.
3. In the app, select **Los Angeles**. The client fetches `/api/aoi/la` through the existing Next.js rewrite, then adds a blue GeoJSON fill and outline to MapLibre. The map displays an API error if loading fails.

For deployment, set `API_URL` on the frontend Vercel project as described below. The browser uses the same `/api/aoi/la` path in both environments, so no browser CORS configuration or client-side backend URL is needed.

## Hurricane simulation

Select **Hurricane**, set the wind speed and direction, click the map to set the storm origin, then press **Generate simulation**. The browser runs a cellular automaton with Life-inspired neighbour birth and death rules: storm cells form patchy rotating bands around a calm eye, break apart, then dissipate late in the run. The storm travels downwind (following the arrow; the direction slider says where wind comes **from**) with a repeatable deviation bounded by ±15°.

Size and movement are illustrative and scaled to the 12 km map: storm travel uses 1% of the selected wind speed, and its radius grows before shrinking and fading over the 24-hour timeline. Cells also disappear as the storm leaves the simulated area. Purple shading shows relative storm intensity.

Warning signs group estimated residential cells into kilometre-sized areas wherever the simulated storm reaches them. Amber means arrival is ahead; red means the area is currently affected. Hover or focus a sign for details. Signs clear once the last forecast cells pass, and follow the timeline when rewinding. Residential estimates use the existing OSM tile colour sampling; if those tiles fail to load, warnings are hidden and the map reports that residential data is unavailable.

Run `npm run test:hurricane --workspace frontend` for the model checks.

## Deploy to Vercel

Import the same GitHub repo twice on vercel.com, once per folder:

1. **Backend:** Import → **Root Directory** `backend`, framework **Other**. Then **Storage → Create → Neon** (or `vercel install neon`) to set `DATABASE_URL`, and redeploy. Check `https://<backend>.vercel.app/api/health`.
2. **Frontend:** Import → **Root Directory** `frontend` (framework: Next.js). Add the env var `API_URL` = the backend's URL (no trailing slash), then deploy.
3. The badge should now say **API ok · postgresql+psycopg**.

Tables are created automatically on first request. To use Neon locally too: `cd backend && vercel env pull .env.local`.

## When the themes drop — checklist

1. **Name it:** edit `frontend/src/lib/config.ts`, swap colours in `frontend/src/app/globals.css` (`--color-brand`).
2. **Model the data:** rename `Item` in `backend/api/models.py` (keep the Base / table / Create / Update pattern) and add fields.
3. **API:** copy `backend/api/routes/items.py` for each resource, then `api.include_router(...)` in `backend/api/index.py`.
4. **Types:** mirror the model in `frontend/src/lib/api.ts` and add client methods.
5. **UI:** replace `ItemsPanel` with your feature; add pages under `frontend/src/app/<route>/page.tsx`.
6. Delete `backend/local.db` after changing models.

## Gotchas

- Every FastAPI route must start with `/api` (the router in `index.py` adds it). Don't put Next.js route handlers under `frontend/src/app/api`.
- Python functions on Vercel are serverless: no background threads, no writing to disk except `/tmp`, and keep cold-start imports light (heavy ML libraries can exceed size limits — call a hosted API instead).
- Use Neon's **pooled** connection string (the Marketplace default).
- Need secrets (e.g. an LLM API key)? Add them to the **backend** project in Vercel → Settings → Environment Variables, and to `backend/.env.local` locally; read with `os.getenv` in Python. Never expose them to the browser.
