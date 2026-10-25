export type Hazard = "wildfire" | "flood";

/** [longitude, latitude] */
export type LngLat = [number, number];

export type Bounds = { west: number; south: number; east: number; north: number };

/** A square grid of cells sampled from real elevation + imagery around a place. Row 0 is north. */
export type Terrain = {
  key: string;
  name: string;
  center: LngLat;
  bounds: Bounds;
  w: number;
  h: number;
  cellM: number;
  elev: Float32Array;
  /** 0..1 burnable fuel estimate (0 = water / bare). */
  fuel: Float32Array;
  /** 1 = sea level or below (acts as a sink for floods). */
  sea: Uint8Array;
  demSource: "terrarium" | "synthetic";
  fuelSource: "imagery" | "uniform";
  minElev: number;
  maxElev: number;
};

export type Params = {
  /** km/h */
  windSpeed: number;
  /** degrees, meteorological: direction the wind blows FROM */
  windDir: number;
  /** % */
  humidity: number;
  /** mm/h */
  rainfall: number;
  /** % */
  saturation: number;
  /** fire crews dispatched (0 = no firefighting) */
  crews: number;
};

/** A real fire station from OpenStreetMap. */
export type Station = { name: string; lngLat: LngLat };

/**
 * Per-frame cell values (0 = unaffected). Meaning per hazard:
 *  wildfire: 255 burning, 110 burnt, 60 put out by crews
 *  flood: 40..255 scaled water depth
 */
export type SimResult = {
  frames: Uint8Array[];
  /** hours until a cell is first affected (Infinity = never within the horizon) */
  arrival: Float32Array;
  /** km² affected per frame */
  area: number[];
  /** wildfire only: where each fire crew is in each frame */
  crews?: LngLat[][];
};

export const HOURS = 24;
export const FRAMES_PER_HOUR = 4;
export const FRAME_COUNT = HOURS * FRAMES_PER_HOUR + 1;
