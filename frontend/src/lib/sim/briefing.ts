import { compass } from "./index";
import { cellToLngLat, lngLatToCell } from "./terrain";
import { KIND_LABEL, type PlaceAtRisk } from "./vulnerable";
import { FRAMES_PER_HOUR, HOURS, type Hazard, type LngLat, type Params, type SimResult, type Station, type Terrain } from "./types";

export type BriefingInput = {
  hazard: Hazard;
  placeName: string;
  terrain: Terrain;
  params: Params;
  origin: LngLat | null;
  stations: Station[];
  result: SimResult;
  /** hospitals, care homes and schools in the path, most urgent first */
  placesAtRisk?: PlaceAtRisk[];
};

type StationFact = { name: string; km: number; direction: string };

/** Plain numbers about a finished run; what Gemini is allowed to talk about. */
export type BriefingFacts = {
  place: string;
  hazard: Hazard;
  conditions: Record<string, string>;
  areaKm2: Record<string, number>;
  spread: { direction: string; reachKm6h: number; reachKm24h: number } | null;
  stillActiveAt24h: boolean;
  containedAtHour: number | null;
  crewsSent: number;
  putOutKm2: number;
  nearestStations: StationFact[];
  stationsReached: { name: string; hour: number }[];
  /** most urgent vulnerable places: when evacuation must start, and when the hazard arrives */
  evacuateFirst: { name: string; kind: string; startEvacuatingByHour: number; hazardArrivesHour: number }[];
};

const round1 = (v: number) => Math.round(v * 10) / 10;

/** x = km east, y = km north; bearing in degrees clockwise from north. */
const vec = (x: number, y: number) => ({ x, y, km: Math.hypot(x, y), bearing: ((Math.atan2(x, y) * 180) / Math.PI + 360) % 360 });

const offsetKm = ([lon0, lat0]: LngLat, [lon, lat]: LngLat) =>
  vec((lon - lon0) * 111.32 * Math.cos((lat0 * Math.PI) / 180), (lat - lat0) * 110.57);

export function summarizeRun(r: BriefingInput): BriefingFacts {
  const { terrain: t, result, params: p } = r;
  const at = (h: number) => Math.min(Math.round(h * FRAMES_PER_HOUR), result.frames.length - 1);
  const from = r.origin ?? t.center;
  const last = result.frames[at(HOURS)];
  const cellKm2 = (t.cellM * t.cellM) / 1e6;

  // Main direction = from the origin to the middle of everything affected; reach = farthest affected cell.
  const reach = (frame: Uint8Array) => {
    let far = 0, sx = 0, sy = 0, n = 0;
    for (let c = 0; c < frame.length; c++) {
      if (!frame[c]) continue;
      const o = offsetKm(from, cellToLngLat(t, c));
      far = Math.max(far, o.km);
      sx += o.x;
      sy += o.y;
      n++;
    }
    return { far, n, mid: n ? vec(sx / n, sy / n) : null };
  };
  const r6 = reach(result.frames[at(6)]);
  const r24 = reach(last);
  const spread =
    r24.mid && r24.n
      ? {
          direction: r24.mid.km < 0.3 ? "all directions" : compass(r24.mid.bearing),
          reachKm6h: round1(r6.far),
          reachKm24h: round1(r24.far),
        }
      : null;

  let burning = 0, putOut = 0;
  for (const v of last) {
    if (v === 255) burning++;
    else if (v === 60) putOut++;
  }
  let containedAtHour: number | null = null;
  if (r.hazard === "wildfire" && burning === 0) {
    const f = result.frames.findIndex((fr, i) => i > 0 && !fr.includes(255));
    if (f > 0) containedAtHour = round1(f / FRAMES_PER_HOUR);
  }

  const nearestStations = r.stations
    .map((s) => {
      const o = offsetKm(from, s.lngLat);
      return { name: s.name, km: round1(o.km), direction: compass(o.bearing) };
    })
    .sort((a, b) => a.km - b.km)
    .slice(0, 3);
  const stationsReached = r.stations
    .map((s) => {
      const c = lngLatToCell(t, s.lngLat);
      return { name: s.name, hour: c < 0 ? Infinity : round1(result.arrival[c]) };
    })
    .filter((s) => Number.isFinite(s.hour))
    .sort((a, b) => a.hour - b.hour)
    .slice(0, 4);

  const conditions: Record<string, string> =
    r.hazard === "wildfire"
      ? {
          wind: `${p.windSpeed} km/h from the ${compass(p.windDir)}`,
          humidity: `${p.humidity}%`,
        }
      : { rainfall: `${p.rainfall} mm/h`, soilSaturation: `${p.saturation}%` };

  return {
    place: r.placeName,
    hazard: r.hazard,
    conditions,
    areaKm2: Object.fromEntries([1, 3, 6, 12, 24].map((h) => [`${h}h`, round1(result.area[at(h)])])),
    spread,
    stillActiveAt24h: r.hazard === "wildfire" ? burning > 0 : (result.area[at(HOURS)] ?? 0) > (result.area[at(HOURS - 1)] ?? 0),
    containedAtHour,
    crewsSent: r.hazard === "wildfire" ? p.crews : 0,
    putOutKm2: round1(putOut * cellKm2),
    nearestStations,
    stationsReached,
    evacuateFirst: (r.placesAtRisk ?? []).slice(0, 4).map((p) => ({
      name: p.place.name,
      kind: KIND_LABEL[p.place.kind].toLowerCase(),
      startEvacuatingByHour: round1(Math.max(0, p.startByH)),
      hazardArrivesHour: round1(p.arrivalH),
    })),
  };
}

