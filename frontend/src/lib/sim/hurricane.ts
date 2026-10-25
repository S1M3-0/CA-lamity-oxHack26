import { mulberry32 } from "./rng";
import { FRAME_COUNT, FRAMES_PER_HOUR, HOURS, type Params, type SimResult, type Terrain } from "./types";

const NEIGHBOURS = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/** Illustrative continuous-state CA: transport/rotate cells, then apply neighbour birth/death rules.
 * Size and steering speed are scaled to the local map, rather than forecast hurricane units.
 * The eye follows the downwind bearing with a seeded deviation bounded by +/-15 degrees.
 */
export function simulateHurricane(t: Terrain, p: Params, origin: number, seed: number): SimResult {
  const { w, h, cellM } = t;
  const n = w * h;
  const rng = mulberry32(seed);
  const stepsPerFrame = 4;
  const dtH = 1 / FRAMES_PER_HOUR / stepsPerFrame;
  const windTo = ((p.windDir + 180) * Math.PI) / 180;
  const maxDeviation = Math.PI / 12;
  // 1% of the selected wind speed keeps the storm visible on the 12 km local map.
  const travelPerStep = (Math.max(0, p.windSpeed) * 1000 * 0.01 * dtH) / cellM;
  const maxRadius = Math.max(3, Math.min(w, h) * 0.32);
  const spin = t.center[1] >= 0 ? -1 : 1;
  const rotation = spin * 0.075;
  const cos = Math.cos(rotation), sin = Math.sin(rotation);
  let cx = origin % w, cy = Math.floor(origin / w);
  let deviation = 0;
  let state = new Float32Array(n);
  let next = new Float32Array(n);
  const transported = new Float32Array(n);
  const arrival = new Float32Array(n).fill(Infinity);

  const sample = (x: number, y: number) => {
    if (x < 0 || y < 0 || x > w - 1 || y > h - 1) return 0;
    const ix = Math.floor(x), iy = Math.floor(y);
    const fx = x - ix, fy = y - iy;
    const right = Math.min(ix + 1, w - 1), bottom = Math.min(iy + 1, h - 1);
    return (state[iy * w + ix] * (1 - fx) + state[iy * w + right] * fx) * (1 - fy)
      + (state[bottom * w + ix] * (1 - fx) + state[bottom * w + right] * fx) * fy;
  };
  for (let y = Math.max(0, cy - 2); y <= Math.min(h - 1, cy + 2); y++) {
    for (let x = Math.max(0, cx - 2); x <= Math.min(w - 1, cx + 2); x++) {
      const r = Math.hypot(x - cx, y - cy);
      if (r >= 0.8 && r <= 2.5) state[y * w + x] = 0.8;
    }
  }

  const snapshot = (time: number) => {
    const frame = new Uint8Array(n);
    let count = 0;
    for (let k = 0; k < n; k++) {
      if (state[k] < 0.06) continue;
      frame[k] = 40 + Math.round(Math.min(1, state[k]) * 215);
      if (arrival[k] === Infinity) arrival[k] = time;
      count++;
    }
    return { frame, area: count * cellM * cellM / 1e6 };
  };
  const initial = snapshot(0);
  const frames = [initial.frame];
  const area = [initial.area];
  const stormTrack = [{ col: cx, row: cy }];
  for (let fi = 1; fi < FRAME_COUNT; fi++) {
    // Smoothly turn towards a random offset; never accumulate turns beyond the wind cone.
    const targetDeviation = (rng() * 2 - 1) * maxDeviation;
    deviation = deviation * 0.8 + targetDeviation * 0.2;
    const heading = windTo + deviation;
    for (let step = 0; step < stepsPerFrame; step++) {
      const time = (fi - 1 + (step + 1) / stepsPerFrame) / FRAMES_PER_HOUR;
      const oldX = cx, oldY = cy;
      cx += Math.sin(heading) * travelPerStep;
      cy -= Math.cos(heading) * travelPerStep;
      // Grow to maturity, then break up and fade during the final third of the run.
      const dissipation = Math.max(0, (time / HOURS - 0.65) / 0.35);
      const energy = Math.pow(Math.max(0, 1 - dissipation), 1.5);
      const radius = (2.5 + (maxRadius - 2.5) * Math.pow(Math.min(1, time / (HOURS * 0.55)), 0.75))
        * (1 - 0.85 * dissipation);
      const eyeRadius = Math.max(0.8, radius * 0.16);
      const x0 = Math.max(0, Math.floor(cx - radius - 2));
      const x1 = Math.min(w - 1, Math.ceil(cx + radius + 2));
      const y0 = Math.max(0, Math.floor(cy - radius - 2));
      const y1 = Math.min(h - 1, Math.ceil(cy + radius + 2));
      transported.fill(0);
      next.fill(0);
      // Read only the previous generation, including fractional movement between grid cells.
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          transported[y * w + x] = sample(oldX + cos * dx + sin * dy, oldY - sin * dx + cos * dy);
        }
      }
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = x - cx, dy = y - cy;
          const distance = Math.hypot(dx, dy);
          if (distance < eyeRadius || distance > radius) continue;
          const k = y * w + x;
          let strongest = 0, sum = 0, living = 0;
          for (const [nx, ny] of NEIGHBOURS) {
            const xx = x + nx, yy = y + ny;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const v = transported[yy * w + xx];
            strongest = Math.max(strongest, v);
            sum += v;
            if (v >= 0.12) living++;
          }
          // Spiral bands bias local growth; cells cannot activate without a storm neighbour.
          const turbulence = 0.7 * Math.sin(dx * 0.43 + time) + 0.6 * Math.cos(dy * 0.37 - time * 0.7);
          const band = 0.5 + 0.5 * Math.cos(2 * Math.atan2(dy, dx) + distance * 0.28 - spin * time * 0.9 + turbulence);
          const eyewall = Math.exp(-Math.pow((distance - eyeRadius * 1.45) / Math.max(1, radius * 0.08), 2));
          const alive = transported[k] >= 0.12;
          // Life-inspired rules: isolation and crowding kill cells; supported neighbours birth new ones.
          const supported = living >= 2 && living <= 6;
          const crowded = living >= 7;
          let value = transported[k] * (supported ? 0.98 : crowded ? 0.8 : 0.35);
          const canBirth = living >= 2 && living <= 5 || eyewall > 0.35 && living >= 1;
          if (!alive && canBirth && rng() < (0.2 + 0.6 * band) * energy) {
            value = Math.max(value, strongest * 0.85);
          }
          if (rng() < 0.015 + (crowded ? 0.12 : 0) + 0.04 * (1 - band) + 0.15 * dissipation) continue;
          const intensityCap = Math.min(1, 0.35 + 0.65 * band + 0.3 * eyewall) * energy;
          if (value > 0.025) next[k] = Math.min(intensityCap, value + sum / 8 * (0.04 + 0.08 * band + 0.08 * eyewall));
        }
      }
      [state, next] = [next, state];
    }
    const saved = snapshot(fi / FRAMES_PER_HOUR);
    frames.push(saved.frame);
    area.push(saved.area);
    stormTrack.push({ col: cx, row: cy });
  }
  return { frames, arrival, area, stormTrack };
}
