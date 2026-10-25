import { mulberry32 } from "./rng";
import { FRAME_COUNT, FRAMES_PER_HOUR, type LngLat, type Params, type SimResult, type Terrain } from "./types";

// Fire crews. Times are minutes since ignition, distances are grid cells (60 m).
const REPORT_MIN = 60; // fire spotted, reported and engines rolling
const NEXT_ENGINE_MIN = 5; // a station's next engine leaves this much later
const DRIVE_SPEED = 11; // cells/min, ~40 km/h
const WORK_SPEED = 1; // cells/min along the fire line
const REACH = 1; // hoses reach this far
const KNOCKDOWN = 0.03; // chance per minute to put out each burning cell in reach
const SOAK_REACH = 1; // ground this close gets soaked
const SOAKED = 0.8; // soaked ground keeps this share of its chance to ignite
const SPREAD_OUT = 2; // crews pick fire at least this far from another crew's target
const TANK = 10; // burning cells an engine can put out before it must refill
const REFILL_MIN = 15; // time spent refilling back at the station

type Crew = {
  x: number;
  y: number;
  homeX: number;
  homeY: number;
  leave: number;
  target: number;
  water: number;
  busyUntil: number;
};

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
 * Crews leave the stations nearest the fire (one engine per station, then a second wave),
 * or drive in from the nearest edge of the map when no stations are known.
 */
function dispatchCrews(t: Terrain, count: number, start: number, stations: LngLat[]): Crew[] {
  const { west, east, south, north } = t.bounds;
  const sx = (start % t.w) + 0.5, sy = Math.floor(start / t.w) + 0.5;
  const bases = stations
    .map(([lon, lat]) => ({ x: ((lon - west) / (east - west)) * t.w, y: ((north - lat) / (north - south)) * t.h }))
    .sort((a, b) => Math.hypot(a.x - sx, a.y - sy) - Math.hypot(b.x - sx, b.y - sy));
  if (!bases.length) {
    const edges = [{ x: -1, y: sy }, { x: t.w, y: sy }, { x: sx, y: -1 }, { x: sx, y: t.h }];
    bases.push(edges.sort((a, b) => Math.hypot(a.x - sx, a.y - sy) - Math.hypot(b.x - sx, b.y - sy))[0]);
  }
  return Array.from({ length: count }, (_, c) => {
    const { x, y } = bases[c % bases.length];
    return {
      x, y, homeX: x, homeY: y,
      leave: REPORT_MIN + NEXT_ENGINE_MIN * Math.floor(c / bases.length),
      target: -1,
      water: TANK,
      busyUntil: 0,
    };
  });
}

/**
 * Wildfire cellular automaton (after Alexandridis et al. 2008):
 * p_burn = p0 · humidity · fuel · wind · slope, evaluated per neighbour each minute.
 * Fire crews (p.crews) put out burning cells within reach and soak the ground around them.
 */
