"""FastAPI entry point.

Local:  npm run dev in the repo root (or, from backend/: python -m uvicorn api.index:app --reload --port 8000)
Vercel: deploy backend/ as its own project; this file becomes a Python serverless function.

Every route lives under /api so the Next.js rewrite can forward it unchanged.
Interactive docs: http://localhost:3000/api/docs
"""

import sys
from contextlib import asynccontextmanager
from pathlib import Path

# Make `import api.*` work no matter where the runtime starts us from.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import APIRouter, FastAPI  # noqa: E402
from fastapi.middleware.gzip import GZipMiddleware  # noqa: E402

from api.db import DATABASE_URL, init_db  # noqa: E402
from api.routes import aoi, fire, items  # noqa: E402


@asynccontextmanager
async def lifespan(_: FastAPI):
    init_db()
    yield


app = FastAPI(
    title="Hackathon API",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
    lifespan=lifespan,
)
# Fire frames are large but highly repetitive, so they compress very well.
app.add_middleware(GZipMiddleware, minimum_size=1000)

api = APIRouter(prefix="/api")


@api.get("/health", tags=["meta"])
def health():
    return {"status": "ok", "database": DATABASE_URL.split(":", 1)[0]}


api.include_router(items.router)
api.include_router(aoi.router)
api.include_router(fire.router)
# api.include_router(<your_new_router>.router)

app.include_router(api)
