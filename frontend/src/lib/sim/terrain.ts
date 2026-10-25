import type { Bounds, LngLat, Terrain } from "./types";

export const GRID = 200;
export const SPAN_KM = 12;
const TILE_ZOOM = 13;

export const TERRARIUM_URL =
  "https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png";
export const IMAGERY_URL =
  "https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}";
/** OSM's standard style paints each land use in a fixed colour, so its tiles double as a land-cover map. */
export const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";

/** OSM Carto fill colours (sampled from live tiles) → burnable fuel, 0..1. */
const OSM_FUEL: [r: number, g: number, b: number, fuel: number][] = [
  [170, 211, 223, 0], // water
  [221, 236, 236, 0], // glacier
  [173, 209, 158, 0.9], // forest
  [147, 182, 133, 0.9], // forest tree symbols
  [200, 215, 171, 1], // scrub
  [214, 217, 159, 0.9], // heath
  [205, 235, 176, 0.8], // grass, meadow
  [237, 241, 213, 0.5], // farmland
  [200, 250, 204, 0.4], // park
  [223, 252, 226, 0.4], // garden, leisure
  [137, 224, 190, 0.3], // sports pitch
  [224, 223, 223, 0.12], // residential
  [217, 208, 201, 0.02], // buildings
  [242, 218, 217, 0.05], // commercial
  [255, 214, 209, 0.05], // retail
  [235, 219, 232, 0.05], // industrial
  [254, 254, 254, 0.05], // minor roads
  [252, 214, 164, 0.05], // primary roads
  [247, 250, 190, 0.05], // secondary roads
  [249, 178, 156, 0.05], // trunk roads
  [232, 146, 162, 0.05], // motorways
  [238, 229, 220, 0.02], // bare rock
  [245, 233, 198, 0.02], // sand
];
const URBAN_FUEL = 0.05;
/** Cells at least this much water act as firebreaks, so rivers narrower than a cell still stop the fire. */
const WATER_BREAK = 0.3;

export function regionBounds([lon, lat]: LngLat): Bounds {
  const half = SPAN_KM / 2;
  const dLat = half / 110.574;
  const dLon = half / (111.32 * Math.cos((lat * Math.PI) / 180));
  return { west: lon - dLon, east: lon + dLon, south: lat - dLat, north: lat + dLat };
}

export function terrainKey([lon, lat]: LngLat) {
  return `${lon.toFixed(4)},${lat.toFixed(4)}`;
}

const worldPx = (z: number) => 256 * 2 ** z;
const lonToPx = (lon: number, z: number) => ((lon + 180) / 360) * worldPx(z);
function latToPx(lat: number, z: number) {
  const s = Math.sin((lat * Math.PI) / 180);
  return (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * worldPx(z);
}

type Mosaic = { data: Uint8ClampedArray; width: number; height: number; ox: number; oy: number };

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`Failed to load ${src}`));
    img.src = src;
  });
}

/** Stitches the web-mercator tiles covering `b` into one readable pixel buffer. */
async function loadMosaic(template: string, z: number, b: Bounds): Promise<Mosaic | null> {
  const tx0 = Math.floor(lonToPx(b.west, z) / 256);
  const tx1 = Math.floor(lonToPx(b.east, z) / 256);
  const ty0 = Math.floor(latToPx(b.north, z) / 256);
  const ty1 = Math.floor(latToPx(b.south, z) / 256);
  const canvas = document.createElement("canvas");
  canvas.width = (tx1 - tx0 + 1) * 256;
  canvas.height = (ty1 - ty0 + 1) * 256;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  try {
    const jobs: Promise<void>[] = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const url = template
          .replace("{z}", String(z))
          .replace("{x}", String(tx))
          .replace("{y}", String(ty));
        jobs.push(
          loadImage(url).then((img) => ctx.drawImage(img, (tx - tx0) * 256, (ty - ty0) * 256)),
        );
      }
    }
    await Promise.all(jobs);
    const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
    return { data, width: canvas.width, height: canvas.height, ox: tx0 * 256, oy: ty0 * 256 };
  } catch {
    return null;
  }
}

