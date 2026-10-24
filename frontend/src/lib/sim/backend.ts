import { api } from "@/lib/api";
import { lngLatToCell } from "./terrain";
import { FRAME_COUNT, FRAMES_PER_HOUR, type Bounds, type LngLat, type Params, type SimResult, type Terrain } from "./types";

/** Mainland LA County: the backend has real elevation (USGS 3DEP) and land cover (NLCD 2021) here. */
export const LA_FIRE_BOUNDS: Bounds = { west: -118.95, south: 33.7, east: -117.64, north: 34.83 };

/** Automaton steps per 15-minute frame (~5 min each), so fire can outrun one cell per frame. */
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
  });
  const frames = res.frames.map(decodeFrame);
  const arrival = new Float32Array(res.w * res.h).fill(Infinity);
  frames.forEach((f, i) => {
    for (let k = 0; k < f.length; k++) if (f[k] && arrival[k] === Infinity) arrival[k] = i / FRAMES_PER_HOUR;
  });
  return {
    result: { frames, arrival, area: res.area },
    grid: { ...t, bounds: res.bounds, w: res.w, h: res.h, cellM: res.cellM },
  };
}
