"""Published place and grid metadata for the map."""

from fastapi import APIRouter, HTTPException

from api.db import DatabaseConfigurationError, DatabaseUnavailableError
from api.grid_repository import GridIntegrityError, GridUnavailableError, get_grid_metadata, list_places

router = APIRouter(tags=["grids"])


def _error(exc: Exception) -> HTTPException:
    if isinstance(exc, GridUnavailableError):
        return HTTPException(status_code=404, detail=str(exc))
    if isinstance(exc, GridIntegrityError):
        return HTTPException(status_code=500, detail=str(exc))
    if isinstance(exc, (DatabaseConfigurationError, DatabaseUnavailableError)):
        return HTTPException(status_code=503, detail=str(exc))
    return HTTPException(status_code=500, detail="Grid metadata failed")


@router.get("/places")
def places():
    try:
        return list_places()
    except (GridUnavailableError, GridIntegrityError, DatabaseConfigurationError, DatabaseUnavailableError) as exc:
        raise _error(exc) from exc


@router.get("/grids/{place}/{hazard}")
def grid(place: str, hazard: str):
    try:
        return get_grid_metadata(place, hazard)
    except (GridUnavailableError, GridIntegrityError, DatabaseConfigurationError, DatabaseUnavailableError) as exc:
        raise _error(exc) from exc
