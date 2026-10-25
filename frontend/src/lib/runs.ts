/** Turns a finished simulation into the payload Tiger Data stores (see backend/api/routes/runs.py). */

import type { RunCreate } from "@/lib/api";
import { FLOOD_MIN, FRAMES_PER_HOUR, type Hazard, type LngLat, type Params, type SimResult, type Terrain } from "@/lib/sim";

/** Frame values that count as "affected": any fire, or flood water (not water still inside a river). */
const AFFECTED_MIN: Record<Hazard, number> = { wildfire: 1, flood: FLOOD_MIN };
/** Frame values that count as "active": burning fire (255), or flood water 1 m+ deep (40 + 1/2.5 · 215). */
const ACTIVE_MIN: Record<Hazard, number> = { wildfire: 255, flood: 126 };

function toBase64(bytes: Uint8Array) {
  let bin = "";
  for (let k = 0; k < bytes.length; k += 0x8000) bin += String.fromCharCode(...bytes.subarray(k, k + 0x8000));
  return btoa(bin);
}

/** One bit per cell (most significant first), set where the frame is at least `min`. */
function packMask(frame: Uint8Array, min: number) {
  const out = new Uint8Array(Math.ceil(frame.length / 8));
  for (let k = 0; k < frame.length; k++) if (frame[k] >= min) out[k >> 3] |= 0x80 >> (k & 7);
  return toBase64(out);
}

export function buildRunCreate(
  run: { hazard: Hazard; placeName: string; center: LngLat; params: Params; origin: LngLat | null; seed: number; source: "backend" | "browser" },
  grid: Terrain,
  result: SimResult,
): RunCreate {
  const cellKm2 = (grid.cellM / 1000) ** 2;
  const activeMin = ACTIVE_MIN[run.hazard];
  return {
    hazard: run.hazard,
    place_name: run.placeName,
    center: run.center,
    params: { ...run.params },
    origin: run.origin,
    seed: run.seed,
    source: run.source,
    bounds: grid.bounds,
    w: grid.w,
    h: grid.h,
    cell_m: grid.cellM,
    frames_per_hour: FRAMES_PER_HOUR,
    area_km2: result.area,
    active_km2: result.frames.map((f) => {
      let n = 0;
      for (let k = 0; k < f.length; k++) if (f[k] >= activeMin) n++;
      return n * cellKm2;
    }),
    hourly_masks: result.frames
      .filter((_, i) => i % FRAMES_PER_HOUR === 0)
      .map((f) => packMask(f, AFFECTED_MIN[run.hazard])),
  };
}
