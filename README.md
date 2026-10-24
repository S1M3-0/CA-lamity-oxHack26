# Hackathon App

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
