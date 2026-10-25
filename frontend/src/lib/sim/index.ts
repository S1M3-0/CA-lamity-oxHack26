import { simulateFlood, simulateWildfire } from "./models";
import { hashString } from "./rng";
import { lngLatToCell } from "./terrain";
import { FLOOD_MIN, type Hazard, type LngLat, type Params, type SimResult, type Terrain } from "./types";

export * from "./types";
export { loadTerrain, lngLatToCell, cellToLngLat, terrainKey } from "./terrain";
export { backendCoversFire, fetchResponderRoutes, runBackendFlood, runBackendWildfire } from "./backend";

export type ParamKey = Exclude<keyof Params, "weather">;

export const HAZARDS: Record<
  Hazard,
  { label: string; params: ParamKey[]; originLabel: string | null; blurb: string }
> = {
  wildfire: {
    label: "Wildfire",
    params: ["windSpeed", "windDir", "humidity"],
    originLabel: "Ignition point",
    blurb: "Spread driven by wind, humidity, slope and fuel estimated from imagery.",
  },
  flood: {
    label: "Flood",
    params: ["rainfall", "stormHours", "saturation"],
    originLabel: null,
    blurb: "Storm runoff drains into rivers over real elevation, then spills onto the floodplain.",
  },
};

export const PARAM_META: Record<
  ParamKey,
  { label: string; min: number; max: number; step: number; unit: string }
> = {
  windSpeed: { label: "Wind speed", min: 0, max: 100, step: 5, unit: "km/h" },
  windDir: { label: "Wind direction (from)", min: 0, max: 355, step: 5, unit: "°" },
  humidity: { label: "Relative humidity", min: 0, max: 100, step: 5, unit: "%" },
  rainfall: { label: "Rainfall intensity", min: 0, max: 100, step: 5, unit: "mm/h" },
  stormHours: { label: "Storm duration", min: 1, max: 24, step: 1, unit: "h" },
  saturation: { label: "Soil saturation", min: 0, max: 100, step: 5, unit: "%" },
};

export const DEFAULT_PARAMS: Params = {
  windSpeed: 35,
  windDir: 45,
  humidity: 30,
  rainfall: 25,
  stormHours: 6,
  saturation: 40,
};

export function compass(deg: number) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

export function describeParams(hazard: Hazard, p: Params) {
  if (p.weather) return `${p.weather.date} hourly weather · ${p.weather.timezone}${hazard === "flood" ? ` · ${p.saturation}% soil` : ""}`;
  if (hazard === "wildfire")
    return `${p.windSpeed} km/h ${compass(p.windDir)} wind · ${p.humidity}% RH`;
  return `${p.rainfall} mm/h for ${p.stormHours} h · ${p.saturation}% soil`;
}

export function runSeed(hazard: Hazard, t: Terrain, p: Params, origin: LngLat | null) {
  // JSONB can reorder object keys. Normalize the profile before hashing a restored run.
  const weather = p.weather;
  const seedParams = weather ? { ...p, weather: [weather.date, weather.timezone, weather.latitude, weather.longitude,
    weather.hours.map((h) => [h.windSpeed, h.windDir, h.humidity, h.rainfall])] } : p;
  return hashString(JSON.stringify([hazard, t.key, seedParams, origin]));
}

export function runSimulation(
  hazard: Hazard,
  t: Terrain,
  p: Params,
  origin: LngLat | null,
  savedSeed?: number,
): SimResult {
  const seed = savedSeed ?? runSeed(hazard, t, p, origin);
  const originCell = origin ? lngLatToCell(t, origin) : -1;
  if (hazard === "wildfire") {
    const start = originCell >= 0 ? originCell : (t.h >> 1) * t.w + (t.w >> 1);
    return simulateWildfire(t, p, start, seed);
  }
  return simulateFlood(t, p);
}

/** Paints one frame of a run into an RGBA buffer the size of the grid. */
export function renderFrame(
  canvas: HTMLCanvasElement,
  t: Terrain,
  hazard: Hazard | null,
  frame: Uint8Array | null,
) {
  canvas.width = t.w;
  canvas.height = t.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(t.w, t.h);
  const px = img.data;
  if (frame && hazard) {
    for (let k = 0; k < frame.length; k++) {
      const v = frame[k];
      if (!v) continue;
      const o = k * 4;
      if (hazard === "wildfire") {
        if (v === 255) { px[o] = 255; px[o + 1] = 120 + ((k * 7) % 60); px[o + 2] = 20; px[o + 3] = 240; }
        else { px[o] = 55; px[o + 1] = 18; px[o + 2] = 12; px[o + 3] = 175; }
      } else if (v < FLOOD_MIN) {
        // water still inside a river channel
        px[o] = 45; px[o + 1] = 212; px[o + 2] = 191; px[o + 3] = 170;
      } else {
        const a = (v - 40) / 215;
        px[o] = 90 - 80 * a; px[o + 1] = 190 - 120 * a; px[o + 2] = 255 - 40 * a; px[o + 3] = 120 + 120 * a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
