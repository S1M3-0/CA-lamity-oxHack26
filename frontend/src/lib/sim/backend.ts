import { api } from "@/lib/api";
import { lngLatToCell } from "./terrain";
import { FLOOD_MIN, FRAME_COUNT, FRAMES_PER_HOUR, type Bounds, type LngLat, type Params, type SimResult, type Terrain } from "./types";

/** Mainland LA County: the backend has real elevation (USGS 3DEP) and land cover (NLCD 2021) here. */
export const LA_FIRE_BOUNDS: Bounds = { west: -118.95, south: 33.7, east: -117.64, north: 34.83 };

/** Requested steps per 15-minute frame; CA.py runs these at half speed (~10 min per update). */
const STEPS_PER_FRAME = 3;

export function backendCoversFire(t: Terrain) {
  const b = t.bounds;
  const la = LA_FIRE_BOUNDS;
  return b.west >= la.west && b.east <= la.east && b.south >= la.south && b.north <= la.north;
}

function decodeFrame(b64: string) {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let k = 0; k < bin.length; k++) out[k] = bin.charCodeAt(k);
  return out;
}

function toBase64(bytes: Uint8Array) {
  let bin = "";
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}

/** Hours until each cell first reaches `min` (Infinity if it never does). */
function arrivalTimes(frames: Uint8Array[], min: number) {
  const arrival = new Float32Array(frames[0]?.length ?? 0).fill(Infinity);
  frames.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) if (f[k] >= min && arrival[k] === Infinity) arrival[k] = i / FRAMES_PER_HOUR;
  });
  return arrival;
}

/** How often to ask again while the backend downloads an area's roads, and for how long. */
const ROUTES_POLL_MS = 3000;
const ROUTES_GIVE_UP_MS = 4 * 60_000;

/**
 * Plans the hour-by-hour fastest safe route for responders in backend/routing.py:
 * roads close as the hazard reaches them, so the route never drives through it.
 * The first run in a new area waits while the backend downloads its roads;
 * `onPreparing` is called each time it's still busy.
 */
export async function fetchResponderRoutes(grid: Terrain, result: SimResult, onPreparing?: (detail: string) => void) {
  const arrival = new Uint8Array(result.arrival.length);
  for (let k = 0; k < arrival.length; k++) {
    const a = result.arrival[k];
    arrival[k] = Number.isFinite(a) ? Math.min(254, Math.round(a * FRAMES_PER_HOUR)) : 255;
  }
  const body = { bounds: grid.bounds, w: grid.w, h: grid.h, frames_per_hour: FRAMES_PER_HOUR, arrival: toBase64(arrival) };
  const giveUp = Date.now() + ROUTES_GIVE_UP_MS;
  for (;;) {
    const res = await api.responders.routes(body);
    if (res.status === "ready") return res.routes;
    if (Date.now() > giveUp) throw new Error("roads for this area are still downloading; try again later");
    onPreparing?.(res.detail);
    await new Promise((resolve) => setTimeout(resolve, ROUTES_POLL_MS));
  }
}

/**
 * Runs the river-routing flood model in backend/flood.py on this place's grid:
 * runoff drains into channels and spills onto the floodplain once they're over their banks.
 */
export async function runBackendFlood(t: Terrain, p: Params): Promise<{ result: SimResult; grid: Terrain }> {
  const n = t.w * t.h;
  const cover = new Uint8Array(n);
  const runoff = new Uint8Array(n);
  for (let k = 0; k < n; k++) {
    cover[k] = t.sea[k] ? 2 : t.water[k] ? 1 : 0;
    runoff[k] = Math.round(Math.min(1, Math.max(0, t.runoff[k])) * 255);
  }
  const res = await api.flood.simulate({
    w: t.w,
    h: t.h,
    cell_m: t.cellM,
    elevation: toBase64(new Uint8Array(t.elev.buffer, t.elev.byteOffset, t.elev.byteLength)),
    cover: toBase64(cover),
    runoff: toBase64(runoff),
    rainfall_mm_h: p.rainfall,
    storm_hours: p.stormHours,
    saturation: p.saturation,
    num_frames: FRAME_COUNT - 1,
    minutes_per_frame: 60 / FRAMES_PER_HOUR,
    hourly_rainfall: p.weather?.hours.map((h) => h.rainfall),
  });
  const frames = res.frames.map(decodeFrame);
  return { result: { frames, arrival: arrivalTimes(frames, FLOOD_MIN), area: res.area }, grid: t };
}

/**
 * Runs the wildfire cellular automaton in backend/CA.py on the real LA maps.
 * The backend samples its own grid over the same bounds, so it comes back as
 * `grid` (same key, so the map doesn't re-fit) for drawing the frames.
 */
export async function runBackendWildfire(
  t: Terrain,
  p: Params,
  origin: LngLat | null,
  seed: number,
): Promise<{ result: SimResult; grid: Terrain }> {
  const start = origin && lngLatToCell(t, origin) >= 0 ? origin : t.center;
  const res = await api.fire.la({
    ignition_points: [start],
    wind_direction: p.windDir,
    wind_speed_kmh: p.windSpeed,
    humidity: p.humidity,
    bounds: t.bounds,
    max_cells: t.w,
    num_frames: FRAME_COUNT - 1,
    steps_per_frame: STEPS_PER_FRAME,
    seed,
    hourly_weather: p.weather?.hours,
  });
  const frames = res.frames.map(decodeFrame);
  return {
    result: { frames, arrival: arrivalTimes(frames, 1), area: res.area },
    grid: { ...t, bounds: res.bounds, w: res.w, h: res.h, cellM: res.cellM },
  };
}
