"use client";

/// <reference types="google.maps" />
import { useEffect, useRef, useState } from "react";
import { api, type MapGeoJSON } from "@/lib/api";
import { GOOGLE_MAPS_API_KEY, GOOGLE_MAPS_MAP_ID } from "@/lib/config";
import { renderFrame, type Terrain } from "@/lib/sim";
import { CREW_CLASS, STATION_CLASS, type SimMapProps } from "./SimMap";

const EMPTY_GEOJSON: MapGeoJSON = { type: "FeatureCollection", features: [] };

let loading: Promise<void> | null = null;

/** Injects the Maps JavaScript API once per page. */
function loadGoogleMaps(onAuthFailure: () => void): Promise<void> {
  // Google calls this global when the key is invalid or not allowed for this site.
  (window as unknown as { gm_authFailure: () => void }).gm_authFailure = onAuthFailure;
  // The types assume `google` always exists; it doesn't until the script loads.
  if ((window as { google?: { maps?: { importLibrary?: unknown } } }).google?.maps?.importLibrary) return Promise.resolve();
  loading ??= new Promise((resolve, reject) => {
    const callback = "__terrashiftGoogleMapsReady";
    (window as unknown as Record<string, () => void>)[callback] = () => resolve();
    const script = document.createElement("script");
    script.src =
      `https://maps.googleapis.com/maps/api/js?key=${encodeURIComponent(GOOGLE_MAPS_API_KEY)}` +
      `&v=weekly&loading=async&callback=${callback}`;
    script.async = true;
    script.onerror = () => {
      loading = null;
      reject(new Error("Could not load Google Maps"));
    };
    document.head.append(script);
  });
  return loading;
}

type CanvasOverlay = google.maps.OverlayView & { setTerrain(t: Terrain | null): void; canvas: HTMLCanvasElement };

/** Stretches a canvas over the simulation bounds. Defined lazily because OverlayView only exists once the API has loaded. */
function createCanvasOverlay(): CanvasOverlay {
  class Overlay extends google.maps.OverlayView {
    canvas = document.createElement("canvas");
    private bounds: google.maps.LatLngBounds | null = null;

    constructor() {
      super();
      Object.assign(this.canvas.style, { position: "absolute", imageRendering: "pixelated", pointerEvents: "none" });
    }
    setTerrain(t: Terrain | null) {
      this.bounds = t ? new google.maps.LatLngBounds({ lat: t.bounds.south, lng: t.bounds.west }, { lat: t.bounds.north, lng: t.bounds.east }) : null;
      this.draw();
    }
    onAdd() {
      this.getPanes()?.overlayLayer.appendChild(this.canvas);
    }
    draw() {
      const projection = this.getProjection();
      if (!projection || !this.bounds) {
        this.canvas.style.display = "none";
        return;
      }
      const sw = projection.fromLatLngToDivPixel(this.bounds.getSouthWest());
      const ne = projection.fromLatLngToDivPixel(this.bounds.getNorthEast());
      if (!sw || !ne) return;
      Object.assign(this.canvas.style, {
        display: "block",
        left: `${sw.x}px`,
        top: `${ne.y}px`,
        width: `${ne.x - sw.x}px`,
        height: `${sw.y - ne.y}px`,
      });
    }
    onRemove() {
      this.canvas.remove();
    }
  }
  return new Overlay();
}

function dot(className: string, title?: string) {
  const el = document.createElement("div");
  el.className = className;
  if (title) el.title = title;
  return el;
}

