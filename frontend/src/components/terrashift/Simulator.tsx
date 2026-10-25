"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  DEFAULT_PARAMS,
  FRAMES_PER_HOUR,
  HAZARDS,
  HOURS,
  PARAM_META,
  ZONES,
  compass,
  describeParams,
  loadStations,
  lngLatToCell,
  loadTerrain,
  regionBounds,
  runSeed,
  runSimulation,
  terrainKey,
  zoneOf,
  type Hazard,
  type LngLat,
  type Params,
  type Person,
  type SimResult,
  type Station,
  type Terrain,
} from "@/lib/sim";
import { APP_NAME, APP_TAGLINE, GOOGLE_MAPS_API_KEY } from "@/lib/config";
import { planAlerts, personStatus } from "@/lib/sim/alerts";
import { fetchLiveWeather, type LiveWeather } from "@/lib/sim/weather";
import { EVACUATION_HOURS as EVAC_H, KIND_LABEL, placeStatus, placesAtRisk, vulnerablePlaces, type PlaceAtRisk } from "@/lib/sim/vulnerable";
import { DispatchRadio } from "./DispatchRadio";
import { AlertFeed, PeoplePanel, useAlertSender, type PhoneMessage } from "./EvacuationAlerts";
import { GoogleSimMap } from "./GoogleSimMap";
import { Icon, type IconName } from "./Icon";
import { InfoTip } from "./InfoTip";
import { CREW_CLASS, PLACE_LETTER, STATION_CLASS, SimMap, personClass, placeClass, type Basemap } from "./SimMap";

// Google Maps when a key is configured, otherwise MapLibre + Esri imagery.
const MapView = GOOGLE_MAPS_API_KEY ? GoogleSimMap : SimMap;

type Place = { name: string; center: LngLat };

type Run = {
  id: number;
  seed: number;
  hazard: Hazard;
  place: Place;
  terrain: Terrain;
  params: Params;
  origin: LngLat | null;
  stations: Station[];
  result: SimResult;
};

const PRESETS: Place[] = [
  { name: "Fort McMurray", center: [-111.38, 56.726] },
  { name: "Oxford", center: [-1.255, 51.745] },
  { name: "Brisbane", center: [153.025, -27.47] },
  { name: "Los Angeles", center: [-118.2437, 34.0522] },
];

const HAZARD_ICON: Record<Hazard, IconName> = { wildfire: "flame", flood: "drop" };
const RUN_COLORS = ["#f97316", "#38bdf8", "#a3e635", "#e879f9", "#facc15", "#f87171"];
const SPEEDS = [0.5, 1, 2, 4];
const MAX_RUNS = 6;

function formatT(hours: number) {
  const f = Math.round(hours * FRAMES_PER_HOUR);
  const h = Math.floor(f / FRAMES_PER_HOUR);
  const m = (f % FRAMES_PER_HOUR) * (60 / FRAMES_PER_HOUR);
  return `T+${h}h ${String(m).padStart(2, "0")}m`;
}

