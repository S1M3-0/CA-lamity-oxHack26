import { mulberry32 } from "./rng";
import { FRAME_COUNT, FRAMES_PER_HOUR, type Params, type SimResult, type Terrain } from "./types";

const DIRS8 = [
  [0, -1], [1, -1], [1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1],
] as const;
const DIRS4 = [
  [0, -1], [1, 0], [0, 1], [-1, 0],
] as const;

function areaKm2(frame: Uint8Array, cellM: number) {
  let n = 0;
  for (let k = 0; k < frame.length; k++) if (frame[k]) n++;
  return (n * cellM * cellM) / 1e6;
}

/** Nearest cell to `start` that satisfies `ok` (spiral search), so an origin clicked on water still works. */
function nearestCell(t: Terrain, start: number, ok: (k: number) => boolean) {
  if (ok(start)) return start;
  const ci = start % t.w;
  const cj = Math.floor(start / t.w);
  for (let r = 1; r < 30; r++) {
    for (let dj = -r; dj <= r; dj++) {
      for (let di = -r; di <= r; di++) {
        if (Math.max(Math.abs(di), Math.abs(dj)) !== r) continue;
        const i = ci + di, j = cj + dj;
        if (i < 0 || j < 0 || i >= t.w || j >= t.h) continue;
        const k = j * t.w + i;
        if (ok(k)) return k;
      }
    }
  }
  return start;
}

/**
 * Wildfire cellular automaton (after Alexandridis et al. 2008):
 * p_burn = p0 · humidity · fuel · wind · slope, evaluated per neighbour each minute.
 */
export function simulateWildfire(t: Terrain, p: Params, origin: number, seed: number): SimResult {
  const { w, h, elev, fuel, cellM } = t;
  const N = w * h;
  const rng = mulberry32(seed);
  const STEPS_PER_FRAME = 15; // 1-minute steps
  const state = new Uint8Array(N); // 0 unburnt, 1 burning, 2 burnt
  const burnLeft = new Uint16Array(N);
  const arrival = new Float32Array(N).fill(Infinity);
  const V = p.windSpeed / 3.6;
  const windTo = (((p.windDir + 180) % 360) * Math.PI) / 180;
  const hum = Math.pow(Math.max(0, 1 - p.humidity / 90), 1.3);
  const P0 = 0.035;
  const pw = DIRS8.map(([dx, dy]) => {
    const bearing = Math.atan2(dx, -dy);
    return Math.exp(0.08 * V) * Math.exp(0.131 * V * (Math.cos(bearing - windTo) - 1));
  });
  const dist = DIRS8.map(([dx, dy]) => Math.hypot(dx, dy));

  let active: number[] = [];
  const ignite = (k: number, time: number) => {
    state[k] = 1;
    burnLeft[k] = 20 + Math.floor(fuel[k] * 40);
    arrival[k] = time;
    active.push(k);
  };
  const start = nearestCell(t, origin, (k) => fuel[k] > 0.2);
  const si = start % w, sj = Math.floor(start / w);
  for (let dj = -1; dj <= 1; dj++)
    for (let di = -1; di <= 1; di++) {
      const i = si + di, j = sj + dj;
      if (i >= 0 && j >= 0 && i < w && j < h && fuel[j * w + i] > 0) ignite(j * w + i, 0);
    }

  const snapshot = () => {
    const f = new Uint8Array(N);
    for (let k = 0; k < N; k++) f[k] = state[k] === 1 ? 255 : state[k] === 2 ? 110 : 0;
    return f;
  };
  const frames = [snapshot()];
  for (let fi = 1; fi < FRAME_COUNT; fi++) {
    for (let s = 0; s < STEPS_PER_FRAME && active.length; s++) {
      const time = (fi - 1 + (s + 1) / STEPS_PER_FRAME) / FRAMES_PER_HOUR;
      const current = active;
      active = [];
      for (const c of current) {
        const ci = c % w, cj = (c - ci) / w;
        for (let d = 0; d < 8; d++) {
          const i = ci + DIRS8[d][0], j = cj + DIRS8[d][1];
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const n = j * w + i;
          if (state[n] !== 0 || fuel[n] <= 0) continue;
          const slopeDeg = (Math.atan((elev[n] - elev[c]) / (dist[d] * cellM)) * 180) / Math.PI;
          const ps = Math.min(4, Math.exp(0.078 * slopeDeg));
          const prob = (P0 * hum * fuel[n] * pw[d] * ps) / dist[d];
          if (rng() < prob) ignite(n, time);
        }
        if (--burnLeft[c] === 0) state[c] = 2;
        else active.push(c);
      }
    }
    frames.push(snapshot());
  }
  return { frames, arrival, area: frames.map((f) => areaKm2(f, cellM)) };
}

