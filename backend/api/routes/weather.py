"""Fetch yesterday's modelled weather in the selected location's timezone."""

import json
import math
from datetime import datetime, timedelta, timezone
from urllib.error import URLError
from urllib.parse import urlencode
from urllib.request import urlopen
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from fastapi import APIRouter, HTTPException, Query
from pydantic import ValidationError

from api.weather import WeatherDay, WeatherHour

router = APIRouter(prefix="/weather", tags=["weather"])


def parse_weather(body: dict, latitude: float, longitude: float, now: datetime | None = None) -> WeatherDay:
    """Reject gaps rather than silently replacing missing weather with zero."""
    hourly = body["hourly"]
    times = hourly["time"]
    tz = ZoneInfo(body["timezone"])
    local_today = (now or datetime.now(timezone.utc)).astimezone(tz).date()
    yesterday = local_today - timedelta(days=1)
    start = int(datetime.combine(yesterday, datetime.min.time(), tz).timestamp())
    end = int(datetime.combine(local_today, datetime.min.time(), tz).timestamp())
    day_hours = (end - start) // 3600
    fields = ("wind_speed_10m", "wind_direction_10m", "relative_humidity_2m", "rain", "showers")
    if any(len(hourly[k]) != len(times) for k in fields):
        raise ValueError("Incomplete hourly weather")
    # Use UTC timestamps so yesterday retains its actual timezone offset across DST.
    indices = {timestamp: i for i, timestamp in enumerate(times)}
    if len(indices) != len(times) or any(t not in indices for t in range(start, end + 1, 3600)):
        raise ValueError("Yesterday's complete hourly weather is unavailable")
    slots: list[list[WeatherHour]] = [[] for _ in range(24)]
    for timestamp in range(start, end, 3600):
        i, next_i = indices[timestamp], indices[timestamp + 3600]
        sample = WeatherHour(
            windSpeed=hourly["wind_speed_10m"][i],
            windDir=hourly["wind_direction_10m"][i] % 360,
            humidity=hourly["relative_humidity_2m"][i],
            # Rain is a preceding-hour total; include midnight for the final interval.
            rainfall=hourly["rain"][next_i] + hourly["showers"][next_i],
        )
        slots[datetime.fromtimestamp(timestamp, tz).hour].append(sample)
    hours = []
    for hour, samples in enumerate(slots):
        if not samples:
            # Spring clock jump: carry nearby wind/humidity, but invent no rain.
            nearby = next(slots[h][0] for h in sorted(range(24), key=lambda h: abs(h - hour)) if slots[h])
            hours.append(nearby.model_copy(update={"rainfall": 0.0}))
        elif len(samples) == 1:
            hours.append(samples[0])
        else:
            # Repeated autumn hour: circular mean bearing; keep both hours' rain.
            x = sum(math.sin(math.radians(s.windDir)) for s in samples)
            y = sum(math.cos(math.radians(s.windDir)) for s in samples)
            hours.append(WeatherHour(
                windSpeed=sum(s.windSpeed for s in samples) / len(samples),
                windDir=math.degrees(math.atan2(x, y)) % 360,
                humidity=sum(s.humidity for s in samples) / len(samples),
                rainfall=sum(s.rainfall for s in samples)))
    return WeatherDay(date=yesterday, timezone=body["timezone"], latitude=latitude,
                      longitude=longitude, dayHours=day_hours, hours=hours)


@router.get("/yesterday", response_model=WeatherDay)
def yesterday_weather(
    latitude: float = Query(ge=-90, le=90),
    longitude: float = Query(ge=-180, le=180),
):
    params = urlencode({
        "latitude": latitude, "longitude": longitude,
        "hourly": "wind_speed_10m,wind_direction_10m,relative_humidity_2m,rain,showers",
        "timezone": "auto", "past_days": 2, "forecast_days": 1, "timeformat": "unixtime",
        "wind_speed_unit": "kmh", "precipitation_unit": "mm",
    })
    try:
        with urlopen(f"https://api.open-meteo.com/v1/forecast?{params}", timeout=15) as response:
            body = json.load(response)
        return parse_weather(body, latitude, longitude)
    except (URLError, OSError, TimeoutError) as exc:
        raise HTTPException(502, "Weather provider unavailable. Retry or use manual conditions.") from exc
    except (ValueError, KeyError, TypeError, ValidationError, ZoneInfoNotFoundError) as exc:
        raise HTTPException(502, "Yesterday's complete weather is unavailable. Retry or use manual conditions.") from exc