function cellLngLat(b: Bounds, i: number, j: number, w: number, h: number): LngLat {
  return [b.west + ((i + 0.5) / w) * (b.east - b.west), b.north - ((j + 0.5) / h) * (b.north - b.south)];
}

function decodeTerrarium(m: Mosaic, px: number, py: number) {
  const x = Math.min(m.width - 1, Math.max(0, px));
  const y = Math.min(m.height - 1, Math.max(0, py));
  const k = (y * m.width + x) * 4;
  return m.data[k] * 256 + m.data[k + 1] + m.data[k + 2] / 256 - 32768;
}

function sampleElevation(m: Mosaic, lon: number, lat: number) {
  const fx = lonToPx(lon, TILE_ZOOM) - m.ox - 0.5;
  const fy = latToPx(lat, TILE_ZOOM) - m.oy - 0.5;
  const x = Math.floor(fx);
  const y = Math.floor(fy);
  const ax = fx - x;
  const ay = fy - y;
  const top = decodeTerrarium(m, x, y) * (1 - ax) + decodeTerrarium(m, x + 1, y) * ax;
  const bot = decodeTerrarium(m, x, y + 1) * (1 - ax) + decodeTerrarium(m, x + 1, y + 1) * ax;
  return top * (1 - ay) + bot * ay;
}

/** Rough fuel estimate from imagery: saturated natural colours burn, grey urban surfaces less, water not at all. */
function sampleFuel(m: Mosaic, lon: number, lat: number) {
  const x = Math.min(m.width - 1, Math.max(0, Math.floor(lonToPx(lon, TILE_ZOOM) - m.ox)));
  const y = Math.min(m.height - 1, Math.max(0, Math.floor(latToPx(lat, TILE_ZOOM) - m.oy)));
  // average a 3x3 patch to smooth out cars, roofs etc.
  let r = 0, g = 0, bl = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const xx = Math.min(m.width - 1, Math.max(0, x + dx));
      const yy = Math.min(m.height - 1, Math.max(0, y + dy));
      const k = (yy * m.width + xx) * 4;
      r += m.data[k]; g += m.data[k + 1]; bl += m.data[k + 2]; n++;
    }
  }
  r /= n; g /= n; bl /= n;
  const max = Math.max(r, g, bl);
  const min = Math.min(r, g, bl);
  const brightness = (r + g + bl) / 3;
  if (bl > r + 6 && bl >= g - 4 && brightness < 110) return 0; // water
  const sat = max > 0 ? (max - min) / max : 0;
  return Math.min(1, Math.max(0.12, 0.15 + sat * 2.4 - Math.max(0, brightness - 170) / 200));
}

/** Fuel for one OSM pixel, or NaN where the colour isn't a land use (labels, unmapped land). */
function osmPixelFuel(r: number, g: number, b: number) {
  let best = Infinity;
  let fuel = NaN;
  for (const [pr, pg, pb, f] of OSM_FUEL) {
    const d = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (d < best) { best = d; fuel = f; }
  }
  if (best <= 100) return fuel;
  // neutral greys are building outlines, car parks and road casings
  const max = Math.max(r, g, b);
  if (max - Math.min(r, g, b) < 8 && max >= 190 && max <= 235) return URBAN_FUEL;
  return NaN;
}