/**
 * Shallow-water style flood: rainfall minus infiltration falls on every cell, an optional
 * river breach adds inflow at the origin, and water moves toward lower water surfaces.
 */
export function simulateFlood(t: Terrain, p: Params, origin: number | null): SimResult {
  const { w, h, elev, sea, cellM } = t;
  const N = w * h;
  const STEPS_PER_FRAME = 10; // 90-second steps
  const dtH = 1 / FRAMES_PER_HOUR / STEPS_PER_FRAME;
  const dtS = dtH * 3600;
  const FLOODED = 0.15;
  const depth = new Float32Array(N);
  const delta = new Float32Array(N);
  const arrival = new Float32Array(N).fill(Infinity);
  const sat = p.saturation / 100;
  const cellArea = cellM * cellM;
  const breach =
    origin === null ? [] : (() => {
      const o = nearestCell(t, origin, (k) => !sea[k]);
      const oi = o % w, oj = Math.floor(o / w);
      const cells: number[] = [];
      for (let dj = -1; dj <= 1; dj++)
        for (let di = -1; di <= 1; di++) {
          const i = oi + di, j = oj + dj;
          if (i >= 0 && j >= 0 && i < w && j < h) cells.push(j * w + i);
        }
      return cells;
    })();
  const inflowM3s = 30 + 4 * p.rainfall;

  const snapshot = (time: number) => {
    const f = new Uint8Array(N);
    for (let k = 0; k < N; k++) {
      if (depth[k] >= FLOODED) {
        f[k] = Math.min(255, 40 + Math.round((depth[k] / 2.5) * 215));
        if (arrival[k] === Infinity) arrival[k] = time;
      }
    }
    return f;
  };
  const frames = [snapshot(0)];
  for (let fi = 1; fi < FRAME_COUNT; fi++) {
    for (let s = 0; s < STEPS_PER_FRAME; s++) {
      const tH = (fi - 1) / FRAMES_PER_HOUR + s * dtH;
      const infil = 25 * (1 - sat) * Math.exp(-tH / 4);
      const runoff = (Math.max(0, p.rainfall - infil) / 1000) * dtH;
      for (let k = 0; k < N; k++) if (!sea[k]) depth[k] += runoff;
      for (const k of breach) depth[k] += (inflowM3s * dtS) / cellArea / breach.length;

      delta.fill(0);
      for (let k = 0; k < N; k++) {
        const d = depth[k];
        if (d < 1e-4) continue;
        const ki = k % w, kj = (k - ki) / w;
        const H = elev[k] + d;
        let sum = 0, maxd = 0;
        const diffs = [0, 0, 0, 0];
        for (let q = 0; q < 4; q++) {
          const i = ki + DIRS4[q][0], j = kj + DIRS4[q][1];
          // outside the grid behaves like dry ground at the same height, so water can drain out
          const Hn = i < 0 || j < 0 || i >= w || j >= h ? elev[k] : elev[j * w + i] + depth[j * w + i];
          const diff = H - Hn;
          if (diff > 0) {
            diffs[q] = diff;
            sum += diff;
            if (diff > maxd) maxd = diff;
          }
        }
        if (sum === 0) continue;
        const move = Math.min(d, maxd / 2) * 0.5;
        delta[k] -= move;
        for (let q = 0; q < 4; q++) {
          if (!diffs[q]) continue;
          const i = ki + DIRS4[q][0], j = kj + DIRS4[q][1];
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          delta[j * w + i] += (move * diffs[q]) / sum;
        }
      }
      for (let k = 0; k < N; k++) depth[k] = sea[k] ? 0 : Math.max(0, depth[k] + delta[k]);
    }
    frames.push(snapshot(fi / FRAMES_PER_HOUR));
  }
  return { frames, arrival, area: frames.map((f) => areaKm2(f, cellM)) };
}
