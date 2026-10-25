import assert from "node:assert/strict";
import test from "node:test";
import { conditionsAtHour, weatherRainTotal } from "./weather";
import { simulateFlood, simulateWildfire } from "./models";
import type { Params, Terrain, WeatherDay } from "./types";

const manual: Params = { windSpeed: 18, windDir: 270, humidity: 20, rainfall: 100, stormHours: 6, saturation: 100 };
function profile(): WeatherDay {
  return {
    date: "2026-10-24", timezone: "Europe/London", source: "Open-Meteo", latitude: 51.7, longitude: -1.2,
    hours: Array.from({ length: 24 }, () => ({ windSpeed: 18, windDir: 270, humidity: 20, rainfall: 0 })),
  };
}
function terrain(): Terrain {
  const n = 25 * 25;
  return {
    key: "weather-test", name: "Test", center: [-1.2, 51.7], bounds: { west: -2, south: 51, east: -1, north: 52 },
    w: 25, h: 25, cellM: 120, elev: new Float32Array(n), fuel: new Float32Array(n).fill(0.8),
    sea: new Uint8Array(n), water: new Uint8Array(n), runoff: new Float32Array(n).fill(1),
    demSource: "synthetic", fuelSource: "uniform", minElev: 0, maxElev: 0,
  };
}

test("hour boundaries, final frame and zero rainfall use the hourly profile", () => {
  const weather = profile();
  weather.hours[1] = { windSpeed: 2, windDir: 1, humidity: 100, rainfall: 8 };
  weather.hours[23].windDir = 359;
  const p = { ...manual, weather };
  assert.equal(conditionsAtHour(p, 0.999).windDir, 270);
  assert.equal(conditionsAtHour(p, 1).windDir, 1);
  assert.equal(conditionsAtHour(p, 24).windDir, 359);
  assert.equal(conditionsAtHour(p, 0).rainfall, 0);
  assert.equal(weatherRainTotal(p, 1), 0);
  assert.equal(weatherRainTotal(p, 1.25), 2);
  assert.equal(weatherRainTotal(p, 24), 8);
  assert.equal(conditionsAtHour(manual, 5.99).rainfall, 100);
  assert.equal(conditionsAtHour(manual, 6).rainfall, 0);
});

test("wildfire follows changing humidity; a constant profile preserves manual behaviour", () => {
  const t = terrain();
  const weather = profile();
  const baseline = simulateWildfire(t, manual, 12 * t.w + 12, 42);
  assert.deepEqual(simulateWildfire(t, { ...manual, weather }, 12 * t.w + 12, 42), baseline);
  weather.hours.forEach((h, i) => { if (i >= 1) h.humidity = 100; });
  const changed = simulateWildfire(t, { ...manual, weather }, 12 * t.w + 12, 42);
  assert.deepEqual(changed.frames.slice(0, 5), baseline.frames.slice(0, 5));
  assert.notDeepEqual(changed.frames.slice(5), baseline.frames.slice(5));
});

test("flood fallback respects a late rain pulse instead of the manual storm", () => {
  const t = terrain();
  // A bowl keeps the pulse in the test area rather than immediately draining it.
  for (let y = 0; y < t.h; y++) for (let x = 0; x < t.w; x++) {
    if (x === 0 || y === 0 || x === t.w - 1 || y === t.h - 1) t.elev[y * t.w + x] = 1000;
  }
  const weather = profile();
  weather.hours[1].rainfall = 300;
  const result = simulateFlood(t, { ...manual, weather });
  assert.equal(result.area[4], 0);
  assert.ok(result.area[8] > 0);
  assert.equal(simulateFlood(t, { ...manual, weather: profile() }).area.at(-1), 0);
});
