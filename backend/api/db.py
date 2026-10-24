"""Database setup.

- No DATABASE_URL  -> local SQLite file (zero setup for dev).
- DATABASE_URL set -> Postgres (e.g. Neon via the Vercel Marketplace).
"""

import os
from pathlib import Path

from dotenv import load_dotenv
from sqlalchemy.pool import NullPool
from sqlmodel import Session, SQLModel, create_engine

ROOT = Path(__file__).resolve().parent.parent
load_dotenv(ROOT / ".env.local")
load_dotenv(ROOT / ".env")


def _database_url() -> str:
    url = os.getenv("DATABASE_URL", "").strip()
    if not url:
        # Vercel's filesystem is read-only except /tmp (and /tmp is wiped often),
        # so this fallback only keeps a DB-less deploy from crashing.
        if os.getenv("VERCEL"):
            return "sqlite:////tmp/app.db"
        return f"sqlite:///{ROOT / 'local.db'}"
    # Neon/Heroku-style URLs -> tell SQLAlchemy to use psycopg 3
    for prefix in ("postgres://", "postgresql://"):
        if url.startswith(prefix):
            return "postgresql+psycopg://" + url[len(prefix):]
    return url


DATABASE_URL = _database_url()
IS_SQLITE = DATABASE_URL.startswith("sqlite")

engine = create_engine(
    DATABASE_URL,
    # Serverless: don't hold connections between invocations; let Neon's pooler do it.
    poolclass=None if IS_SQLITE else NullPool,
    connect_args={"check_same_thread": False} if IS_SQLITE else {},
)


_tables_ready = False


def init_db() -> None:
    """Create any missing tables (never alters existing ones).

    Fine for a hackathon. If you need real migrations later, add Alembic.
    If you change a model's fields locally, just delete local.db.
    """
    global _tables_ready
    if _tables_ready:
        return
    from api import models  # noqa: F401  (registers tables)

    SQLModel.metadata.create_all(engine)
    _tables_ready = True


def get_session():
    # Called lazily too, since serverless runtimes may skip startup hooks.
    init_db()
    with Session(engine) as session:
        yield session