export function Simulator() {
  const [place, setPlace] = useState<Place>(PRESETS[0]);
  const [terrains, setTerrains] = useState<Record<string, Terrain>>({});
  const [terrainError, setTerrainError] = useState<string | null>(null);
  // Fire stations per terrain key; null = OpenStreetMap lookup failed.
  const [stationsByKey, setStationsByKey] = useState<Record<string, Station[] | null>>({});
  const [hazard, setHazard] = useState<Hazard>("wildfire");
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [origin, setOrigin] = useState<LngLat | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [computing, setComputing] = useState(false);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [terrain3d, setTerrain3d] = useState(false);
  const [showZones, setShowZones] = useState(true);
  // Today's real weather for the current place, once fetched.
  const [weather, setWeather] = useState<{ key: string; w: LiveWeather } | "loading" | "error" | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [placingPerson, setPlacingPerson] = useState(false);
  const [callToo, setCallToo] = useState(false);
  const nextId = useRef(1);
  const nextPersonId = useRef(1);

  const key = terrainKey(place.center);
  const terrain = terrains[key] ?? null;
  const stations = stationsByKey[key] ?? [];
  const activeRun = runs.find((r) => r.id === activeId) ?? null;
  const viewRun = activeRun && activeRun.terrain.key === key ? activeRun : null;
  const frameIdx = Math.round(t * FRAMES_PER_HOUR);
  const meta = HAZARDS[hazard];
  const missingOrigin = meta.originLabel !== null && origin === null;

  useEffect(() => {
    if (terrains[key]) return;
    let cancelled = false;
    setTerrainError(null);
    loadTerrain(place.name, place.center)
      .then((tr) => !cancelled && setTerrains((old) => ({ ...old, [tr.key]: tr })))
      .catch((e) => !cancelled && setTerrainError(e instanceof Error ? e.message : "Failed to load terrain"));
    return () => {
      cancelled = true;
    };
  }, [key, place, terrains]);

  useEffect(() => {
    if (key in stationsByKey) return;
    let cancelled = false;
    loadStations(key, regionBounds(place.center))
      .then((found) => !cancelled && setStationsByKey((old) => ({ ...old, [key]: found })))
      .catch(() => !cancelled && setStationsByKey((old) => ({ ...old, [key]: null })));
    return () => {
      cancelled = true;
    };
  }, [key, place, stationsByKey]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      // rAF timestamps can predate `last` after a long task (e.g. a simulation run); never go backwards.
      const dt = Math.max(0, now - last) / 1000;
      last = now;
      setT((prev) => Math.min(HOURS, prev + dt * speed));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);

  useEffect(() => {
    if (playing && t >= HOURS) setPlaying(false);
  }, [playing, t]);

  async function applyLiveWeather() {
    setWeather("loading");
    try {
      const w = await fetchLiveWeather(place.center);
      const snap = (k: keyof Params, v: number) => {
        const m = PARAM_META[k];
        return Math.min(m.max, Math.max(m.min, Math.round(v / m.step) * m.step));
      };
      setParams((p) => ({
        ...p,
        windSpeed: snap("windSpeed", w.windSpeed),
        windDir: snap("windDir", w.windDir) % 360,
        humidity: snap("humidity", w.humidity),
        rainfall: snap("rainfall", w.rainfall),
        saturation: snap("saturation", w.saturation),
      }));
      setWeather({ key, w });
    } catch {
      setWeather("error");
    }
  }

  function changePlace(p: Place) {
    if (terrainKey(p.center) !== key) setOrigin(null);
    setPlace(p);
  }

  function generate() {
    if (!terrain || missingOrigin) return;
    const o = meta.originLabel ? origin : null;
    const seed = runSeed(hazard, terrain, params, o, stations);
    const existing = runs.find((r) => r.seed === seed);
    if (existing) {
      // same conditions → same (reproducible) simulation; just replay it
      setActiveId(existing.id);
      setT(0);
      setPlaying(true);
      return;
    }
    setComputing(true);
    setPlaying(false);
    setTimeout(() => {
      const result = runSimulation(hazard, terrain, params, o, stations);
      const run: Run = { id: nextId.current++, seed, hazard, place, terrain, params, origin: o, stations, result };
      setRuns((old) => [run, ...old].slice(0, MAX_RUNS));
      setActiveId(run.id);
      setT(0);
      setPlaying(true);
      setComputing(false);
    }, 30);
  }

  function viewScenario(r: Run) {
    setActiveId(r.id);
    if (r.terrain.key !== key) setPlace(r.place);
  }

  function loadSettings(r: Run) {
    setHazard(r.hazard);
    setParams(r.params);
    setPlace(r.place);
    setOrigin(r.origin);
  }

  function togglePlay() {
    if (!viewRun) return;
    if (t >= HOURS) setT(0);
    setPlaying((p) => !p);
  }

  const stepBy = (h: number) => {
    setPlaying(false);
    setT((v) => Math.max(0, Math.min(HOURS, Math.round((v + h) * FRAMES_PER_HOUR) / FRAMES_PER_HOUR)));
  };

  const area = viewRun ? viewRun.result.area[frameIdx] : 0;

  // Evacuation zones ahead of the hazard, recomputed per frame (every 15 simulated minutes).
  const zones = useMemo(
    () => (viewRun && showZones ? { arrival: viewRun.result.arrival, now: frameIdx / FRAMES_PER_HOUR } : null),
    [viewRun, showZones, frameIdx],
  );
  const zoneKm2 = useMemo(() => {
    if (!zones || !viewRun) return null;
    const z = zoneOf(zones.arrival, viewRun.result.frames[frameIdx], zones.now, viewRun.terrain.w);
    const counts = [0, 0, 0];
    for (const v of z) if (v >= 0 && v <= 2) counts[v]++;
    const cellKm2 = (viewRun.terrain.cellM * viewRun.terrain.cellM) / 1e6;
    return counts.map((n) => n * cellKm2);
  }, [zones, viewRun, frameIdx]);

  // Evacuation alerts for the people pinned on the map, against the run being shown.
  const alertPlan = useMemo(() => (viewRun ? planAlerts({ ...viewRun, placeName: viewRun.place.name }, people) : []), [viewRun, people]);
  const fired = alertPlan.filter((a) => a.alertAtH !== null && t >= a.alertAtH);
  const sendState = useAlertSender(viewRun?.id ?? null, fired, playing, callToo);
  const statusKey = alertPlan
    .map((a) => `${a.person.id}:${personStatus(a, t, !!terrain && lngLatToCell(terrain, a.person.lngLat) >= 0)}`)
    .join(",");
  const mapPeople = useMemo(
    () =>
      people.map((person) => {
        const a = alertPlan.find((x) => x.person.id === person.id);
        const inside = !!terrain && lngLatToCell(terrain, person.lngLat) >= 0;
        return { person, status: a ? personStatus(a, t, inside) : inside ? ("safe" as const) : ("outside" as const) };
      }),
    // statusKey changes only when someone's colour does, so markers aren't rebuilt every frame
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [people, terrain, statusKey],
  );
  const phoneMessages: PhoneMessage[] = [...fired]
    .sort((a, b) => (a.alertAtH ?? 0) - (b.alertAtH ?? 0))
    .map((a) => ({
      key: `${viewRun?.id}:${a.person.id}`,
      name: a.person.name,
      at: formatT(a.alertAtH ?? 0),
      text: a.text ?? "",
      phone: a.person.phone,
      state: sendState[`${viewRun?.id}:${a.person.id}`],
    }));

  // Hospitals, care homes and schools in the hazard's path, most urgent first.
  const atRisk = useMemo(
    () => (viewRun ? placesAtRisk(viewRun.terrain, viewRun.result, vulnerablePlaces(viewRun.terrain.key)) : []),
    [viewRun],
  );
  const placeKey = atRisk.map((p) => placeStatus(p, t)).join(",");
  const mapPlaces = useMemo(
    () => atRisk.map((p) => ({ place: p.place, status: placeStatus(p, t) })),
    // placeKey changes only when a marker's colour does
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [atRisk, placeKey],
  );

  function onMapClick(ll: LngLat) {
    if (placingPerson) {
      const id = nextPersonId.current++;
      setPeople((old) => [...old, { id, name: `Person ${id}`, phone: "", lngLat: ll }]);
      setPlacingPerson(false);
    } else if (meta.originLabel) {
      setOrigin(ll);
    }
  }

  const pendingPlaces = atRisk.filter((p) => placeStatus(p, t) !== "reached").length;
  const crewsOut = viewRun?.result.crews?.[frameIdx]?.length ?? 0;
  const prevArea = viewRun ? viewRun.result.area[Math.max(0, frameIdx - 1)] : 0;
  const incidentState = !viewRun
    ? null
    : viewRun.hazard === "wildfire"
      ? viewRun.result.frames[frameIdx].includes(255)
        ? "Burning"
        : area > 0
          ? "Contained"
          : "Starting"
      : area > prevArea
        ? "Rising"
        : area > 0
          ? "Holding"
          : "Starting";

  return (
    <div className="flex min-h-screen flex-col gap-3 bg-[#07080a] p-3 text-zinc-100 lg:h-screen lg:overflow-hidden">
      {/* ---- Top bar ---- */}
      <header className="flex flex-wrap items-center gap-x-6 gap-y-2 px-1">
        <div className="flex items-center gap-2.5">
          <span className="flex size-8 items-center justify-center rounded-lg bg-brand text-zinc-950">
            <Icon name="flame" className="size-4.5" />
          </span>
          <div className="leading-tight">
            <h1 className="text-[15px] font-semibold tracking-tight">{APP_NAME}</h1>
            <p className="text-xs text-zinc-500">{APP_TAGLINE}</p>
          </div>
        </div>
        <div className="ml-auto flex flex-wrap items-center gap-2 text-xs">
          <div className="inline-flex rounded-lg border border-white/10 p-0.5">
            {(["satellite", "streets"] as Basemap[]).map((b) => (
              <button
                key={b}
                onClick={() => setBasemap(b)}
                className={`rounded-md px-2.5 py-1 capitalize ${basemap === b ? "bg-white/10 text-white" : "text-zinc-400 hover:text-zinc-200"}`}
              >
                {b}
              </button>
            ))}
          </div>
          <Toggle on={terrain3d} onChange={setTerrain3d} label="3D terrain" />
          <Toggle on={showZones} onChange={setShowZones} label="Evacuation zones" />
          <span
            className={`flex items-center gap-2 rounded-lg border px-2.5 py-1.5 font-mono ${
              viewRun ? "border-brand/40 bg-brand/10 text-brand" : "border-white/10 text-zinc-500"
            }`}
          >
            <span className={`size-1.5 rounded-full ${viewRun ? "animate-pulse bg-brand" : "bg-zinc-600"}`} />
            {viewRun ? `${HAZARDS[viewRun.hazard].label.toUpperCase()} · ${viewRun.place.name.toUpperCase()} · ${formatT(t)}` : "STANDBY"}
          </span>
        </div>
      </header>

      <div className="grid min-h-0 flex-1 gap-3 lg:grid-cols-[320px_minmax(0,1fr)_340px]">
        {/* ---- Scenario ---- */}
        <aside className={`${panel} flex flex-col gap-5 p-4 lg:overflow-y-auto`}>
          <section className="flex flex-col gap-2">
            <Label>Location</Label>
            <div className="grid grid-cols-2 gap-1">
              {PRESETS.map((p) => (
                <button key={p.name} onClick={() => changePlace(p)} className={choice(place.name === p.name)}>
                  {p.name}
                </button>
              ))}
            </div>
            <p className="text-[11px] leading-relaxed text-zinc-500">
              {terrainError
                ? `Terrain failed to load: ${terrainError}`
                : terrain
                  ? `12 × 12 km · ${Math.round(terrain.cellM)} m cells · ${Math.round(terrain.minElev)}–${Math.round(terrain.maxElev)} m elevation`
                  : "Loading elevation and imagery…"}
              {terrain?.demSource === "synthetic" && " · synthetic terrain"}
              {stationsByKey[key] === null
                ? " · stations unavailable"
                : key in stationsByKey && ` · ${stations.length} fire station${stations.length === 1 ? "" : "s"}`}
            </p>
          </section>

          <section className="flex flex-col gap-2">
            <Label>Hazard</Label>
            <div className="grid grid-cols-2 gap-1">
              {(Object.keys(HAZARDS) as Hazard[]).map((h) => (
                <button key={h} onClick={() => setHazard(h)} className={`${choice(hazard === h)} inline-flex items-center justify-center gap-1.5`}>
                  <Icon name={HAZARD_ICON[h]} className="size-3.5" />
                  {HAZARDS[h].label}
                </button>
              ))}
            </div>
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between">
              <Label>
                Conditions
                <InfoTip label="conditions">
                  {hazard === "wildfire" ? (
                    <>
                      <span><b className="text-zinc-100">Wind:</b> the fire runs with the wind; the direction is where the wind comes from.</span>
                      <span><b className="text-zinc-100">Humidity:</b> damper air slows the fire. Above about 80% it barely spreads. Fires also run faster uphill.</span>
                      <span><b className="text-zinc-100">Fire crews:</b> engines leave the real stations nearest the fire an hour after it starts, put out what they can reach, and go back to refill. Set to 0 to let it burn.</span>
                    </>
                  ) : (
                    <>
                      <span><b className="text-zinc-100">Rainfall:</b> how hard it rains everywhere. Some soaks in; the rest runs downhill and pools.</span>
                      <span><b className="text-zinc-100">Soil saturation:</b> how wet the ground already is. Wetter ground soaks up less.</span>
                    </>
                  )}
                </InfoTip>
              </Label>
              <button
                onClick={applyLiveWeather}
                disabled={weather === "loading"}
                className="text-[11px] font-medium text-brand hover:text-brand-hover disabled:opacity-50"
              >
                {weather === "loading" ? "Fetching…" : "Use live weather"}
              </button>
            </div>
            {weather === "error" && <p className="text-[11px] text-red-400">Weather service unreachable; values unchanged.</p>}
            {weather && typeof weather === "object" && weather.key === key && (
              <p className="rounded-lg bg-white/[0.03] px-2.5 py-1.5 font-mono text-[11px] leading-relaxed text-zinc-400">
                LIVE {weather.w.time.slice(11)} · {Math.round(weather.w.windSpeed)} km/h {compass(weather.w.windDir)} · {Math.round(weather.w.humidity)}% RH ·{" "}
                {weather.w.rainfall.toFixed(1)} mm/h · soil {Math.round(weather.w.saturation)}% · Open-Meteo
              </p>
            )}
            {meta.params.map((k) => {
              const pm = PARAM_META[k];
              return (
                <label key={k} className="flex flex-col gap-1">
                  <span className="flex items-center justify-between text-[13px]">
                    <span className="text-zinc-300">{pm.label}</span>
                    <span className="flex items-center gap-1 font-mono text-xs text-zinc-100">
                      {k === "windDir" && (
                        <svg viewBox="0 0 24 24" className="size-3.5 text-brand" style={{ transform: `rotate(${params.windDir + 180}deg)` }} aria-hidden="true">
                          <path d="M12 3 18 15h-4.5v6h-3v-6H6z" fill="currentColor" />
                        </svg>
                      )}
                      {params[k]}
                      {pm.unit}
                      {k === "windDir" && ` ${compass(params.windDir)}`}
                    </span>
                  </span>
                  <input
                    type="range"
                    min={pm.min}
                    max={pm.max}
                    step={pm.step}
                    value={params[k]}
                    onChange={(e) => setParams((p) => ({ ...p, [k]: Number(e.target.value) }))}
                    className="h-1 w-full accent-brand"
                  />
                </label>
              );
            })}
          </section>

          {meta.originLabel && (
            <section className="flex flex-col gap-2">
              <Label>
                {meta.originLabel}
                <InfoTip label={meta.originLabel}>
                  <span>
                    Click the map to place it. <b className="text-zinc-100">That point is exactly where the {hazard === "wildfire" ? "fire starts" : "river bursts its banks"}</b>.
                    Click elsewhere to move it.
                  </span>
                </InfoTip>
              </Label>
              <div
                className={`flex items-center justify-between gap-2 rounded-lg border px-3 py-2 text-[13px] ${
                  origin ? "border-white/10 bg-white/[0.03]" : "border-dashed border-brand/50 text-brand"
                }`}
              >
                <span className="flex items-center gap-2">
                  <Icon name="target" className="size-4" />
                  {origin ? (
                    <span className="font-mono text-xs text-zinc-300">
                      {origin[1].toFixed(4)}, {origin[0].toFixed(4)}
                    </span>
                  ) : (
                    `Click the map to set it`
                  )}
                </span>
                {origin && (
                  <button onClick={() => setOrigin(null)} className="text-zinc-500 hover:text-zinc-200" aria-label="Clear point">
                    <Icon name="x" />
                  </button>
                )}
              </div>
            </section>
          )}

          <button
            onClick={generate}
            disabled={!terrain || computing || missingOrigin}
            className="inline-flex items-center justify-center gap-2 rounded-xl bg-brand px-4 py-3 text-sm font-semibold text-zinc-950 shadow-[0_0_24px_-6px] shadow-brand/60 hover:bg-brand-hover disabled:opacity-40 disabled:shadow-none"
          >
            <Icon name="play" />
            {computing ? "Simulating 24 hours…" : missingOrigin ? `Set the ${meta.originLabel?.toLowerCase()} first` : "Run 24-hour simulation"}
          </button>

          <div className="h-px bg-white/[0.06]" />

          <PeoplePanel people={people} setPeople={setPeople} placing={placingPerson} setPlacing={setPlacingPerson} call={callToo} setCall={setCallToo} />

          {runs.length > 0 && (
            <section className="flex flex-col gap-1.5">
              <Label>Runs</Label>
              {runs.map((r) => (
                <div
                  key={r.id}
                  className={`group flex items-center gap-2 rounded-lg px-2.5 py-1.5 ${r.id === activeId ? "bg-white/[0.06]" : "hover:bg-white/[0.03]"}`}
                >
                  <button onClick={() => viewScenario(r)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                    <span className="size-2 shrink-0 rounded-full" style={{ background: RUN_COLORS[r.id % RUN_COLORS.length] }} />
                    <span className="min-w-0">
                      <span className="block truncate text-[13px]">
                        {r.place.name} · {HAZARDS[r.hazard].label}
                      </span>
                      <span className="block truncate text-[11px] text-zinc-500">{describeParams(r.hazard, r.params)}</span>
                    </span>
                  </button>
                  <button onClick={() => loadSettings(r)} className="shrink-0 text-[11px] text-zinc-500 hover:text-zinc-200">
                    Load
                  </button>
                  <button
                    onClick={() => {
                      setRuns((old) => old.filter((x) => x.id !== r.id));
                      if (r.id === activeId) setActiveId(null);
                    }}
                    className="shrink-0 text-zinc-600 hover:text-zinc-200"
                    aria-label={`Delete run ${r.id}`}
                  >
                    <Icon name="x" className="size-3.5" />
                  </button>
                </div>
              ))}
            </section>
          )}
        </aside>

        {/* ---- Map + timeline ---- */}
        <main className="flex min-h-0 min-w-0 flex-col gap-3">
          <div className="relative h-[60vh] overflow-hidden rounded-2xl border border-white/[0.07] lg:h-auto lg:flex-1">
            <MapView
              center={place.center}
              showLaAoi={place.name === "Los Angeles"}
              terrain={terrain}
              hazard={viewRun?.hazard ?? null}
              frame={viewRun?.result.frames[frameIdx] ?? null}
              zones={zones}
              origin={meta.originLabel ? (viewRun ? viewRun.origin : origin) : null}
              stations={stations}
              crews={viewRun?.result.crews?.[frameIdx] ?? null}
              basemap={basemap}
              terrain3d={terrain3d}
              people={mapPeople}
              places={mapPlaces}
              onMapClick={onMapClick}
              badge={null}
            />
            {computing && (
              <div className="absolute inset-0 z-10 flex flex-col items-center justify-center gap-2 bg-black/50 backdrop-blur-sm">
                <span className="size-6 animate-spin rounded-full border-2 border-brand border-t-transparent" />
                <span className="font-mono text-xs tracking-wider text-zinc-300">SIMULATING 24 HOURS ON REAL TERRAIN</span>
              </div>
            )}
            {placingPerson && (
              <div className="pointer-events-none absolute left-1/2 top-3 z-20 -translate-x-1/2 rounded-full bg-white px-3 py-1.5 text-xs font-semibold text-zinc-950 shadow-lg">
                Click the person&apos;s home on the map
              </div>
            )}
            {(viewRun || stations.length > 0 || people.length > 0) && (
              <Legend hazard={viewRun?.hazard ?? null} crews={!!viewRun?.result.crews} stations={stations.length > 0} people={people.length > 0} places={atRisk.length > 0} zones={!!zoneKm2} />
            )}
          </div>

          <div className={`${panel} flex flex-col gap-2 px-4 py-3`}>
            <div className="flex items-center gap-3">
              <div className="flex items-center gap-1">
                <IconButton label="Rewind to start" disabled={!viewRun} onClick={() => { setPlaying(false); setT(0); }} icon="rewind" />
                <IconButton label="Back 1 hour" disabled={!viewRun} onClick={() => stepBy(-1)} icon="back" />
                <button
                  onClick={togglePlay}
                  disabled={!viewRun}
                  aria-label={playing ? "Pause" : "Play"}
                  className="flex size-9 items-center justify-center rounded-full bg-brand text-zinc-950 hover:bg-brand-hover disabled:opacity-30"
                >
                  <Icon name={playing ? "pause" : "play"} />
                </button>
                <IconButton label="Forward 1 hour" disabled={!viewRun} onClick={() => stepBy(1)} icon="forward" />
                <button
                  onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
                  disabled={!viewRun}
                  aria-label="Change playback speed"
                  className="ml-1 rounded-md border border-white/10 px-2 py-1 font-mono text-[11px] text-zinc-300 hover:bg-white/5 disabled:opacity-30"
                >
                  {speed}h/s
                </button>
              </div>
              <div className="min-w-0 flex-1">
                <AreaSparkline area={viewRun?.result.area ?? null} t={t} />
                <input
                  type="range"
                  min={0}
                  max={HOURS}
                  step={1 / FRAMES_PER_HOUR}
                  value={t}
                  onChange={(e) => {
                    setPlaying(false);
                    setT(Number(e.target.value));
                  }}
                  disabled={!viewRun}
                  className="-mt-1 h-1 w-full accent-brand disabled:opacity-30"
                  aria-label="Simulation time"
                />
                <div className="flex justify-between font-mono text-[10px] text-zinc-600">
                  {[0, 6, 12, 18, 24].map((h) => (
                    <span key={h}>{h}h</span>
                  ))}
                </div>
              </div>
            </div>
          </div>
        </main>

        {/* ---- Incident ---- */}
        <aside className={`${panel} flex flex-col gap-4 p-4 lg:overflow-y-auto`}>
          {!viewRun ? (
            <IncidentEmpty />
          ) : (
            <>
              <div className="flex items-start justify-between">
                <div>
                  <Label>Incident</Label>
                  <p className="mt-1 font-mono text-3xl font-medium tracking-tight">{formatT(t)}</p>
                  <p className="mt-0.5 text-xs text-zinc-500">
                    {viewRun.place.name} · {describeParams(viewRun.hazard, viewRun.params)}
                  </p>
                </div>
                <span
                  className={`rounded-full px-2 py-0.5 font-mono text-[10px] font-semibold tracking-wider ${
                    incidentState === "Burning" || incidentState === "Rising" ? "bg-red-500/15 text-red-400" : "bg-white/[0.06] text-zinc-400"
                  }`}
                >
                  {incidentState?.toUpperCase()}
                </span>
              </div>

              <div className="grid grid-cols-2 gap-2">
                <Metric label="Affected" value={area.toFixed(2)} unit="km²" />
                <Metric label="Evacuate now" value={zoneKm2 ? zoneKm2[0].toFixed(2) : "—"} unit={zoneKm2 ? "km²" : ""} tone="red" />
                <Metric label="Places at risk" value={String(pendingPlaces)} unit={`${atRisk.length - pendingPlaces} reached`} tone={pendingPlaces ? "amber" : undefined} />
                {viewRun.hazard === "wildfire" ? (
                  <Metric label="Crews out" value={String(crewsOut)} unit={`of ${viewRun.params.crews}`} />
                ) : (
                  <Metric label="Alerts sent" value={String(phoneMessages.length)} unit={`of ${people.length}`} />
                )}
              </div>

              {atRisk.length > 0 && <EvacuateFirst places={atRisk} t={t} />}

              <DispatchRadio key={viewRun.id} runId={viewRun.id} input={{ ...viewRun, placeName: viewRun.place.name, placesAtRisk: atRisk }} />

              {people.length > 0 && <AlertFeed messages={phoneMessages} hazard={viewRun.hazard === "wildfire" ? "fire" : "flood"} />}
            </>
          )}
        </aside>
      </div>
    </div>
  );
}

const panel = "rounded-2xl border border-white/[0.07] bg-[#0d0f12]";
const choice = (on: boolean) =>
  `rounded-lg px-2 py-1.5 text-[13px] transition-colors ${
    on ? "bg-white text-zinc-950 font-medium" : "bg-white/[0.04] text-zinc-400 hover:bg-white/[0.08] hover:text-zinc-200"
  }`;

function Label({ children }: { children: React.ReactNode }) {
  return <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">{children}</h2>;
}

function Toggle({ on, onChange, label }: { on: boolean; onChange: (v: boolean) => void; label: string }) {
  return (
    <button
      onClick={() => onChange(!on)}
      aria-pressed={on}
      className={`rounded-lg border px-2.5 py-1 ${on ? "border-white/20 bg-white/10 text-white" : "border-white/10 text-zinc-500 hover:text-zinc-300"}`}
    >
      {label}
    </button>
  );
}

function IconButton({ icon, label, onClick, disabled }: { icon: IconName; label: string; onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      aria-label={label}
      className="flex size-8 items-center justify-center rounded-full text-zinc-300 hover:bg-white/[0.06] disabled:opacity-30"
    >
      <Icon name={icon} />
    </button>
  );
}

function Metric({ label, value, unit, tone }: { label: string; value: string; unit: string; tone?: "red" | "amber" }) {
  const color = tone === "red" ? "text-rose-400" : tone === "amber" ? "text-amber-300" : "text-zinc-100";
  return (
    <div className="rounded-xl bg-white/[0.03] px-3 py-2.5">
      <p className="text-[10px] font-medium uppercase tracking-[0.12em] text-zinc-500">{label}</p>
      <p className={`mt-1 font-mono text-xl ${color}`}>
        {value} <span className="text-[11px] text-zinc-500">{unit}</span>
      </p>
    </div>
  );
}

/** Area affected over the 24 hours, with the part already played highlighted. */
function AreaSparkline({ area, t }: { area: number[] | null; t: number }) {
  const W = 960, H = 34;
  if (!area) return <div className="h-[34px] rounded bg-white/[0.02]" />;
  const max = Math.max(...area, 0.01);
  const pts = area.map((a, i) => `${((i / (area.length - 1)) * W).toFixed(1)},${(H - (a / max) * (H - 2)).toFixed(1)}`);
  const line = `M${pts.join(" L")}`;
  const fill = `${line} L${W},${H} L0,${H} Z`;
  const x = (t / HOURS) * W;
  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" className="block h-[34px] w-full" aria-hidden="true">
      <defs>
        <clipPath id="played">
          <rect x="0" y="0" width={x} height={H} />
        </clipPath>
      </defs>
      <path d={fill} fill="rgba(255,255,255,0.05)" />
      <path d={fill} fill="rgba(255,107,44,0.28)" clipPath="url(#played)" />
      <path d={line} fill="none" stroke="#ff6b2c" strokeWidth="1.5" vectorEffect="non-scaling-stroke" clipPath="url(#played)" />
      <line x1={x} x2={x} y1="0" y2={H} stroke="#ff6b2c" strokeWidth="1" vectorEffect="non-scaling-stroke" />
    </svg>
  );
}

