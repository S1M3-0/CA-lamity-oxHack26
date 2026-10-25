import saved from "./vulnerable.json";
import { lngLatToCell } from "./terrain";
import type { SimResult, Terrain, VulnerablePlace } from "./types";

/**
 * Hospitals, care homes and schools per preset place, keyed by terrainKey. Pulled once from
 * OpenStreetMap (© OpenStreetMap contributors, ODbL) because the public Overpass API rate-limits.
 */
// JSON imports type kind as string and [lon, lat] as number[], so assert the shape.
const SAVED = saved as unknown as Record<string, VulnerablePlace[]>;

export const vulnerablePlaces = (key: string): VulnerablePlace[] => SAVED[key] ?? [];

export const KIND_LABEL: Record<VulnerablePlace["kind"], string> = {
  hospital: "Hospital",
  care_home: "Care home",
  school: "School",
};

/**
 * Rough hours needed to get everyone out: patients and frail residents need vehicles and staff,
 * a school can walk out. Used to say when evacuation must *start*, not just when the hazard arrives.
 */
export const EVACUATION_HOURS: Record<VulnerablePlace["kind"], number> = {
  hospital: 3,
  care_home: 2,
  school: 1,
};

export type PlaceAtRisk = {
  place: VulnerablePlace;
  /** simulation hour the hazard reaches it */
  arrivalH: number;
  /** latest hour evacuation can start and still finish in time (can be < 0: already too late at T+0) */
  startByH: number;
};

export type PlaceStatus = "later" | "start_now" | "late" | "reached";

/** Places the hazard reaches within the run, most urgent first. */
export function placesAtRisk(t: Terrain, r: SimResult, places: VulnerablePlace[]): PlaceAtRisk[] {
  return places
    .flatMap((place) => {
      const c = lngLatToCell(t, place.lngLat);
      const arrivalH = c < 0 ? Infinity : r.arrival[c];
      return Number.isFinite(arrivalH) ? [{ place, arrivalH, startByH: arrivalH - EVACUATION_HOURS[place.kind] }] : [];
    })
    .sort((a, b) => a.startByH - b.startByH);
}

/** Where a place stands at time `now`: fine for now, must start evacuating, too late to finish, or hit. */
export function placeStatus(p: PlaceAtRisk, now: number): PlaceStatus {
  if (now >= p.arrivalH) return "reached";
  if (now > p.startByH) return "late";
  if (now >= p.startByH - 0.5) return "start_now";
  return "later";
}