/** OSM land cover over one cell's footprint: mean fuel, and the fractions that are mapped and water. */
function sampleLandCover(m: Mosaic, b: Bounds, i: number, j: number, w: number, h: number) {
  const lon0 = b.west + (i / w) * (b.east - b.west);
  const lon1 = b.west + ((i + 1) / w) * (b.east - b.west);
  const lat0 = b.north - (j / h) * (b.north - b.south);
  const lat1 = b.north - ((j + 1) / h) * (b.north - b.south);
  const x0 = Math.max(0, Math.floor(lonToPx(lon0, TILE_ZOOM) - m.ox));
  const x1 = Math.min(m.width, Math.max(x0 + 1, Math.round(lonToPx(lon1, TILE_ZOOM) - m.ox)));
  const y0 = Math.max(0, Math.floor(latToPx(lat0, TILE_ZOOM) - m.oy));
  const y1 = Math.min(m.height, Math.max(y0 + 1, Math.round(latToPx(lat1, TILE_ZOOM) - m.oy)));
  let n = 0, known = 0, water = 0, residential = 0, sum = 0;
  for (let y = y0; y < y1; y++) {
    for (let x = x0; x < x1; x++) {
      const k = (y * m.width + x) * 4;
      const f = osmPixelFuel(m.data[k], m.data[k + 1], m.data[k + 2]);
      n++;
      if (Number.isNaN(f)) continue;
      known++;
      sum += f;
      if (f === 0) water++;
      if (f === 0.12) residential++;
    }
  }
  return { fuel: known ? sum / known : 0, mapped: n ? known / n : 0, water: n ? water / n : 0, residential: n ? residential / n : 0 };
}

function syntheticElevation(i: number, j: number, w: number) {
  const x = i / w;
  const y = j / w;
  return (
    120 +
    90 * Math.sin(x * 7.1 + 1.3) * Math.cos(y * 5.3) +
    45 * Math.sin(x * 17 + y * 11) +
    20 * Math.cos(x * 31 - y * 23) +
    160 * y
  );
}

export async function loadTerrain(name: string, center: LngLat): Promise<Terrain> {
  const bounds = regionBounds(center);
  const w = GRID;
  const h = GRID;
  const [dem, img, osm] = await Promise.all([
    loadMosaic(TERRARIUM_URL, TILE_ZOOM, bounds),
    loadMosaic(IMAGERY_URL, TILE_ZOOM, bounds),
    loadMosaic(OSM_URL, TILE_ZOOM, bounds),
  ]);
  const elev = new Float32Array(w * h);
  const fuel = new Float32Array(w * h);
  const sea = new Uint8Array(w * h);
  const residential = osm ? new Uint8Array(w * h) : undefined;
  let minElev = Infinity;
  let maxElev = -Infinity;
  for (let j = 0; j < h; j++) {
    for (let i = 0; i < w; i++) {
      const k = j * w + i;
      const [lon, lat] = cellLngLat(bounds, i, j, w, h);
      const z = dem ? sampleElevation(dem, lon, lat) : syntheticElevation(i, j, w);
      elev[k] = z;
      sea[k] = dem && z <= 0.5 ? 1 : 0;
      const guess = img ? sampleFuel(img, lon, lat) : 0.75;
      if (sea[k]) fuel[k] = 0;
      else if (osm) {
        // mapped land cover where OSM has it, the imagery guess for the rest
        const lc = sampleLandCover(osm, bounds, i, j, w, h);
        if (residential && lc.residential >= 0.15 && lc.water < WATER_BREAK) residential[k] = 1;
        fuel[k] = lc.water >= WATER_BREAK ? 0 : lc.fuel * lc.mapped + guess * (1 - lc.mapped);
      } else fuel[k] = guess;
      minElev = Math.min(minElev, z);
      maxElev = Math.max(maxElev, z);
    }
  }
  return {
    key: terrainKey(center),
    name,
    center,
    bounds,
    w,
    h,
    cellM: (SPAN_KM * 1000) / GRID,
    elev,
    fuel,
    sea,
    residential,
    demSource: dem ? "terrarium" : "synthetic",
    fuelSource: osm ? "landcover" : img ? "imagery" : "uniform",
    minElev,
    maxElev,
  };
}

export function lngLatToCell(t: Terrain, [lon, lat]: LngLat): number {
  const { west, east, south, north } = t.bounds;
  const i = Math.floor(((lon - west) / (east - west)) * t.w);
  const j = Math.floor(((north - lat) / (north - south)) * t.h);
  if (i < 0 || j < 0 || i >= t.w || j >= t.h) return -1;
  return j * t.w + i;
}

export function cellToLngLat(t: Terrain, k: number): LngLat {
  return cellLngLat(t.bounds, k % t.w, Math.floor(k / t.w), t.w, t.h);
}