export function simulateWildfire(t: Terrain, p: Params, origin: number, seed: number, stations: LngLat[] = []): SimResult {
  const { w, h, elev, fuel, cellM } = t;
  const N = w * h;
  const rng = mulberry32(seed);
  const STEPS_PER_FRAME = 15; // 1-minute steps
  const state = new Uint8Array(N); // 0 unburnt, 1 burning, 2 burnt
  const putOut = new Uint8Array(N); // 1 = extinguished by a crew
  const soaked = new Uint8Array(N);
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

  const crews = dispatchCrews(t, p.crews, start, stations);
  const { west, east, south, north } = t.bounds;
  const crewPositions = (): LngLat[] =>
    crews.map((c) => [west + (c.x / w) * (east - west), north - (c.y / h) * (north - south)]);

  const fight = (minute: number) => {
    const taken: number[] = [];
    for (const crew of crews) {
      if (minute < crew.leave || minute < crew.busyUntil) continue;
      if (crew.water <= 0) {
        // tank empty: drive back to the station and refill
        const d = Math.hypot(crew.homeX - crew.x, crew.homeY - crew.y);
        const step = Math.min(d, DRIVE_SPEED);
        if (d > 0) { crew.x += ((crew.homeX - crew.x) / d) * step; crew.y += ((crew.homeY - crew.y) / d) * step; }
        if (d - step < 0.5) { crew.water = TANK; crew.busyUntil = minute + REFILL_MIN; crew.target = -1; }
        continue;
      }
      if (crew.target < 0 || state[crew.target] !== 1 || minute % 5 === 0) {
        let best = -1, bestD = Infinity;
        for (const k of active) {
          if (state[k] !== 1) continue;
          const ki = k % w, kj = (k - ki) / w;
          if (taken.some((q) => Math.hypot((q % w) - ki, Math.floor(q / w) - kj) < SPREAD_OUT)) continue;
          const d = Math.hypot(ki + 0.5 - crew.x, kj + 0.5 - crew.y);
          if (d < bestD) { bestD = d; best = k; }
        }
        crew.target = best;
      }
      if (crew.target < 0) continue;
      taken.push(crew.target);
      const tx = (crew.target % w) + 0.5, ty = Math.floor(crew.target / w) + 0.5;
      const d = Math.hypot(tx - crew.x, ty - crew.y);
      const step = Math.min(d, d > REACH + 1 ? DRIVE_SPEED : WORK_SPEED);
      if (d > 0) { crew.x += ((tx - crew.x) / d) * step; crew.y += ((ty - crew.y) / d) * step; }
      if (d - step > REACH) continue;
      const ci = Math.floor(crew.x), cj = Math.floor(crew.y);
      for (let dj = -SOAK_REACH; dj <= SOAK_REACH; dj++)
        for (let di = -SOAK_REACH; di <= SOAK_REACH; di++) {
          const i = ci + di, j = cj + dj;
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const k = j * w + i;
          soaked[k] = 1;
          if (crew.water > 0 && state[k] === 1 && Math.hypot(di, dj) <= REACH && rng() < KNOCKDOWN) {
            state[k] = 2;
            putOut[k] = 1;
            crew.water--;
          }
        }
    }
  };

  const snapshot = () => {
    const f = new Uint8Array(N);
    for (let k = 0; k < N; k++) f[k] = state[k] === 1 ? 255 : putOut[k] ? 60 : state[k] === 2 ? 110 : 0;
    return f;
  };
  const frames = [snapshot()];
  const crewFrames = [crewPositions()];
  for (let fi = 1; fi < FRAME_COUNT; fi++) {
    for (let s = 0; s < STEPS_PER_FRAME && active.length; s++) {
      const time = (fi - 1 + (s + 1) / STEPS_PER_FRAME) / FRAMES_PER_HOUR;
      fight((fi - 1) * STEPS_PER_FRAME + s + 1);
      const current = active;
      active = [];
      for (const c of current) {
        if (state[c] !== 1) continue; // put out by a crew
        const ci = c % w, cj = (c - ci) / w;
        for (let d = 0; d < 8; d++) {
          const i = ci + DIRS8[d][0], j = cj + DIRS8[d][1];
          if (i < 0 || j < 0 || i >= w || j >= h) continue;
          const n = j * w + i;
          if (state[n] !== 0 || fuel[n] <= 0) continue;
          const slopeDeg = (Math.atan((elev[n] - elev[c]) / (dist[d] * cellM)) * 180) / Math.PI;
          const ps = Math.min(4, Math.exp(0.078 * slopeDeg));
          const prob = ((P0 * hum * fuel[n] * pw[d] * ps) / dist[d]) * (soaked[n] ? SOAKED : 1);
          if (rng() < prob) ignite(n, time);
        }
        if (--burnLeft[c] === 0) state[c] = 2;
        else active.push(c);
      }
    }
    frames.push(snapshot());
    crewFrames.push(crewPositions());
  }
  return {
    frames,
    arrival,
    area: frames.map((f) => areaKm2(f, cellM)),
    crews: crews.length ? crewFrames : undefined,
  };
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
