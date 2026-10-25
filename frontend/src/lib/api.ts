/**
 * Tiny typed client for the FastAPI backend.
 * Paths are relative ("/api/..."); next.config.ts forwards them to the backend.
 * Keep these types in sync with backend/api/models.py.
 */

import type { GeoJSONSourceSpecification } from "maplibre-gl";
import type { Bounds, Hazard, Params, WeatherDay, WeatherHour } from "@/lib/sim/types";

export type MapGeoJSON = Exclude<GeoJSONSourceSpecification["data"], string>;

/** Keep in sync with backend/api/routes/fire.py. */
export type LaFireRequest = {
  /** [lon, lat] pairs */
  ignition_points: [number, number][];
  /** degrees the wind blows from */
  wind_direction: number;
  wind_speed_kmh: number;
  /** relative humidity, % */
  humidity: number;
  bounds?: Bounds;
  max_cells?: number;
  num_frames?: number;
  steps_per_frame?: number;
  seed?: number;
  hourly_weather?: WeatherHour[];
};

export type FireResult = {
  bounds: Bounds;
  w: number;
  h: number;
  cellM: number;
  /** base64, one byte per cell, row 0 north: 0 unburnt, 255 burning, 110 burnt */
  frames: string[];
  /** km² affected per frame */
  area: number[];
};

/** Keep in sync with backend/api/routes/flood.py. Grids are base64, row 0 north. */
export type FloodRequest = {
  w: number;
  h: number;
  cell_m: number;
  /** float32 little-endian metres */
  elevation: string;
  /** uint8 per cell: 0 land, 1 river or lake, 2 sea */
  cover: string;
  /** uint8 per cell: share of rain running off dry ground, 0..255 */
  runoff: string;
  /** average over the storm */
  rainfall_mm_h: number;
  storm_hours: number;
  /** % */
  saturation: number;
  num_frames?: number;
  minutes_per_frame?: number;
  hourly_rainfall?: number[];
};

/** Frames use 0 dry, 1..39 water inside a river channel, 40..255 flood depth. */
export type FloodResult = Omit<FireResult, "bounds">;

/** A generated run as stored in Tiger Data. Keep in sync with backend/api/routes/runs.py. */
export type SavedRun = {
  id: number;
  created_at: string;
  hazard: Hazard;
  place_name: string;
  /** [lon, lat] */
  center: [number, number];
  params: Params;
  origin: [number, number] | null;
  seed: number;
  source: "backend" | "browser";
  /** edges of the grid the frames were simulated on */
  bounds: Bounds;
  w: number;
  h: number;
  cell_m: number;
};

export type RunCreate = Omit<SavedRun, "id" | "created_at"> & {
  frames_per_hour: number;
  area_km2: number[];
  /** burning (fire) or 1 m+ deep (flood) area per frame */
  active_km2: number[];
  /** affected cells at each whole hour, base64 bit-packed, row 0 north */
  hourly_masks: string[];
};

/** Nearest evacuation centre the hazard never reaches, for one hour and one compass sector. */
export type SafePoint = {
  hour: number;
  /** 0 = north, then clockwise in 45° steps */
  sector: number;
  facility_id: number;
  name: string;
  kind: string;
  lon: number;
  lat: number;
  /** metres from that hour's affected area */
  distance_m: number;
};

/** Keep in sync with backend/api/routes/responders.py. */
export type ResponderRouteRequest = {
  /** edges of the grid the frames were simulated on */
  bounds: Bounds;
  w: number;
  h: number;
  frames_per_hour: number;
  /** base64, one byte per cell, row 0 north: frame the hazard first reaches it, 255 = never */
  arrival: string;
};

/** Fastest road route that avoids the hazard, from a fire, police or ambulance station, for one hour. */
export type ResponderRoute = {
  hour: number;
  /** people: a street the hazard reaches in the next 2 h; front: the nearest open road to its edge */
  goal: "people" | "front";
  station: { name: string; kind: string; lon: number; lat: number };
  target: { lon: number; lat: number; hazard_eta_h: number | null; residential: boolean };
  travel_s: number;
  distance_m: number;
  /** how long before the hazard the crew arrives (negative: after it); null for the front */
  spare_s: number | null;
  /** [lon, lat] from the station to the target */
  path: [number, number][];
};

/** 202 "preparing" while the backend downloads an area's roads for the first time: ask again shortly. */
export type ResponderRoutesResult =
  | { status: "ready"; routes: ResponderRoute[] }
  | { status: "preparing"; detail: string };

export type HourStat = {
  hour: number;
  area_km2: number;
  growth_km2: number;
  peak_active_km2: number;
  rain_mm: number;
};

export type RunStats = { hazard: Hazard; hourly: HourStat[]; summary: Record<string, number> };

export type Item = {
  id: number;
  title: string;
  description: string | null;
  done: boolean;
  created_at: string;
};

export type ItemCreate = Pick<Item, "title"> & Partial<Pick<Item, "description" | "done">>;
export type ItemUpdate = Partial<Omit<Item, "id" | "created_at">>;

export class ApiError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

export async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...init?.headers },
  });
  if (!res.ok) {
    let detail = res.statusText;
    try {
      const body = await res.json();
      detail = typeof body.detail === "string" ? body.detail : JSON.stringify(body.detail);
    } catch {}
    throw new ApiError(res.status, detail);
  }
  return (res.status === 204 ? undefined : await res.json()) as T;
}

export const api = {
  weather: {
    yesterday: (latitude: number, longitude: number, signal?: AbortSignal) =>
      request<WeatherDay>(`/weather/yesterday?latitude=${latitude}&longitude=${longitude}`, { signal }),
  },
  health: () => request<{ status: string; database: string }>("/health"),
  aoi: {
    la: (signal?: AbortSignal) => request<MapGeoJSON>("/aoi/la", { signal }),
  },
  fire: {
    la: (data: LaFireRequest) =>
      request<FireResult>("/fire/la", { method: "POST", body: JSON.stringify(data) }),
  },
  flood: {
    simulate: (data: FloodRequest) =>
      request<FloodResult>("/flood/simulate", { method: "POST", body: JSON.stringify(data) }),
  },
  runs: {
    list: (limit: number) => request<SavedRun[]>(`/runs?limit=${limit}`),
    create: (data: RunCreate) => request<SavedRun>("/runs", { method: "POST", body: JSON.stringify(data) }),
    remove: (id: number) => request<void>(`/runs/${id}`, { method: "DELETE" }),
    safePoints: (id: number) => request<SafePoint[]>(`/runs/${id}/safe-points`),
    stats: (id: number) => request<RunStats>(`/runs/${id}/stats`),
  },
  responders: {
    routes: (data: ResponderRouteRequest) =>
      request<ResponderRoutesResult>("/responders/routes", { method: "POST", body: JSON.stringify(data) }),
  },
  items: {
    list: () => request<Item[]>("/items"),
    create: (data: ItemCreate) =>
      request<Item>("/items", { method: "POST", body: JSON.stringify(data) }),
    update: (id: number, data: ItemUpdate) =>
      request<Item>(`/items/${id}`, { method: "PATCH", body: JSON.stringify(data) }),
    remove: (id: number) => request<void>(`/items/${id}`, { method: "DELETE" }),
  },
};
