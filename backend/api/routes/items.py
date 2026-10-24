"""CRUD for the placeholder Item model. Copy this file for each new resource."""

from fastapi import APIRouter, Depends, HTTPException
from sqlmodel import Session, select

from api.db import get_session
from api.models import Item, ItemCreate, ItemUpdate

router = APIRouter(prefix="/items", tags=["items"])


@router.get("", response_model=list[Item])
def list_items(session: Session = Depends(get_session)):
    return session.exec(select(Item).order_by(Item.created_at.desc())).all()


@router.post("", response_model=Item, status_code=201)
def create_item(data: ItemCreate, session: Session = Depends(get_session)):
    item = Item.model_validate(data)
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.get("/{item_id}", response_model=Item)
def get_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    return item


@router.patch("/{item_id}", response_model=Item)
def update_item(item_id: int, data: ItemUpdate, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    item.sqlmodel_update(data.model_dump(exclude_unset=True))
    session.add(item)
    session.commit()
    session.refresh(item)
    return item


@router.delete("/{item_id}", status_code=204)
def delete_item(item_id: int, session: Session = Depends(get_session)):
    item = session.get(Item, item_id)
    if not item:
        raise HTTPException(404, "Item not found")
    session.delete(item)
    session.commit()
