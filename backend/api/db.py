"""Backend-only Postgres connection for published TerraShift grids.

The schema is managed by ``supabase/migrations``. The runtime never creates
tables and never substitutes SQLite when the required connection is missing.
Use a Supabase transaction pooler URL here; use a direct URL for migrations.
"""

import os
from functools import lru_cache
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy import create_engine
from sqlalchemy.engine import Engine
from sqlalchemy.pool import NullPool

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / ".env")


class DatabaseConfigurationError(RuntimeError):
    pass


class DatabaseUnavailableError(RuntimeError):
    pass


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        raise DatabaseConfigurationError(
            "DATABASE_URL is required for the TerraShift grid API; set the backend Supabase transaction pooler URL"
        )
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            url = "postgresql+psycopg://" + url[len(prefix):]
            break
    if not url.startswith("postgresql+psycopg://"):
        raise DatabaseConfigurationError("DATABASE_URL must be a PostgreSQL connection using psycopg")
    return url


@lru_cache(maxsize=2)
def _engine_for_url(url: str) -> Engine:
    # Psycopg must not create named prepared statements through PgBouncer's
    # transaction pooler. A fresh SQLAlchemy connection is used per operation.
    return create_engine(
        url,
        poolclass=NullPool,
        pool_pre_ping=True,
        connect_args={"prepare_threshold": None},
    )


def get_engine() -> Engine:
    return _engine_for_url(_database_url())
