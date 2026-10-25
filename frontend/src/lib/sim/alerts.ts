import { COMPASS_WORDS, shortStationName, type BriefingInput } from "./briefing";
import { compass } from "./index";
import { lngLatToCell } from "./terrain";
import type { Person } from "./types";

/** How long before the hazard reaches someone's home they are warned. */
export const LEAD_HOURS = 1;
/** Every alert starts with this, so nobody mistakes a demo for a real evacuation order. */
export const SIM_PREFIX = "SIMULATION - not a real emergency.";

export type PersonAlert = {
  person: Person;
  /** hours until the hazard reaches their home; null = it never does within 24 h */
  arrivalH: number | null;
  /** when the alert goes out (simulation hours); null = no alert needed */
  alertAtH: number | null;
  text: string | null;
};

export type PersonStatus = "outside" | "safe" | "pending" | "warned" | "hit";

/** Cells of clear ground required around a safe spot, so we never send people to the hazard's edge. */
const SAFE_MARGIN = 4;

/** Nearest spot the hazard never comes near, as a direction and distance from cell `from`. */
function safeGround(r: BriefingInput, from: number) {
  const { terrain: t, result } = r;
  const fx = from % t.w, fy = Math.floor(from / t.w);
  const clear = (x: number, y: number) => {
    for (let dy = -SAFE_MARGIN; dy <= SAFE_MARGIN; dy++)
      for (let dx = -SAFE_MARGIN; dx <= SAFE_MARGIN; dx++) {
        const nx = x + dx, ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= t.w || ny >= t.h) continue;
        if (result.arrival[ny * t.w + nx] !== Infinity) return false;
      }
    return true;
  };
  for (let rad = 1; rad <= 80; rad++) {
    let best = -1, bestD = Infinity;
    for (let dy = -rad; dy <= rad; dy++)
      for (let dx = -rad; dx <= rad; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== rad) continue;
        const x = fx + dx, y = fy + dy;
        if (x < 0 || y < 0 || x >= t.w || y >= t.h) continue;
        const c = y * t.w + x;
        if (t.sea[c]) continue;
        const d = Math.hypot(dx, dy);
        if (d >= bestD || !clear(x, y)) continue;
        (bestD = d), (best = c);
      }
    if (best >= 0) {
      const dx = (best % t.w) - fx, dy = fy - Math.floor(best / t.w); // y grows southward
      return { direction: COMPASS_WORDS[compass(((Math.atan2(dx, dy) * 180) / Math.PI + 360) % 360)], metres: bestD * t.cellM };
    }
  }
  return null;
}

const distance = (m: number) => (m < 950 ? `${Math.max(100, Math.round(m / 100) * 100)} metres` : `${(m / 1000).toFixed(1)} km`);

export function planAlerts(r: BriefingInput, people: Person[]): PersonAlert[] {
  return people.map((person) => {
    const c = lngLatToCell(r.terrain, person.lngLat);
    const arrival = c < 0 ? Infinity : r.result.arrival[c];
    if (!Number.isFinite(arrival)) return { person, arrivalH: null, alertAtH: null, text: null };

    const alertAtH = Math.max(0, arrival - LEAD_HOURS);
    const minutes = Math.max(5, Math.round(((arrival - alertAtH) * 60) / 5) * 5);
    const safe = safeGround(r, c);
    const what = r.hazard === "wildfire" ? "Wildfire" : "Flooding";
    const parts = [
      SIM_PREFIX,
      `TerraShift alert for ${person.name || "you"}: ${what} expected at your home in about ${minutes} minutes.`,
      safe ? `Leave now: head ${safe.direction} about ${distance(safe.metres)} to safe ground.` : "Leave now and follow official instructions.",
    ];
    if (r.hazard === "wildfire" && r.params.crews > 0 && r.stations.length) {
      const near = [...r.stations].sort(
        (a, b) => Math.hypot(a.lngLat[0] - person.lngLat[0], a.lngLat[1] - person.lngLat[1]) - Math.hypot(b.lngLat[0] - person.lngLat[0], b.lngLat[1] - person.lngLat[1]),
      )[0];
      parts.push(`Crews from ${shortStationName(near.name)} are responding.`);
    }
    return { person, arrivalH: arrival, alertAtH, text: parts.join(" ") };
  });
}

export function personStatus(a: PersonAlert, t: number, inside: boolean): PersonStatus {
  if (!inside) return "outside";
  if (a.arrivalH === null || a.alertAtH === null) return "safe";
  if (t >= a.arrivalH) return "hit";
  if (t >= a.alertAtH) return "warned";
  return "pending";
}
