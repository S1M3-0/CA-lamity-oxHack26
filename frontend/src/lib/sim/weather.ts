import type { Params } from "./types";

/** Hourly values apply to [hour, hour + 1); T+24 shows the final hour. */
export function conditionsAtHour(p: Params, hour: number) {
  const weather = p.weather?.hours[Math.min(23, Math.max(0, Math.floor(hour)))];
  return {
    windSpeed: weather?.windSpeed ?? p.windSpeed,
    windDir: weather?.windDir ?? p.windDir,
    humidity: weather?.humidity ?? p.humidity,
    rainfall: weather?.rainfall ?? (hour < p.stormHours ? p.rainfall : 0),
  };
}

export function weatherRainTotal(p: Params, hour: number) {
  const rates = p.weather?.hours.map((h) => h.rainfall);
  if (!rates) return Math.min(Math.max(hour, 0), p.stormHours) * p.rainfall;
  const h = Math.min(24, Math.max(0, hour));
  const whole = Math.floor(h);
  return rates.slice(0, whole).reduce((a, b) => a + b, 0) + (rates[whole] ?? 0) * (h - whole);
}
