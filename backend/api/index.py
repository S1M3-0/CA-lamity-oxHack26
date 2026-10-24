"""FastAPI entry point for published TerraShift scenarios.

The API schema is migration-managed; startup never creates tables. Frontend
requests arrive through the Next.js /api rewrite in both local and deployed
environments.
"""

import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from fastapi import APIRouter, FastAPI  # noqa: E402

from api.routes import places  # noqa: E402

app = FastAPI(
    title="TerraShift API",
    docs_url="/api/docs",
    openapi_url="/api/openapi.json",
)
api = APIRouter(prefix="/api")


@api.get("/health", tags=["meta"])
def health():
    return {
        "status": "ok",
        "database": "postgresql" if os.getenv("DATABASE_URL", "").strip() else "unconfigured",
    }


api.include_router(places.router)

app.include_router(api)
