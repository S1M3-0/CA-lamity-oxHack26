import type { LngLat } from "./types";

/** Conditions right now at a place, from Open-Meteo (free, no key; only the coordinates are sent). */
export type LiveWeather = {
  /** km/h */
  windSpeed: number;
  /** degrees the wind blows from */
  windDir: number;
  /** % */
  humidity: number;
  /** mm/h */
  rainfall: number;
  /** % of the topsoil's capacity that is water */
  saturation: number;
  /** local time of the reading, e.g. "2026-10-25T04:00" */
  time: string;
};

// Typical topsoil porosity: volumetric soil moisture at this value counts as fully saturated.
const POROSITY = 0.45;

export async function fetchLiveWeather([lon, lat]: LngLat): Promise<LiveWeather> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${lat.toFixed(4)}&longitude=${lon.toFixed(4)}` +
    "&current=wind_speed_10m,wind_direction_10m,relative_humidity_2m,precipitation" +
    "&hourly=soil_moisture_0_to_1cm&forecast_hours=1&wind_speed_unit=kmh&timezone=auto";
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Weather unavailable (${res.status})`);
  const d = await res.json();
  const c = d.current;
  const moisture = d.hourly?.soil_moisture_0_to_1cm?.[0];
  return {
    windSpeed: c.wind_speed_10m,
    windDir: c.wind_direction_10m,
    humidity: c.relative_humidity_2m,
    // "current" precipitation is the total over its interval (usually 15 minutes)
    rainfall: (c.precipitation * 3600) / (c.interval || 3600),
    saturation: typeof moisture === "number" ? Math.min(100, (moisture / POROSITY) * 100) : 50,
    time: c.time,
  };
}
