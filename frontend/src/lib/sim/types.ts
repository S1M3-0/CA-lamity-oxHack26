export type Hazard = "wildfire" | "flood" | "hurricane";

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
  /** Estimated residential cells from OSM map colours; absent when those tiles are unavailable. */
  residential?: Uint8Array;
  /** 1 = mapped river or lake (OpenStreetMap), carved in as a flood channel. */
  water: Uint8Array;
  /** 0..1 share of rain that runs off dry ground (pavement high, forest low). */
  runoff: Float32Array;
  demSource: "terrarium" | "synthetic";
  /** landcover = OpenStreetMap land use, with imagery filling unmapped land */
  fuelSource: "landcover" | "imagery" | "uniform";
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
  /** mm/h, averaged over the storm */
  rainfall: number;
  /** how long the storm lasts, hours */
  stormHours: number;
  /** % */
  saturation: number;
};

/**
 * Per-frame cell values (0 = unaffected). Meaning per hazard:
 *  wildfire: 255 burning, 110 burnt
 *  flood: 40..255 scaled water depth; 1..39 water inside a river channel (not flooding)
 *  hurricane: 40..255 relative storm intensity; the eye is transparent
 */
export type SimResult = {
  frames: Uint8Array[];
  /** hours until a cell is first affected (Infinity = never within the horizon) */
  arrival: Float32Array;
  /** km² affected per frame */
  area: number[];
  /** Hurricane eye position in grid coordinates for each frame, including outside the map. */
  stormTrack?: { col: number; row: number }[];
};

export const HOURS = 24;
export const FRAMES_PER_HOUR = 4;
export const FRAME_COUNT = HOURS * FRAMES_PER_HOUR + 1;
/** Flood frame values below this are river water inside its channel, not flooding. */
export const FLOOD_MIN = 40;