function IncidentEmpty() {
  const steps = [
    ["Pick a place and hazard", "Real terrain, imagery and fire stations load for a 12 km area."],
    ["Set where it starts", "Click the map: an ignition point or a river breach."],
    ["Run the next 24 hours", "See who it reaches and when, with evacuation zones drawn ahead of it and a radio briefing in any language."],
  ];
  return (
    <div className="flex flex-col gap-5">
      <div>
        <Label>Incident</Label>
        <p className="mt-2 text-lg font-medium leading-snug">No active incident</p>
        <p className="mt-1 text-[13px] leading-relaxed text-zinc-500">
          Warnings fail when nobody can see where a disaster is going. TerraShift shows the next 24 hours, so the right people move in time.
        </p>
      </div>
      <ol className="flex flex-col gap-3">
        {steps.map(([title, body], i) => (
          <li key={title} className="flex gap-3">
            <span className="flex size-6 shrink-0 items-center justify-center rounded-full bg-white/[0.06] font-mono text-[11px] text-zinc-300">{i + 1}</span>
            <span>
              <span className="block text-[13px] font-medium">{title}</span>
              <span className="block text-xs leading-relaxed text-zinc-500">{body}</span>
            </span>
          </li>
        ))}
      </ol>
      <p className="mt-auto text-[11px] leading-relaxed text-zinc-600">
        Terrain: Mapzen/AWS · Imagery: Esri · Stations, hospitals, schools: © OpenStreetMap · Briefings: Gemini · Voice: ElevenLabs · Weather: Open-Meteo
      </p>
    </div>
  );
}

