import type { Bounds, Station } from "./types";
import saved from "./stations.json";

const OVERPASS_URL = "https://overpass-api.de/api/interpreter";

/**
 * Fire stations for each preset place, keyed by terrainKey. Pulled once from OpenStreetMap
 * (© OpenStreetMap contributors, ODbL) because the public Overpass API rate-limits.
 */
// JSON imports type [lon, lat] as number[], so assert the tuple shape.
const SAVED = saved as unknown as Record<string, Station[]>;

type OverpassElement = {
  lat?: number;
  lon?: number;
  center?: { lat: number; lon: number };
  tags?: Record<string, string>;
};

/** Real fire stations inside `b` (amenity=fire_station): saved for presets, live from Overpass otherwise. */
export async function loadStations(key: string, b: Bounds): Promise<Station[]> {
  if (SAVED[key]) return SAVED[key];
  const box = `${b.south},${b.west},${b.north},${b.east}`;
  const query = `[out:json][timeout:25];(node["amenity"="fire_station"](${box});way["amenity"="fire_station"](${box}););out center;`;
  const res = await fetch(OVERPASS_URL, { method: "POST", body: new URLSearchParams({ data: query }) });
  if (!res.ok) throw new Error(`Fire stations unavailable (${res.status})`);
  const { elements } = (await res.json()) as { elements: OverpassElement[] };
  return elements.flatMap((e) => {
    const lat = e.lat ?? e.center?.lat;
    const lon = e.lon ?? e.center?.lon;
    if (lat === undefined || lon === undefined) return [];
    return [{ name: e.tags?.name ?? "Fire station", lngLat: [lon, lat] as [number, number] }];
  });
}
