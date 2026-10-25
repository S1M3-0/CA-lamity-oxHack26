"use client";

import "maplibre-gl/dist/maplibre-gl.css";
import type { Map as MLMap, Marker, ImageSource, GeoJSONSource, StyleSpecification } from "maplibre-gl";
import { useEffect, useRef, useState } from "react";
import { api, type MapGeoJSON } from "@/lib/api";
import { renderFrame, type Hazard, type LngLat, type Person, type Station, type Terrain, type VulnerablePlace } from "@/lib/sim";
import type { PlaceStatus } from "@/lib/sim/vulnerable";
import type { PersonStatus } from "@/lib/sim/alerts";

export type Basemap = "satellite" | "streets";
export type SimMapProps = {
  center: LngLat;
  showLaAoi: boolean;
  terrain: Terrain | null;
  hazard: Hazard | null;
  frame: Uint8Array | null;
  /** run arrival times + current time, to draw evacuation zones ahead of the hazard */
  zones: { arrival: Float32Array; now: number } | null;
  origin: LngLat | null;
  stations: Station[];
  /** fire crew positions in the current frame */
  crews: LngLat[] | null;
  /** people to warn, coloured by whether they are safe, warned or reached */
  people: { person: Person; status: PersonStatus }[];
  /** hospitals, care homes and schools in the hazard's path, coloured by evacuation urgency */
  places: { place: VulnerablePlace; status: PlaceStatus }[];
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

function corners(t: Terrain): [[number, number], [number, number], [number, number], [number, number]] {
  const { west, east, north, south } = t.bounds;
  return [[west, north], [east, north], [east, south], [west, south]];
}

export const STATION_CLASS = "size-3.5 rounded-sm border-2 border-white bg-red-600 shadow";
export const CREW_CLASS = "size-3 rounded-full border-2 border-zinc-900 bg-yellow-300 shadow";
const PERSON_COLORS: Record<PersonStatus, string> = {
  outside: "bg-zinc-500",
  safe: "bg-emerald-500",
  pending: "bg-emerald-500",
  warned: "bg-amber-400 animate-pulse",
  hit: "bg-red-600",
};
const PLACE_COLORS: Record<PlaceStatus, string> = {
  later: "bg-white text-zinc-900",
  start_now: "bg-amber-400 text-zinc-950 animate-pulse",
  late: "bg-red-600 text-white",
  reached: "bg-zinc-900 text-red-400",
};
export const PLACE_LETTER: Record<VulnerablePlace["kind"], string> = { hospital: "H", care_home: "C", school: "S" };
export const placeClass = (status: PlaceStatus) =>
  `flex size-4 items-center justify-center rounded border-[1.5px] border-red-600 text-[9px] font-black shadow ${PLACE_COLORS[status]}`;
export const personClass = (status: PersonStatus) =>
  `flex size-6 items-center justify-center rounded-full border-2 border-white text-[11px] font-bold text-zinc-950 shadow-lg ${PERSON_COLORS[status]}`;

function markerEl(className: string, text?: string) {
  const el = document.createElement("div");
  el.className = className;
  if (text) el.textContent = text;
  return el;
}

export function SimMap(props: SimMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<MLMap | null>(null);
  const loadedRef = useRef(false);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const markersRef = useRef<Marker[]>([]);
  const stationMarkersRef = useRef<Marker[]>([]);
  const crewMarkersRef = useRef<Marker[]>([]);
  const peopleMarkersRef = useRef<Marker[]>([]);
  const placeMarkersRef = useRef<Marker[]>([]);
  const fittedKeyRef = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const libRef = useRef<typeof import("maplibre-gl") | null>(null);
  const aoiDataRef = useRef<MapGeoJSON>(EMPTY_GEOJSON);
  const [aoiStatus, setAoiStatus] = useState<"loading" | "ready" | "error" | null>(null);
  const [aoiError, setAoiError] = useState<string | null>(null);

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
        map.addSource("la-aoi", { type: "geojson", data: EMPTY_GEOJSON });
        map.addLayer({
          id: "la-aoi-fill",
          type: "fill",
          source: "la-aoi",
          paint: { "fill-color": "#38bdf8", "fill-opacity": 0.16 },
        });
        map.addSource("sim", { type: "image", url: EMPTY_PNG, coordinates: [[0, 1], [1, 1], [1, 0], [0, 0]] });
        map.addLayer({ id: "sim", type: "raster", source: "sim", paint: { "raster-fade-duration": 0, "raster-resampling": "nearest" } });
        map.addLayer({
          id: "la-aoi-outline",
          type: "line",
          source: "la-aoi",
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
    const { terrain, hazard, frame, zones } = propsRef.current;
    if (!map || !loadedRef.current) return;
    const src = map.getSource("sim") as ImageSource | undefined;
    if (!src) return;
    if (!terrain) {
      src.updateImage({ url: EMPTY_PNG });
      return;
    }
    canvasRef.current ??= document.createElement("canvas");
    renderFrame(canvasRef.current, terrain, hazard, frame, zones);
    src.updateImage({ url: canvasRef.current.toDataURL(), coordinates: corners(terrain) });
  }

  function applyCamera() {
    const map = mapRef.current;
    const { terrain, center } = propsRef.current;
    if (!map) return;
    const key = terrain?.key ?? `c:${center.join(",")}`;
    if (fittedKeyRef.current === key) return;
    fittedKeyRef.current = key;
    if (terrain) {
      const { west, south, east, north } = terrain.bounds;
      map.fitBounds([[west, south], [east, north]], { padding: 24, duration: 800 });
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

  function applyStations() {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    stationMarkersRef.current.forEach((m) => m.remove());
    stationMarkersRef.current = propsRef.current.stations.map((s) => {
      const el = markerEl(STATION_CLASS);
      el.title = s.name;
      return new lib.Marker({ element: el }).setLngLat(s.lngLat).addTo(map);
    });
  }

  function applyPeople() {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    peopleMarkersRef.current.forEach((m) => m.remove());
    peopleMarkersRef.current = propsRef.current.people.map(({ person, status }) => {
      const el = markerEl(personClass(status), (person.name || "?").slice(0, 1).toUpperCase());
      el.title = person.name;
      return new lib.Marker({ element: el }).setLngLat(person.lngLat).addTo(map);
    });
  }

  function applyPlaces() {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    placeMarkersRef.current.forEach((m) => m.remove());
    placeMarkersRef.current = propsRef.current.places.map(({ place, status }) => {
      const el = markerEl(placeClass(status), PLACE_LETTER[place.kind]);
      el.title = place.name;
      return new lib.Marker({ element: el }).setLngLat(place.lngLat).addTo(map);
    });
  }

  function applyCrews() {
    const map = mapRef.current;
    const lib = libRef.current;
    if (!map || !lib) return;
    const crews = propsRef.current.crews ?? [];
    while (crewMarkersRef.current.length > crews.length) crewMarkersRef.current.pop()?.remove();
    crews.forEach((pos, c) => {
      crewMarkersRef.current[c] ??= new lib.Marker({ element: markerEl(CREW_CLASS) }).setLngLat(pos).addTo(map);
      crewMarkersRef.current[c].setLngLat(pos);
    });
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
    applyStations();
    applyCrews();
    applyPeople();
    applyPlaces();
    applyStyleToggles();
  }

  function applyAoi() {
    const map = mapRef.current;
    if (!map || !loadedRef.current) return;
    (map.getSource("la-aoi") as GeoJSONSource | undefined)?.setData(aoiDataRef.current);
  }

  useEffect(() => {
    aoiDataRef.current = EMPTY_GEOJSON;
    applyAoi();
    setAoiError(null);
    if (!props.showLaAoi) {
      setAoiStatus(null);
      return;
    }

    setAoiStatus("loading");
    const controller = new AbortController();
    api.aoi.la(controller.signal)
      .then((data) => {
        if (controller.signal.aborted) return;
        aoiDataRef.current = data;
        applyAoi();
        setAoiStatus("ready");
      })
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        setAoiError(error instanceof Error ? error.message : "Could not load LA GeoJSON");
        setAoiStatus("error");
      });
    return () => controller.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.showLaAoi]);

  useEffect(applyOverlay, [props.terrain, props.hazard, props.frame, props.zones]);
  useEffect(applyCamera, [props.terrain, props.center]);
  useEffect(applyMarkers, [props.origin, props.hazard]);
  useEffect(applyStations, [props.stations]);
  useEffect(applyCrews, [props.crews]);
  useEffect(applyPeople, [props.people]);
  useEffect(applyPlaces, [props.places]);
  useEffect(applyStyleToggles, [props.basemap, props.terrain3d]);

  return (
    <div className="relative h-full min-h-[280px] w-full overflow-hidden">
      {/* maplibre-gl.css sets position: relative on the map element, which beats Tailwind's layered
          `absolute`, so the stretching lives on a wrapper and the map fills it. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {props.showLaAoi && aoiStatus && (
        <div className="pointer-events-none absolute bottom-3 left-3 z-10 max-w-[min(32rem,calc(100%-1.5rem))] rounded-lg bg-zinc-950/85 px-3 py-1.5 text-xs text-zinc-100 shadow backdrop-blur" role="status">
          {aoiStatus === "ready" ? "LA AOI · loaded from API" : aoiStatus === "loading" ? "Loading LA AOI…" : `LA AOI: ${aoiError}`}
        </div>
      )}
      {props.badge && (
        <div className="pointer-events-none absolute left-3 top-3 z-10 flex items-center gap-2 rounded-lg bg-zinc-950/80 px-3 py-1.5 text-sm font-medium text-zinc-100 shadow backdrop-blur">
          <span className="size-2.5 rounded-full" style={{ background: props.badge.color }} />
          {props.badge.text}
        </div>
      )}
    </div>
  );
}
