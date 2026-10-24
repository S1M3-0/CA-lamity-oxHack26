/**
 * Tiny typed client for the FastAPI backend.
 * Paths are relative ("/api/..."); next.config.ts forwards them to the backend.
 * Keep these types in sync with backend/api/models.py.
 */

import type { GeoJSONSourceSpecification } from "maplibre-gl";
import type { Bounds } from "@/lib/sim/types";

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
  health: () => request<{ status: string; database: string }>("/health"),
  aoi: {
    la: (signal?: AbortSignal) => request<MapGeoJSON>("/aoi/la", { signal }),
  },
  fire: {
    la: (data: LaFireRequest) =>
      request<FireResult>("/fire/la", { method: "POST", body: JSON.stringify(data) }),
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
