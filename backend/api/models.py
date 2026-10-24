"""Data models.

`Item` is a placeholder. When the theme drops, rename it (Project, Event,
Report, ...) and add the fields you need. Pattern per model:
  XBase   -> shared fields
  X       -> the table
  XCreate -> what the client sends
  XUpdate -> partial update (all optional)
"""

from datetime import datetime, timezone

from sqlmodel import Field, SQLModel


def _now() -> datetime:
    return datetime.now(timezone.utc)


class ItemBase(SQLModel):
    title: str = Field(min_length=1, max_length=200)
    description: str | None = Field(default=None, max_length=2000)
    done: bool = False


class Item(ItemBase, table=True):
    id: int | None = Field(default=None, primary_key=True)
    created_at: datetime = Field(default_factory=_now)


class ItemCreate(ItemBase):
    pass


class ItemUpdate(SQLModel):
    title: str | None = Field(default=None, min_length=1, max_length=200)
    description: str | None = None
    done: bool | None = None
