import io
import json
import unittest
from datetime import date, datetime, timedelta, timezone
from unittest.mock import patch
from urllib.error import URLError
from zoneinfo import ZoneInfo

import numpy as np
from fastapi import HTTPException
from pydantic import ValidationError

import CA
import flood
from api.routes import weather
from api.routes.fire import Weather
from api.routes.runs import RunCreate, _rain_total
from api.weather import hourly_rain_total


def provider_body(offset=0, now=None, zone=None, target=None):
    zone = zone or ("Pacific/Auckland" if offset else "Europe/London")
    tz = ZoneInfo(zone)
    local_today = (now or datetime.now(timezone.utc)).astimezone(tz).date()
    day = target or local_today - timedelta(days=1)
    start = int(datetime.combine(day, datetime.min.time(), tz).timestamp())
    end = int(datetime.combine(day + timedelta(days=1), datetime.min.time(), tz).timestamp())
    times = list(range(start, end + 1, 3600))
    n = len(times)
    return {
        "timezone": zone,
        "utc_offset_seconds": offset,
        "hourly": {
            "time": times,
            "wind_speed_10m": [12.0] * n,
            "wind_direction_10m": [360.0] * n,
            "relative_humidity_2m": [65.0] * n,
            "rain": [0.5] * n,
            "showers": [0.25] * n,
        },
    }