function Legend({
  hazard,
  crews,
  stations,
  people,
  places,
  zones,
}: {
  hazard: Hazard | null;
  crews: boolean;
  stations: boolean;
  people: boolean;
  places: boolean;
  zones: boolean;
}) {
  const swatch = "size-2.5 rounded-sm";
  const items: [string, string, string?][] =
    hazard === "wildfire"
      ? [[swatch, "Burning", "#ff9a14"], [swatch, "Burnt", "#37120c"]]
      : hazard === "flood"
        ? [[swatch, "Shallow water", "#5abeff"], [swatch, "Deep (2.5 m+)", "#0a46d7"]]
        : [];
  if (crews) items.push([swatch, "Put out", "#22d3ee"], [`${CREW_CLASS} !size-2.5 !border`, "Fire crew"]);
  if (zones) ZONES.forEach((z) => items.push([swatch, `${z.label} <${z.within}h`, `rgb(${z.rgb.join(",")})`]));
  if (stations) items.push([`${STATION_CLASS} !size-2.5 !border`, "Fire station"]);
  if (places) items.push([`${placeClass("later")} !size-3 !border !text-[7px]`, "Hospital / care / school"]);
  if (people) items.push([`${personClass("safe")} !size-2.5 !border`, "Person"]);
  return (
    <div
      className={`pointer-events-none absolute left-3 top-3 z-10 grid gap-x-4 gap-y-1 rounded-xl bg-black/65 px-3 py-2.5 text-[11px] text-zinc-300 backdrop-blur-md ${
        items.length > 2 ? "grid-cols-2" : "grid-cols-1"
      }`}
    >
      {items.map(([cls, l, c]) => (
        <span key={l} className="flex items-center gap-2 whitespace-nowrap">
          <span className={`${cls} shrink-0`} style={c ? { background: c } : undefined} />
          {l}
        </span>
      ))}
    </div>
  );
}

