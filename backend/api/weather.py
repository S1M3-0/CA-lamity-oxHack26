"""Hourly weather shared by the weather API, simulations and saved runs."""

from datetime import date
from typing import Literal

from pydantic import BaseModel, Field


class WeatherHour(BaseModel):
    windSpeed: float = Field(ge=0, le=400, allow_inf_nan=False)
    windDir: float = Field(ge=0, lt=360, allow_inf_nan=False)
    humidity: float = Field(ge=0, le=100, allow_inf_nan=False)
    rainfall: float = Field(ge=0, le=500, allow_inf_nan=False)


class WeatherDay(BaseModel):
    date: date
    timezone: str = Field(min_length=1, max_length=100)
    source: Literal["Open-Meteo"] = "Open-Meteo"
    latitude: float = Field(ge=-90, le=90)
    longitude: float = Field(ge=-180, le=180)
    dayHours: int = Field(default=24, ge=23, le=25)
    hours: list[WeatherHour] = Field(min_length=24, max_length=24)


def hourly_rain_total(hour: float, rates: list[float]) -> float:
    """Integrate hourly mm/h rates, including a partial final hour."""
    h = min(max(hour, 0.0), len(rates))
    whole = int(h)
    return sum(rates[:whole]) + (rates[whole] * (h - whole) if whole < len(rates) else 0.0)