// Written out so speech engines say "southwest", not "S W".
export const COMPASS_WORDS: Record<string, string> = {
  N: "north", NE: "northeast", E: "east", SE: "southeast", S: "south", SW: "southwest", W: "west", NW: "northwest",
};

/** "Los Angeles Fire Department Fire Station 9" -> "Station 9" */
export const shortStationName = (name: string) => name.match(/station\s*\d+\w*/i)?.[0].replace(/^s/, "S") ?? name;

/** Briefing written without AI, used when Gemini isn't configured or fails. Phrased to be read aloud. */
export function templateBriefing(f: BriefingFacts): string {
  const km = (v: number) => `${v} square kilometre${v === 1 ? "" : "s"}`;
  const hoursIn = (h: number) => (h < 1 ? "within the first hour" : `about ${Math.round(h)} hour${Math.round(h) === 1 ? "" : "s"} in`);
  const toward = f.spread && f.spread.direction !== "all directions" ? COMPASS_WORDS[f.spread.direction] : null;
  const wind = (f.conditions.wind ?? "")
    .replace("km/h", "kilometres an hour")
    .replace(/the (\w+)$/, (_, c: string) => `the ${COMPASS_WORDS[c] ?? c}`);
  const s: string[] = [];
  if (f.hazard === "wildfire") {
    s.push(`All units, simulated incident, wildfire in ${f.place}. Wind ${wind}, humidity ${f.conditions.humidity}.`);
    s.push(`Fire is spreading ${toward ? `toward the ${toward}` : "in all directions"}, ${km(f.areaKm2["6h"])} after six hours.`);
  } else {
    s.push(`All units, simulated incident, flooding in ${f.place}. Rainfall ${f.conditions.rainfall.replace("mm/h", "millimetres an hour")}.`);
    s.push(
      `Water is spreading ${toward ? `toward the ${toward}` : "in all directions"}, ${km(f.areaKm2["6h"])} flooded after six hours and ${km(f.areaKm2["24h"])} by the end of the day.`,
    );
  }
  for (const st of f.stationsReached.slice(0, 2)) s.push(`It reaches ${shortStationName(st.name)} ${hoursIn(st.hour)}.`);
  const first = f.evacuateFirst.slice(0, 2);
  if (first.length)
    s.push(`Priority evacuations: ${first.map((p) => `${p.name}, a ${p.kind}, start ${p.startEvacuatingByHour < 0.5 ? "immediately" : `within ${Math.round(p.startEvacuatingByHour)} hours`}`).join("; ")}.`);
  if (f.hazard === "wildfire") {
    const nearest = f.nearestStations.slice(0, 2).map((st) => shortStationName(st.name));
    if (f.crewsSent === 0) {
      s.push(`No crews assigned.${nearest.length ? ` Recommend immediate dispatch from ${nearest.join(" and ")}.` : ""}`);
    } else {
      s.push(`${f.crewsSent} engine${f.crewsSent === 1 ? "" : "s"} responding${nearest.length ? ` from ${nearest.join(" and ")}` : ""}.`);
      s.push(
        f.containedAtHour !== null
          ? `Fire contained ${hoursIn(f.containedAtHour)}.`
          : `Crews are not holding the line, ${km(f.areaKm2["24h"])} burnt by the end of the day. Request more units.`,
      );
    }
    s.push(toward ? `Evacuate residents ${toward} of the ignition point.` : "Evacuate residents around the ignition point.");
  } else {
    s.push(toward ? `Move residents ${toward} of the breach to higher ground.` : "Move residents near the breach to higher ground.");
  }
  return s.join(" ");
}
