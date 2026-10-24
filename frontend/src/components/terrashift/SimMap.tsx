"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, Marker, ImageSource, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef } from "react";
import type { GridMetadata, Hazard, LngLat, MapGeoJSON } from "@/lib/api";

export type Basemap = "satellite" | "streets";
type Props = {
  center: LngLat;
  cityAoi: MapGeoJSON | null;
  grid: GridMetadata | null;
  hazard: Hazard | null;
  frame: Uint8Array | null;
  origin: LngLat | null;
  basemap: Basemap;
  terrain3d: boolean;
  onMapClick?: (lngLat: LngLat) => void;
  badge?: { text: string; color: string } | null;
};

const STYLE: StyleSpecification = {
  version: 8,
  sources: {
    satellite: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "Imagery © Esri, Maxar, Earthstar Geographics",
    },
    roads: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
    },
    places: {
      type: "raster",
      tiles: ["https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"],
      tileSize: 256,
      maxzoom: 19,
    },
    streets: {
      type: "raster",
      tiles: ["https://tile.openstreetmap.org/{z}/{x}/{y}.png"],
      tileSize: 256,
      maxzoom: 19,
      attribution: "© OpenStreetMap contributors",
    },
    dem: {
      type: "raster-dem",
      tiles: ["https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png"],
      encoding: "terrarium",
      tileSize: 256,
      maxzoom: 14,
      attribution: "Elevation: Mapzen Terrain Tiles",
    },
  },
  layers: [
    { id: "satellite", type: "raster", source: "satellite" },
    { id: "streets", type: "raster", source: "streets", layout: { visibility: "none" } },
    {
      id: "hillshade",
      type: "hillshade",
      source: "dem",
      paint: { "hillshade-exaggeration": 0.35, "hillshade-shadow-color": "#1a1a1a" },
    },
    { id: "roads", type: "raster", source: "roads", paint: { "raster-opacity": 0.7 } },
    { id: "places", type: "raster", source: "places" },
  ],
};

const EMPTY_PNG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";
const EMPTY_GEOJSON: MapGeoJSON = { type: "FeatureCollection", features: [] };

function renderFrame(canvas: HTMLCanvasElement, grid: GridMetadata, hazard: Hazard | null, frame: Uint8Array | null) {
  canvas.width = grid.width;
  canvas.height = grid.height;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const image = ctx.createImageData(grid.width, grid.height);
  if (frame && hazard) {
    for (let k = 0; k < frame.length; k++) {
      const v = frame[k];
      if (!v) continue;
      const o = k * 4;
      if (hazard === "wildfire") {
        if (v === 255) { image.data[o] = 255; image.data[o + 1] = 120 + ((k * 7) % 60); image.data[o + 2] = 20; image.data[o + 3] = 240; }
        else { image.data[o] = 55; image.data[o + 1] = 18; image.data[o + 2] = 12; image.data[o + 3] = 175; }
      } else {
        const a = (v - 40) / 215;
        image.data[o] = 90 - 80 * a; image.data[o + 1] = 190 - 120 * a; image.data[o + 2] = 255 - 40 * a; image.data[o + 3] = 120 + 120 * a;
      }
    }
  }
  ctx.putImageData(image, 0, 0);
}