/** Same behaviour as SimMap, drawn on Google Maps instead of MapLibre. */
export function GoogleSimMap(props: SimMapProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const mapRef = useRef<google.maps.Map | null>(null);
  const overlayRef = useRef<CanvasOverlay | null>(null);
  const markerRef = useRef<google.maps.marker.AdvancedMarkerElement | null>(null);
  const markerLibRef = useRef<google.maps.MarkerLibrary | null>(null);
  const stationMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const crewMarkersRef = useRef<google.maps.marker.AdvancedMarkerElement[]>([]);
  const fittedKeyRef = useRef<string | null>(null);
  const propsRef = useRef(props);
  propsRef.current = props;
  const aoiDataRef = useRef<MapGeoJSON>(EMPTY_GEOJSON);
  // After rejecting a key, Google breaks its own map objects and any further call throws.
  const authFailedRef = useRef(false);
  const liveMap = () => (authFailedRef.current ? null : mapRef.current);
  const [ready, setReady] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [aoiStatus, setAoiStatus] = useState<"loading" | "ready" | "error" | null>(null);
  const [aoiError, setAoiError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    loadGoogleMaps(() => {
      authFailedRef.current = true;
      setLoadError("Google Maps rejected the API key. Check it is valid and allowed for this site.");
    })
      .then(async () => {
        const [{ Map }, markerLib] = await Promise.all([
          google.maps.importLibrary("maps") as Promise<google.maps.MapsLibrary>,
          google.maps.importLibrary("marker") as Promise<google.maps.MarkerLibrary>,
        ]);
        if (cancelled || !containerRef.current) return;
        const [lng, lat] = propsRef.current.center;
        const map = new Map(containerRef.current, {
          center: { lat, lng },
          zoom: 12,
          mapId: GOOGLE_MAPS_MAP_ID,
          mapTypeId: "hybrid",
          disableDefaultUI: true,
          zoomControl: true,
          scaleControl: true,
          rotateControl: true,
          clickableIcons: false,
        });
        mapRef.current = map;
        markerLibRef.current = markerLib;
        overlayRef.current = createCanvasOverlay();
        overlayRef.current.setMap(map);
        map.data.setStyle({ fillColor: "#38bdf8", fillOpacity: 0.16, strokeColor: "#38bdf8", strokeWeight: 2.5, clickable: false });
        map.addListener("click", (e: google.maps.MapMouseEvent) => {
          if (e.latLng) propsRef.current.onMapClick?.([e.latLng.lng(), e.latLng.lat()]);
        });
        setReady(true);
      })
      .catch((e: unknown) => !cancelled && setLoadError(e instanceof Error ? e.message : "Could not load Google Maps"));
    return () => {
      cancelled = true;
      if (authFailedRef.current) return;
      overlayRef.current?.setMap(null);
      for (const m of [markerRef.current, ...stationMarkersRef.current, ...crewMarkersRef.current]) if (m) m.map = null;
      mapRef.current = null;
    };
  }, []);

  function applyOverlay() {
    const overlay = overlayRef.current;
    if (!liveMap() || !overlay) return;
    const { terrain, hazard, frame } = propsRef.current;
    overlay.setTerrain(terrain);
    if (terrain) renderFrame(overlay.canvas, terrain, hazard, frame);
  }

  function applyCamera() {
    const map = liveMap();
    if (!map) return;
    const { terrain, center } = propsRef.current;
    const key = terrain?.key ?? `c:${center.join(",")}`;
    if (fittedKeyRef.current === key) return;
    fittedKeyRef.current = key;
    if (terrain) {
      const { west, south, east, north } = terrain.bounds;
      map.fitBounds({ west, south, east, north }, 24);
    } else {
      map.panTo({ lat: center[1], lng: center[0] });
      map.setZoom(12);
    }
  }

  function applyMarker() {
    const map = liveMap();
    const lib = markerLibRef.current;
    if (!map || !lib) return;
    if (markerRef.current) markerRef.current.map = null;
    markerRef.current = null;
    const { origin, hazard } = propsRef.current;
    if (!origin) return;
    markerRef.current = new lib.AdvancedMarkerElement({
      map,
      position: { lat: origin[1], lng: origin[0] },
      content: dot(`size-4 rounded-full border-2 border-white shadow-lg ${hazard === "flood" ? "bg-sky-500" : "bg-orange-500"}`),
      gmpClickable: false,
    });
  }

  function applyStations() {
    const map = liveMap();
    const lib = markerLibRef.current;
    if (!map || !lib) return;
    stationMarkersRef.current.forEach((m) => (m.map = null));
    stationMarkersRef.current = propsRef.current.stations.map(
      (s) => new lib.AdvancedMarkerElement({ map, position: { lat: s.lngLat[1], lng: s.lngLat[0] }, content: dot(STATION_CLASS, s.name), title: s.name }),
    );
  }

  function applyCrews() {
    const map = liveMap();
    const lib = markerLibRef.current;
    if (!map || !lib) return;
    const crews = propsRef.current.crews ?? [];
    while (crewMarkersRef.current.length > crews.length) {
      const m = crewMarkersRef.current.pop();
      if (m) m.map = null;
    }
    crews.forEach(([lng, lat], c) => {
      crewMarkersRef.current[c] ??= new lib.AdvancedMarkerElement({ map, content: dot(CREW_CLASS), gmpClickable: false });
      crewMarkersRef.current[c].position = { lat, lng };
    });
  }

  function applyStyleToggles() {
    const map = liveMap();
    if (!map) return;
    const { basemap, terrain3d } = propsRef.current;
    map.setMapTypeId(basemap === "satellite" ? "hybrid" : "roadmap");
    map.setTilt(terrain3d ? 45 : 0);
  }

  function applyAoi() {
    const map = liveMap();
    if (!map) return;
    const old: google.maps.Data.Feature[] = [];
    map.data.forEach((f) => old.push(f));
    old.forEach((f) => map.data.remove(f));
    map.data.addGeoJson(aoiDataRef.current);
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
  }, [props.showLaAoi, ready]);

  /* eslint-disable react-hooks/exhaustive-deps */
  useEffect(applyOverlay, [ready, props.terrain, props.hazard, props.frame]);
  useEffect(applyCamera, [ready, props.terrain, props.center]);
  useEffect(applyMarker, [ready, props.origin, props.hazard]);
  useEffect(applyStations, [ready, props.stations]);
  useEffect(applyCrews, [ready, props.crews]);
  useEffect(applyStyleToggles, [ready, props.basemap, props.terrain3d]);
  /* eslint-enable react-hooks/exhaustive-deps */

  return (
    <div className="relative h-full min-h-[280px] w-full overflow-hidden">
      {/* Google Maps sets its own position on the container, so the stretching lives on a wrapper. */}
      <div className="absolute inset-0">
        <div ref={containerRef} className="h-full w-full" />
      </div>
      {loadError && (
        <div className="absolute inset-0 z-20 flex items-center justify-center bg-zinc-950 p-6 text-center text-sm text-zinc-100" role="alert">
          {loadError}
        </div>
      )}
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