/** The next places that must start evacuating, with a countdown to their deadline. */
function EvacuateFirst({ places, t }: { places: PlaceAtRisk[]; t: number }) {
  const pending = places.filter((p) => placeStatus(p, t) !== "reached");
  const mins = (h: number) => {
    const m = Math.round(Math.abs(h) * 60);
    return m >= 60 ? `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m` : `${m}m`;
  };
  return (
    <section className="flex flex-col gap-1.5">
      <div className="flex items-center justify-between">
        <Label>
          Evacuate first
          <InfoTip label="evacuate first">
            <span>
              Hospitals, care homes and schools in the path (from OpenStreetMap), ordered by when they must <b className="text-zinc-100">start</b>{" "}
              leaving: care homes need about {EVAC_H.care_home} h, hospitals {EVAC_H.hospital} h, schools {EVAC_H.school} h to get everyone out.
            </span>
          </InfoTip>
        </Label>
        <span className="font-mono text-[11px] text-zinc-500">{pending.length} pending</span>
      </div>
      {pending.length === 0 && <p className="text-xs text-zinc-500">Every place in the path has been reached.</p>}
      <ul className="flex flex-col">
        {pending.slice(0, 5).map((p) => {
          const status = placeStatus(p, t);
          const left = p.startByH - t;
          return (
            <li key={p.place.name + p.place.kind} className="flex items-center gap-2.5 border-b border-white/[0.04] py-1.5 last:border-0">
              <span className={`${placeClass(status)} !size-5 shrink-0`}>{PLACE_LETTER[p.place.kind]}</span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]" title={p.place.name}>
                  {p.place.name}
                </span>
                <span className="block text-[11px] text-zinc-500">
                  {KIND_LABEL[p.place.kind]} · reached {formatT(p.arrivalH)}
                </span>
              </span>
              <span
                className={`shrink-0 rounded-md px-1.5 py-0.5 font-mono text-[11px] ${
                  status === "late" ? "bg-red-500/15 text-red-400" : status === "start_now" ? "bg-amber-400/15 text-amber-300" : "text-zinc-400"
                }`}
              >
                {status === "late" ? `-${mins(left)}` : status === "start_now" ? "NOW" : `in ${mins(left)}`}
              </span>
            </li>
          );
        })}
      </ul>
      {pending.length > 5 && <p className="text-[11px] text-zinc-500">+{pending.length - 5} more in the path</p>}
    </section>
  );
}