function markerEl(className: string, text?: string) {
  const el = document.createElement("div");
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

export function SimMap(props: Props) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loadedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const fittedKeyRef = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);

  useEffect(() => {
    let cancelled = false;
    let ro: ResizeObserver | null = null;
    (async () => {
      const lib = await import("maplibre-gl");
      if (cancelled || !containerRef.current) return;
      libRef.current = lib;
      const map = new lib.Map({
        container: containerRef.current,
        style: STYLE,
        center: propsRef.current.center,
        zoom: 11.5,
        attributionControl: { compact: true },
        maxPitch: 75,
      });
      mapRef.current = map;
      map.addControl(new lib.NavigationControl({ visualizePitch: true }), "top-right");
      map.addControl(new lib.ScaleControl({ unit: "metric" }), "bottom-left");
      map.on("load", () => {
        map.addSource("city-aoi", { type: "geojson", data: EMPTY_GEOJSON });
        map.addLayer({
          id: "city-aoi-fill",
          type: "fill",
          source: "city-aoi",
          paint: { "fill-color": "#38bdf8", "fill-opacity": 0.16 },
        });
        map.addSource("sim", { type: "image", url: EMPTY_PNG, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
        map.addLayer({ id: "sim", type: "raster", source: "sim", paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } });
        map.addSource("bounds", { type: "geojson", data: { type: "FeatureCollection", features: [] } });
        map.addLayer({
          id: "bounds",
          type: "line",
          source: "bounds",
          paint: { "line-color": "#fafafa", "line-width": 1.5, "line-dasharray": [3, 2], "line-opacity": 0.8 },
        });
        map.addLayer({
          id: "city-aoi-outline",
          type: "line",
          source: "city-aoi",
          paint: { "line-color": "#38bdf8", "line-width": 2.5 },
        });
        loadedRef.current = true;
        applyAll();
      });
      map.on("click", (e) => propsRef.current.onMapClick?.([e.lngLat.lng, e.lngLat.lat]));
      ro = new ResizeObserver(() => map.resize());
      ro.observe(containerRef.current);
    })();
    return () => {
      cancelled = true;
      ro?.disconnect();
      mapRef.current?.remove();
      mapRef.current = null;
      loadedRef.current = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function applyOverlay() {
    const map = mapRef.current;
    const { grid, hazard, frame } = propsRef.current;
    if (!map || !loadedRef.current) return;
    const src = map.getSource("sim") as ImageSource | undefined;
    const bounds = map.getSource("bounds") as GeoJSONSource | undefined;
    if (!src || !bounds) return;
    if (!grid) {
      src.updateImage({ url: EMPTY_PNG });
      bounds.setData({ type: "FeatureCollection", features: [] });
      return;
    }
    canvasRef.current ??= document.createElement("canvas");
    renderFrame(canvasRef.current, grid, hazard, frame);
    src.updateImage({ url: canvasRef.current.toDataURL(), coordinates: grid.displayCorners });
    const c = grid.displayCorners;
    bounds.setData({
      type: "Feature",
      properties: {},
      geometry: { type: "LineString", coordinates: [...c, c[0]] },
    });
  }

  function applyCamera() {
    const map = mapRef.current;
    const { grid, center } = propsRef.current;
    if (!map) return;
    const key = grid?.id ?? `c:${center.join(",")}`;
    if (fittedKeyRef.current === key) return;
    fittedKeyRef.current = key;
    if (grid) {
      const xs = grid.displayCorners.map((c) => c[0]);
      const ys = grid.displayCorners.map((c) => c[1]);
      map.fitBounds([[Math.min(...xs), Math.min(...ys)], [Math.max(...xs), Math.max(...ys)]], { padding: 24, duration: 800 });
    } else {
      map.flyTo({ center, zoom: 11.5, duration: 800 });
    }
  }

  function applyMarkers() {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    markersRef.current.forEach((m) => m.remove());
    markersRef.current = [];
    const { origin, hazard } = propsRef.current;
    if (origin) {
      const cls =
        hazard === "flood"
          ? "size-4 rounded-full border-2 border-white bg-sky-500 shadow-lg"
          : "size-4 rounded-full border-2 border-white bg-orange-500 shadow-lg";
      markersRef.current.push(new lib.Marker({ element: markerEl(cls) }).setLngLat(origin).addTo(map));
    }
  }

  function applyStyleToggles() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    const { basemap, terrain3d } = propsRef.current;
    const sat = basemap === "satellite" ? "visible" : "none";
    map.setLayoutProperty("satellite", "visibility", sat);
    map.setLayoutProperty("roads", "visibility", sat);
    map.setLayoutProperty("places", "visibility", sat);
    map.setLayoutProperty("streets", "visibility", basemap === "streets" ? "visible" : "none");
    if (terrain3d) {
      map.setTerrain({ source: "dem", exaggeration: 1.4 });
      if (map.getPitch() < 30) map.easeTo({ pitch: 55, duration: 600 });
    } else {
      map.setTerrain(null);
      if (map.getPitch() > 0) map.easeTo({ pitch: 0, duration: 600 });
    }
  }

  function applyAll() {
    applyCamera();
    applyOverlay();
    applyAoi();
    applyMarkers();
    applyStyleToggles();
  }

  function applyAoi() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource("city-aoi") as GeoJSONSource | undefined)?.setData(propsRef.current.cityAoi ?? EMPTY_GEOJSON);
  }

  useEffect(applyAoi, [props.cityAoi]);
  useEffect(applyOverlay, [props.grid, props.hazard, props.frame]);
  useEffect(applyCamera, [props.grid, props.center]);
  useEffect(applyMarkers, [props.origin, props.hazard]);
  useEffect(applyStyleToggles, [props.basemap, props.terrain3d]);

  return (
    <div className="relative h-full min-h-[280px] w-full overflow-hidden">
      <div ref={containerRef} className="absolute inset-0" />
      {props.badge && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg bg-zinc-950/80 px-3 py-1.5 text-sm font-medium text-zinc-100 shadow backdrop-blur">
          <span className="size-2.5 rounded-full" style={{ background: props.badge.color }} />
          {props.badge.text}
        </div>
      )}
    </div>
  );
}
