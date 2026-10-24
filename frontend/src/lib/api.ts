/** Typed HTTP contract for the prepared-grid FastAPI service. */
import type { GeoJSONSourceSpecification } from "maplibre-gl";

export type MapGeoJSON = Exclude<GeoJSONSourceSpecification["data"], string>;
export type Hazard = "wildfire" | "flood";
export type LngLat = [number, number];
export type Controls = {
  windSpeed: number;
  windDir: number;
  humidity: number;
  rainfall: number;
  saturation: number;
};

export type PlaceMetadata = {
  slug: string;
  name: string;
  center: LngLat;
  cityAoi: MapGeoJSON | null;
  cityAoiSource: string | null;
  coverage: { cityAreaKm2: number; intersectionKm2: number; percent: number } | null;
  grids: Record<Hazard, { available: boolean; id: string; version: string } | null>;
};
export type GridMetadata = {
  id: string;
  version: string;
  place: string;
  hazard: Hazard;
  crs: string;
  transform: [number, number, number, number, number, number];
  width: number;
  height: number;
  cellSizeM: number;
  footprint: MapGeoJSON;
  displayCorners: [LngLat, LngLat, LngLat, LngLat];
  sourceDates: string[] | string;
  processingVersion: string;
  modelVersion: string;
  quality: Record<string, unknown>;
  fuelLabel: string;
};
export type SimulationRequest = {
  place: string;
  hazard: Hazard;
  origin: { longitude: number; latitude: number };
  controls: Controls;
};
export type SimulationResponse = {
  gridId: string;
  gridVersion: string;
  modelVersion: string;
  seed: number;
  origin: { cell: number; row: number; col: number; center: LngLat };
  geometry: { displayCorners: [LngLat, LngLat, LngLat, LngLat]; width: number; height: number; cellSizeM: number };
  areaKm2: number[];
  frames: {
    codec: "gzip-uint8-frames-v1";
    width: number;
    height: number;
    count: number;
    states: Record<string, string | number>;
    data: string;
  };
};
export type DecodedSimulation = Omit<SimulationResponse, "frames"> & { frames: Uint8Array[] };

export class ApiError extends Error {
  constructor(public status: number, message: string) { super(message); }
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
    } catch { /* non-JSON gateway error */ }
    throw new ApiError(res.status, detail);
  }
  return (await res.json()) as T;
}

/** Decode one stable gzip stream of consecutive row-major uint8 frames. */
export async function decodeFrames(payload: SimulationResponse): Promise<DecodedSimulation> {
  const { frames, ...rest } = payload;
  if (frames.codec !== "gzip-uint8-frames-v1" || frames.count !== 97 ||
      !Number.isInteger(frames.width) || !Number.isInteger(frames.height) ||
      frames.width < 1 || frames.height < 1 || payload.areaKm2.length !== frames.count) {
    throw new Error("Unsupported or incomplete simulation frame format");
  }
  const compressed = Uint8Array.from(atob(frames.data), (c) => c.charCodeAt(0));
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  const raw = new Uint8Array(await new Response(stream).arrayBuffer());
  const frameSize = frames.width * frames.height;
  if (raw.length !== frameSize * frames.count) throw new Error("Simulation frame length does not match its geometry");
  const decoded = Array.from({ length: frames.count }, (_, i) => raw.subarray(i * frameSize, (i + 1) * frameSize));
  return { ...rest, frames: decoded };
}

export const api = {
  health: () => request<{ status: string; database: string }>("/health"),
  places: (signal?: AbortSignal) => request<{ places: PlaceMetadata[] }>("/places", { signal }),
  grid: (place: string, hazard: Hazard, signal?: AbortSignal) =>
    request<GridMetadata>(`/grids/${encodeURIComponent(place)}/${hazard}`, { signal }),
  simulate: (data: SimulationRequest, signal?: AbortSignal) =>
    request<SimulationResponse>("/simulations", { method: "POST", body: JSON.stringify(data), signal }),
};
