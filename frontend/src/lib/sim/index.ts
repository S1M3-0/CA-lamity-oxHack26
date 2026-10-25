import { simulateFlood, simulateWildfire } from "./models";
import { hashString } from "./rng";
import { lngLatToCell } from "./terrain";
import { type Hazard, type LngLat, type Params, type SimResult, type Station, type Terrain } from "./types";

export * from "./types";
export { loadTerrain, lngLatToCell, cellToLngLat, regionBounds, terrainKey } from "./terrain";
export { loadStations } from "./stations";

export type ParamKey = keyof Params;

export const HAZARDS: Record<
  Hazard,
  { label: string; params: ParamKey[]; originLabel: string | null; blurb: string }
> = {
  wildfire: {
    label: "Wildfire",
    params: ["windSpeed", "windDir", "humidity", "crews"],
    originLabel: "Ignition point",
    blurb: "Spread driven by wind, humidity, slope and fuel estimated from imagery. Fire crews leave real fire stations to fight it.",
  },
  flood: {
    label: "Flood",
    params: ["rainfall", "saturation"],
    originLabel: "River breach",
    blurb: "Rain-on-grid runoff over real elevation, with an optional breach inflow.",
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
  saturation: { label: "Soil saturation", min: 0, max: 100, step: 5, unit: "%" },
  crews: { label: "Fire crews sent", min: 0, max: 12, step: 1, unit: "" },
};

export const DEFAULT_PARAMS: Params = {
  windSpeed: 35,
  windDir: 45,
  humidity: 30,
  rainfall: 50,
  saturation: 40,
  crews: 4,
};

export function compass(deg: number) {
  return ["N", "NE", "E", "SE", "S", "SW", "W", "NW"][Math.round(deg / 45) % 8];
}

export function describeParams(hazard: Hazard, p: Params) {
  if (hazard === "wildfire")
    return `${p.windSpeed} km/h ${compass(p.windDir)} wind · ${p.humidity}% RH · ${p.crews ? `${p.crews} crews` : "no crews"}`;
  return `${p.rainfall} mm/h rain · ${p.saturation}% soil`;
}

export function runSeed(hazard: Hazard, t: Terrain, p: Params, origin: LngLat | null, stations: Station[] = []) {
  return hashString(JSON.stringify([hazard, t.key, p, origin, stations.length]));
}

export function runSimulation(
  hazard: Hazard,
  t: Terrain,
  p: Params,
  origin: LngLat | null,
  stations: Station[] = [],
): SimResult {
  const seed = runSeed(hazard, t, p, origin, stations);
  const originCell = origin ? lngLatToCell(t, origin) : -1;
  if (hazard === "wildfire") {
    const start = originCell >= 0 ? originCell : (t.h >> 1) * t.w + (t.w >> 1);
    return simulateWildfire(t, p, start, seed, stations.map((s) => s.lngLat));
  }
  return simulateFlood(t, p, originCell >= 0 ? originCell : null);
}

/** Evacuation zones by hours until the hazard arrives: evacuate now, get ready, stay alert. */
export const ZONES = [
  { label: "Evacuate now", within: 1, rgb: [225, 29, 72] },
  // violet, not orange, so it can't be mistaken for burning cells
  { label: "Get ready", within: 3, rgb: [168, 85, 247] },
  { label: "Stay alert", within: 6, rgb: [253, 224, 71] },
] as const;

/** Cells of safety margin around the predicted path; also smooths out the fire's speckle. */
const ZONE_BUFFER = 2;
const buffered = new WeakMap<Float32Array, Float32Array>();

/** Earliest arrival within ZONE_BUFFER cells of each cell (computed once per run). */
function bufferedArrival(arrival: Float32Array, w: number): Float32Array {
  let out = buffered.get(arrival);
  if (out) return out;
  const h = arrival.length / w;
  const rows = new Float32Array(arrival.length);
  out = new Float32Array(arrival.length);
  // separable min filter: along rows, then along columns
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let d = -ZONE_BUFFER; d <= ZONE_BUFFER; d++) if (x + d >= 0 && x + d < w) m = Math.min(m, arrival[y * w + x + d]);
      rows[y * w + x] = m;
    }
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      let m = Infinity;
      for (let d = -ZONE_BUFFER; d <= ZONE_BUFFER; d++) if (y + d >= 0 && y + d < h) m = Math.min(m, rows[(y + d) * w + x]);
      out[y * w + x] = m;
    }
  buffered.set(arrival, out);
  return out;
}

/** Zone index for each cell at time `now` (hours): 0..2 = ZONES, 3 = none, -1 = already hit. */
export function zoneOf(arrival: Float32Array, frame: Uint8Array, now: number, w: number): Int8Array {
  const a = bufferedArrival(arrival, w);
  const z = new Int8Array(arrival.length);
  for (let k = 0; k < arrival.length; k++) {
    const dt = a[k] - now;
    z[k] = frame[k] || dt <= 0 ? -1 : dt <= ZONES[0].within ? 0 : dt <= ZONES[1].within ? 1 : dt <= ZONES[2].within ? 2 : 3;
  }
  return z;
}

/** Paints one frame of a run into an RGBA buffer the size of the grid. */
export function renderFrame(
  canvas: HTMLCanvasElement,
  t: Terrain,
  hazard: Hazard | null,
  frame: Uint8Array | null,
  /** with the run's arrival times and the current time, evacuation zones are drawn ahead of the hazard */
  zones: { arrival: Float32Array; now: number } | null = null,
) {
  canvas.width = t.w;
  canvas.height = t.h;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const img = ctx.createImageData(t.w, t.h);
  const px = img.data;
  if (frame && zones) {
    const z = zoneOf(zones.arrival, frame, zones.now, t.w);
    for (let k = 0; k < z.length; k++) {
      if (z[k] < 0 || z[k] > 2) continue;
      const x = k % t.w, y = (k - x) / t.w;
      // bold outer edge where the next cell out is a later zone (or none), faint fill inside
      const edge =
        (x > 0 && z[k - 1] > z[k]) || (x < t.w - 1 && z[k + 1] > z[k]) ||
        (y > 0 && z[k - t.w] > z[k]) || (y < t.h - 1 && z[k + t.w] > z[k]);
      const [r, g, b] = ZONES[z[k]].rgb;
      const o = k * 4;
      px[o] = r; px[o + 1] = g; px[o + 2] = b; px[o + 3] = edge ? 230 : 60;
    }
  }
  if (frame && hazard) {
    for (let k = 0; k < frame.length; k++) {
      const v = frame[k];
      if (!v) continue;
      const o = k * 4;
      if (hazard === "wildfire") {
        if (v === 255) { px[o] = 255; px[o + 1] = 120 + ((k * 7) % 60); px[o + 2] = 20; px[o + 3] = 240; }
        else if (v === 60) { px[o] = 34; px[o + 1] = 211; px[o + 2] = 238; px[o + 3] = 190; }
        else { px[o] = 55; px[o + 1] = 18; px[o + 2] = 12; px[o + 3] = 175; }
      } else {
        const a = (v - 40) / 215;
        px[o] = 90 - 80 * a; px[o + 1] = 190 - 120 * a; px[o + 2] = 255 - 40 * a; px[o + 3] = 120 + 120 * a;
      }
    }
  }
  ctx.putImageData(img, 0, 0);
}