class WeatherTests(unittest.TestCase):
    def test_provider_timezone_liquid_rain_and_north(self):
        body = provider_body(13 * 3600)
        day = weather.parse_weather(body, -36.8, 174.7)
        self.assertEqual(day.date, datetime.fromtimestamp(body["hourly"]["time"][0], ZoneInfo("Pacific/Auckland")).date())
        self.assertEqual(day.timezone, "Pacific/Auckland")
        self.assertEqual(day.hours[0].windDir, 0)
        self.assertEqual(day.hours[0].rainfall, 0.75)
        self.assertEqual((day.latitude, day.longitude), (-36.8, 174.7))

    def test_rain_belongs_to_preceding_hour_including_midnight(self):
        body = provider_body()
        n = len(body["hourly"]["time"])
        body["hourly"]["rain"] = [100.0] + [0.0] * (n - 2) + [5.0]
        body["hourly"]["showers"] = [0.0] * n
        day = weather.parse_weather(body, 51.7, -1.2)
        self.assertEqual(day.hours[0].rainfall, 0)
        self.assertEqual(day.hours[23].rainfall, 5)
        self.assertEqual(sum(h.rainfall for h in day.hours), 5)

    def test_missing_stale_or_nonfinite_data_is_rejected(self):
        for field, value in (("rain", None), ("wind_speed_10m", float("nan"))):
            body = provider_body()
            body["hourly"][field][3] = value
            with self.assertRaises((ValueError, TypeError)):
                weather.parse_weather(body, 51.7, -1.2)
        body = provider_body()
        body["hourly"]["time"][0] = 946684800
        with self.assertRaises(ValueError):
            weather.parse_weather(body, 51.7, -1.2)
        body = provider_body()
        body["hourly"]["rain"].pop()
        with self.assertRaises(ValueError):
            weather.parse_weather(body, 51.7, -1.2)

    def test_provider_failure_is_actionable_and_request_uses_local_yesterday(self):
        with patch.object(weather, "urlopen", side_effect=URLError("offline")):
            with self.assertRaises(HTTPException) as caught:
                weather.yesterday_weather(51.7, -1.2)
            self.assertEqual(caught.exception.status_code, 502)
        with patch.object(weather, "urlopen", return_value=io.StringIO(json.dumps(provider_body()))) as get:
            result = weather.yesterday_weather(51.7, -1.2)
            self.assertEqual(len(result.hours), 24)
            url = get.call_args.args[0]
            self.assertIn("timezone=auto", url)
            self.assertIn("past_days=2", url)
            self.assertIn("forecast_days=1", url)
            self.assertIn("timeformat=unixtime", url)

    def test_historical_date_uses_archive_rain_without_double_counting_showers(self):
        selected = date(2020, 10, 25)
        body = provider_body(target=selected)
        body["hourly"].pop("showers")
        with patch.object(weather, "urlopen", return_value=io.StringIO(json.dumps(body))) as get:
            day = weather.historical_weather(selected, 51.7, -1.2)
        self.assertEqual(day.date, selected)
        self.assertEqual(day.dayHours, 25)
        self.assertEqual(len(day.hours), 24)
        self.assertAlmostEqual(sum(h.rainfall for h in day.hours), 25 * 0.5)
        url = get.call_args.args[0]
        self.assertIn("archive-api.open-meteo.com/v1/archive", url)
        self.assertIn("start_date=2020-10-25", url)
        self.assertIn("end_date=2020-10-26", url)
        self.assertIn("timezone=auto", url)
        self.assertIn("timeformat=unixtime", url)

    def test_historical_date_rejects_future_and_missing_midnight(self):
        with self.assertRaises(HTTPException) as caught:
            weather.historical_weather(date(2100, 1, 1), 51.7, -1.2)
        self.assertEqual(caught.exception.status_code, 400)
        selected = date(2020, 6, 1)
        body = provider_body(target=selected)
        body["hourly"].pop("showers")
        for values in body["hourly"].values():
            values.pop()
        with patch.object(weather, "urlopen", return_value=io.StringIO(json.dumps(body))):
            with self.assertRaises(HTTPException) as caught:
                weather.historical_weather(selected, 51.7, -1.2)
        self.assertEqual(caught.exception.status_code, 502)

    def test_dst_days_preserve_local_date_and_rain_total(self):
        for now, elapsed in ((datetime(2026, 3, 30, 12, tzinfo=timezone.utc), 23),
                             (datetime(2026, 10, 26, 12, tzinfo=timezone.utc), 25)):
            body = provider_body(now=now)
            day = weather.parse_weather(body, 51.7, -1.2, now=now)
            self.assertEqual(day.dayHours, elapsed)
            self.assertEqual(len(day.hours), 24)
            self.assertAlmostEqual(sum(h.rainfall for h in day.hours), elapsed * 0.75)
        # On the autumn transition, yesterday still used summer time.
        now = datetime(2026, 10, 25, 12, tzinfo=timezone.utc)
        body = provider_body(now=now)
        day = weather.parse_weather(body, 51.7, -1.2, now=now)
        self.assertEqual(str(day.date), "2026-10-24")
        self.assertEqual(day.dayHours, 24)
        self.assertEqual(datetime.fromtimestamp(body["hourly"]["time"][0], timezone.utc).hour, 23)

    def test_rain_integral_partial_hours_and_end_of_day(self):
        rates = [0.0, 8.0] + [0.0] * 22
        self.assertEqual(hourly_rain_total(1, rates), 0)
        self.assertEqual(hourly_rain_total(1.25, rates), 2)
        self.assertEqual(hourly_rain_total(24, rates), 8)
        self.assertEqual(_rain_total({"weather": {"hours": [{"rainfall": r} for r in rates]}}, 1.25), 2)

    def test_saved_weather_round_trip_keeps_profile_and_accepts_legacy_params(self):
        day = weather.parse_weather(provider_body(), 51.7, -1.2)
        payload = dict(
            hazard="flood", place_name="Oxford", center=[-1.2, 51.7],
            params={"rainfall": 20, "stormHours": 6, "saturation": 40, "weather": day.model_dump(mode="json")},
            seed=42, source="browser", bounds=dict(west=-2, south=51, east=-1, north=52),
            w=2, h=2, cell_m=100, frames_per_hour=4, area_km2=[0, 1],
            active_km2=[0, 0], hourly_masks=["AA=="],
        )
        saved = RunCreate.model_validate_json(RunCreate(**payload).model_dump_json())
        self.assertEqual(saved.params["weather"], day)
        del payload["params"]["weather"]
        RunCreate(**payload)

    def test_fire_schema_rejects_incomplete_profile(self):
        hour = dict(windSpeed=10, windDir=0, humidity=50, rainfall=0)
        with self.assertRaises(ValidationError):
            Weather(wind_direction=0, wind_speed_kmh=10, humidity=50, hourly_weather=[hour])

    def test_fire_uses_each_hours_weather_without_changing_manual_results(self):
        land = np.full((15, 15), 42, dtype=np.uint8)
        args = dict(wind_direction=0, wind_speed=5, humidity=20, num_frames=8, steps_per_frame=2, seed=9)
        baseline = CA.simulate(land, [(7, 7)], **args)
        hours = [dict(windDir=0, windSpeed=18, humidity=20, rainfall=0) for _ in range(24)]
        same = CA.simulate(land, [(7, 7)], hourly_weather=hours, **args)
        np.testing.assert_array_equal(baseline, same)
        hours[1]["humidity"] = 100
        changed = CA.simulate(land, [(7, 7)], hourly_weather=hours, **args)
        np.testing.assert_array_equal(baseline[:5], changed[:5])
        self.assertFalse(np.array_equal(baseline[5:], changed[5:]))

    def test_flood_uses_hourly_rates_and_zero_rain_does_not_use_manual_storm(self):
        elevation = np.zeros((5, 5))
        cover = np.zeros((5, 5), dtype=np.uint8)
        runoff = np.ones((5, 5))
        args = dict(cell_m=100, rainfall_mm_h=100, storm_hours=24, saturation=1, num_frames=8)
        dry, _ = flood.simulate(elevation, cover, runoff, hourly_rainfall=[0] * 24, **args)
        late, _ = flood.simulate(elevation, cover, runoff, hourly_rainfall=[0, 500] + [0] * 22, **args)
        np.testing.assert_array_equal(dry[:5], late[:5])
        self.assertFalse(np.array_equal(dry[5:], late[5:]))


if __name__ == "__main__":
    unittest.main()
