import { FRAMES_PER_HOUR, type SimResult, type Terrain } from "./types";

export type ResidentialWarning = {
  id: string;
  cell: number;
  firstFrame: number;
  activeFrames: Uint8Array;
};

export type ResidentialAlert = {
  id: string;
  cell: number;
  status: "upcoming" | "active";
  hoursUntil: number;
};

/** Group threatened residential cells into kilometre-sized areas to keep the map readable.
 * Evaluate actual forecast frames, so dissipated cells and areas outside the path do not warn.
 */
export function buildResidentialWarnings(t: Terrain, result: SimResult): ResidentialWarning[] {
  if (!t.residential) return [];
  const block = Math.max(1, Math.round(1000 / t.cellM));
  const groups = new Map<string, ResidentialWarning>();
  for (let k = 0; k < t.w * t.h; k++) {
    if (!t.residential[k]) continue;
    const id = `${Math.floor((k % t.w) / block)}:${Math.floor(Math.floor(k / t.w) / block)}`;
    for (let fi = 0; fi < result.frames.length; fi++) {
      if (result.frames[fi][k] < 80) continue;
      let warning = groups.get(id);
      if (!warning) {
        warning = { id, cell: k, firstFrame: fi, activeFrames: new Uint8Array(result.frames.length) };
        groups.set(id, warning);
      }
      if (fi < warning.firstFrame) {
        warning.firstFrame = fi;
        warning.cell = k;
      }
      warning.activeFrames[fi] = 1;
    }
  }
  return [...groups.values()].sort((a, b) => a.firstFrame - b.firstFrame);
}

/** Remove warnings once the last forecast storm cells have passed; supports timeline scrubbing. */
export function residentialAlertsAtFrame(warnings: ResidentialWarning[], frame: number): ResidentialAlert[] {
  const alerts: ResidentialAlert[] = [];
  for (const warning of warnings) {
    for (let next = frame; next < warning.activeFrames.length; next++) {
      if (!warning.activeFrames[next]) continue;
      alerts.push({
        id: warning.id, cell: warning.cell,
        status: next === frame ? "active" : "upcoming",
        hoursUntil: (next - frame) / FRAMES_PER_HOUR,
      });
      break;
    }
  }
  return alerts;
}
