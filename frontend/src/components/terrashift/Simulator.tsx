"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { api, type RunStats, type SafePoint, type SavedRun } from "@/lib/api";
import { buildRunCreate } from "@/lib/runs";
import {
  DEFAULT_PARAMS,
  FRAMES_PER_HOUR,
  HAZARDS,
  HOURS,
  PARAM_META,
  backendCoversFire,
  compass,
  describeParams,
  loadTerrain,
  lngLatToCell,
  runBackendFlood,
  runBackendWildfire,
  runSeed,
  runSimulation,
  terrainKey,
  type Hazard,
  type LngLat,
  type Params,
  type SimResult,
  type Terrain,
  type WeatherDay,
} from "@/lib/sim";
import { conditionsAtHour, weatherRainTotal } from "@/lib/sim/weather";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";
import { Icon, type IconName } from "./Icon";
import { InfoTip } from "./InfoTip";
import { SimMap, type Basemap } from "./SimMap";
import { StatsPanel } from "./StatsPanel";

type Place = { name: string; center: LngLat };

/** frames plus the grid they were simulated on (the backend samples its own) */
type Sim = { result: SimResult; grid: Terrain };

type Run = {
  id: number;
  /** row in Tiger Data, once saved */
  dbId: number | null;
  seed: number;
  hazard: Hazard;
  place: Place;
  /** terrainKey of the place */
  key: string;
  params: Params;
  origin: LngLat | null;
  source: "backend" | "browser";
  /** null for runs reloaded from Tiger Data until they're re-simulated (same seed, same result) */
  sim: Sim | null;
  safePoints: SafePoint[] | null;
  stats: RunStats | null;
  /** why this run isn't saved or its safe points / stats are missing */
  note: string | null;
};

const PRESETS: Place[] = [
  { name: "Fort McMurray", center: [-111.38, 56.726] },
  { name: "Oxford", center: [-1.255, 51.745] },
  { name: "Brisbane", center: [153.025, -27.47] },
  { name: "Los Angeles", center: [-118.2437, 34.0522] },
  { name: "Topanga, LA", center: [-118.6, 34.1] },
];

const HAZARD_ICON: Record<Hazard, IconName> = { wildfire: "flame", flood: "drop" };
const RUN_COLORS = ["#f97316", "#38bdf8", "#a3e635", "#e879f9", "#facc15", "#f87171"];
const SPEEDS = [0.5, 1, 2, 4];
const MAX_RUNS = 6;

const errorText = (e: unknown) => (e instanceof Error ? e.message : "request failed");

function fromSaved(s: SavedRun, id: number): Run {
  const place = PRESETS.find((p) => p.name === s.place_name) ?? { name: s.place_name, center: s.center };
  return {
    id,
    dbId: s.id,
    seed: s.seed,
    hazard: s.hazard,
    place,
    key: terrainKey(place.center),
    params: { ...DEFAULT_PARAMS, ...s.params },
    origin: s.origin,
    source: s.source,
    sim: null,
    safePoints: null,
    stats: null,
    note: null,
  };
}

function formatT(hours: number) {
  const f = Math.round(hours * FRAMES_PER_HOUR);
  const h = Math.floor(f / FRAMES_PER_HOUR);
  const m = (f % FRAMES_PER_HOUR) * (60 / FRAMES_PER_HOUR);
  return `T+${h}h ${String(m).padStart(2, "0")}m`;
}

const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";

export function Simulator() {
  const [place, setPlace] = useState<Place>(PRESETS[0]);
  const [terrains, setTerrains] = useState<Record<string, Terrain>>({});
  const [terrainError, setTerrainError] = useState<string | null>(null);
  const [hazard, setHazard] = useState<Hazard>("wildfire");
  const [params, setParams] = useState<Params>(DEFAULT_PARAMS);
  const [weatherMode, setWeatherMode] = useState<"manual" | "yesterday" | "saved">("manual");
  const [weather, setWeather] = useState<WeatherDay | null>(null);
  const [weatherLoading, setWeatherLoading] = useState(false);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [weatherReload, setWeatherReload] = useState(0);
  const [origin, setOrigin] = useState<LngLat | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [computing, setComputing] = useState(false);
  const [simNote, setSimNote] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [terrain3d, setTerrain3d] = useState(false);
  const [dbNote, setDbNote] = useState<string | null>(null);
  const nextId = useRef(1);
  /** set once the user generates, so restoring saved runs doesn't overwrite their choices */
  const touched = useRef(false);
  const resimulating = useRef(new Set<number>());

  const key = terrainKey(place.center);
  const terrain = terrains[key] ?? null;
  const weatherMatchesPlace = weather?.latitude === place.center[1] && weather?.longitude === place.center[0];
  const weatherReady = weatherMode === "manual" || (weatherMatchesPlace && !weatherLoading && !weatherError);
  const simulationParams: Params = weatherMode !== "manual" && weatherMatchesPlace && weather
    ? { ...params, weather }
    : params;
  const activeRun = runs.find((r) => r.id === activeId) ?? null;
  const viewRun = activeRun && activeRun.key === key ? activeRun : null;
  const viewSim = viewRun?.sim ?? null;
  const frameIdx = Math.round(t * FRAMES_PER_HOUR);
  const hour = Math.min(HOURS, Math.floor(t));
  const hourSafePoints = useMemo(
    () => viewRun?.safePoints?.filter((p) => p.hour === hour) ?? [],
    [viewRun?.safePoints, hour],
  );
  const meta = HAZARDS[hazard];
  const missingOrigin = meta.originLabel !== null && origin === null;
  const useBackend = hazard === "flood" || (hazard === "wildfire" && terrain !== null && backendCoversFire(terrain));

  useEffect(() => {
    if (weatherMode !== "yesterday") return;
    const controller = new AbortController();
    setWeather(null);
    setWeatherLoading(true);
    setWeatherError(null);
    api.weather.yesterday(place.center[1], place.center[0], controller.signal)
      .then((day) => { if (!controller.signal.aborted) setWeather(day); })
      .catch((e) => { if (!controller.signal.aborted) setWeatherError(errorText(e)); })
      .finally(() => { if (!controller.signal.aborted) setWeatherLoading(false); });
    return () => controller.abort();
  }, [weatherMode, place.center[0], place.center[1], weatherReload]);

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
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
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

  // Bring back saved scenarios and the last conditions used from Tiger Data.
  useEffect(() => {
    let cancelled = false;
    api.runs
      .list(MAX_RUNS)
      .then((saved) => {
        if (cancelled || saved.length === 0) return;
        const restored = saved.map((s) => fromSaved(s, nextId.current++));
        setRuns((old) => [...old, ...restored.filter((r) => !old.some((o) => o.dbId === r.dbId))].slice(0, MAX_RUNS));
        if (touched.current) return;
        loadSettings(restored[0]);
        setActiveId(restored[0].id);
      })
      .catch((e) => !cancelled && setDbNote(`Saved scenarios unavailable: ${errorText(e)}`));
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Restored runs come back without frames; re-run them (same seed, same result) once their terrain is loaded.
  useEffect(() => {
    const r = viewRun;
    if (!r || r.sim || !terrain || resimulating.current.has(r.id)) return;
    resimulating.current.add(r.id);
    setComputing(true);
    simulateRun(r.hazard, terrain, r.params, r.origin, r.seed, r.source === "backend").then(({ sim }) => {
      updateRun(r.id, { sim });
      setComputing(false);
      if (r.dbId !== null && (!r.stats || !r.safePoints)) void loadResults(r.id, r.dbId);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [viewRun, terrain]);

  const updateRun = (id: number, patch: Partial<Run>) =>
    setRuns((old) => old.map((r) => (r.id === id ? { ...r, ...patch } : r)));

  async function simulateRun(h: Hazard, tr: Terrain, p: Params, o: LngLat | null, seed: number, wantBackend: boolean) {
    if (wantBackend) {
      try {
        const sim = h === "flood" ? await runBackendFlood(tr, p) : await runBackendWildfire(tr, p, o, seed);
        return { sim, source: "backend" as const };
      } catch (e) {
        const model = h === "flood" ? "River flood model" : "LA fire model";
        setSimNote(`${model} unavailable (${errorText(e)}), so this run used the simpler in-browser model.`);
      }
    }
    return { sim: { result: runSimulation(h, tr, p, o, seed), grid: tr }, source: "browser" as const };
  }

  /** Store the run in Tiger Data, then read back its statistics and safe points. */
  async function save(run: Run, sim: Sim) {
    try {
      const saved = await api.runs.create(
        buildRunCreate(
          { hazard: run.hazard, placeName: run.place.name, center: run.place.center, params: run.params, origin: run.origin, seed: run.seed, source: run.source },
          sim.grid,
          sim.result,
        ),
      );
      updateRun(run.id, { dbId: saved.id });
      await loadResults(run.id, saved.id);
    } catch (e) {
      updateRun(run.id, { note: `Not saved to Tiger Data: ${errorText(e)}` });
    }
  }

  async function loadResults(id: number, dbId: number) {
    const [stats, points] = await Promise.allSettled([api.runs.stats(dbId), api.runs.safePoints(dbId)]);
    const failed = [stats, points]
      .filter((r): r is PromiseRejectedResult => r.status === "rejected")
      .map((r) => errorText(r.reason));
    updateRun(id, {
      stats: stats.status === "fulfilled" ? stats.value : null,
      safePoints: points.status === "fulfilled" ? points.value : null,
      note: failed.length ? failed.join(" · ") : null,
    });
  }

  function changePlace(p: Place) {
    if (terrainKey(p.center) !== key) setOrigin(null);
    if (weatherMode === "saved") setWeatherMode("yesterday");
    touched.current = true;
    setPlace(p);
  }

  function generate() {
    if (!terrain || missingOrigin || !weatherReady) return;
    const o = meta.originLabel ? origin : null;
    const seed = runSeed(hazard, terrain, simulationParams, o);
    const existing = runs.find((r) => r.seed === seed && r.key === key);
    if (existing) {
      // same conditions → same (reproducible) simulation; just replay it
      setActiveId(existing.id);
      setT(0);
      setPlaying(true);
      return;
    }
    touched.current = true;
    setComputing(true);
    setPlaying(false);
    setSimNote(null);
    setTimeout(async () => {
      const { sim, source } = await simulateRun(hazard, terrain, simulationParams, o, seed, useBackend);
      const run: Run = {
        id: nextId.current++, dbId: null, seed, hazard, place, key, params: simulationParams, origin: o, source, sim,
        safePoints: null, stats: null, note: null,
      };
      setRuns((old) => [run, ...old].slice(0, MAX_RUNS));
      setActiveId(run.id);
      setT(0);
      setPlaying(true);
      setComputing(false);
      void save(run, sim);
    }, 30);
  }

  /** Take the current simulation off the map so a new start point can be placed. Saved scenarios stay. */
  function clearSimulation() {
    setPlaying(false);
    setT(0);
    setActiveId(null);
    setOrigin(null);
    setSimNote(null);
  }

  function viewScenario(r: Run) {
    setActiveId(r.id);
    if (r.key !== key) setPlace(r.place);
  }

  function deleteRun(r: Run) {
    setRuns((old) => old.filter((x) => x.id !== r.id));
    if (r.id === activeId) setActiveId(null);
    if (r.dbId !== null) api.runs.remove(r.dbId).catch((e) => setDbNote(`Couldn't delete run from Tiger Data: ${errorText(e)}`));
  }

  function loadSettings(r: Run) {
    setHazard(r.hazard);
    const { weather: savedWeather, ...manualParams } = r.params;
    setParams(manualParams);
    setWeather(savedWeather ?? null);
    setWeatherMode(savedWeather ? "saved" : "manual");
    setWeatherLoading(false);
    setWeatherError(null);
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

  const area = viewSim ? viewSim.result.area[frameIdx] : 0;
  const runStatus = viewRun ? viewRun.note ?? (viewRun.dbId === null ? "Saving to Tiger Data…" : null) : null;
  const shownWeather = viewRun ? viewRun.params.weather : (weatherMode !== "manual" && weatherMatchesPlace ? weather : null);
  const shownConditions = conditionsAtHour(shownWeather ? { ...params, weather: shownWeather } : params, viewRun ? t : 0);

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 lg:flex">
      {/* ---- Controls ---- */}
      <aside className="flex flex-col gap-6 border-zinc-800 p-5 lg:sticky lg:top-0 lg:h-screen lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:border-r">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-zinc-400">{APP_TAGLINE}</p>
        </header>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Location</h2>
          <div className="grid grid-cols-2 gap-1.5">
            {PRESETS.map((p) => (
              <button
                key={p.name}
                onClick={() => changePlace(p)}
                className={`rounded-lg border px-2 py-2 text-sm ${
                  place.name === p.name
                    ? "border-brand bg-brand/20 text-white"
                    : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {p.name}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-500">
            {terrainError
              ? `Terrain failed to load: ${terrainError}`
              : terrain
                ? `${terrain.name} · 12×12 km · ${Math.round(terrain.cellM)} m cells · elevation ${Math.round(
                    terrain.minElev,
                  )}–${Math.round(terrain.maxElev)} m`
                : "Loading elevation and imagery…"}
            {terrain?.demSource === "synthetic" && " · elevation tiles unavailable, using synthetic terrain"}
            {hazard === "wildfire" && useBackend && " · wildfire runs on the LA maps (USGS 3DEP elevation, NLCD 2021 land cover)"}
          </p>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Disaster</h2>
          <div className="grid grid-cols-2 gap-1.5">
            {(Object.keys(HAZARDS) as Hazard[]).map((h) => (
              <button
                key={h}
                onClick={() => setHazard(h)}
                className={`flex flex-col items-center gap-1 rounded-lg border px-2 py-2.5 text-sm ${
                  hazard === h
                    ? "border-brand bg-brand/20 text-white"
                    : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                <Icon name={HAZARD_ICON[h]} className="size-5" />
                {HAZARDS[h].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-500">{meta.blurb}</p>
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">
            Environmental conditions
            <InfoTip label="environmental conditions">
              {hazard === "wildfire" ? (
                <>
                  <span><b className="text-zinc-100">Wind speed:</b> stronger wind pushes the fire faster in the direction it blows.</span>
                  <span><b className="text-zinc-100">Wind direction:</b> where the wind comes from. The fire spreads the other way (follow the arrow).</span>
                  <span><b className="text-zinc-100">Humidity:</b> damper air slows the fire. Above about 80% it barely spreads.</span>
                  <span>Fires also spread faster uphill.</span>
                </>
              ) : (
                <>
                  <span><b className="text-zinc-100">Rainfall:</b> average intensity of the storm. It builds to a peak, then eases off. Paved ground sheds most of it; forest soaks more up.</span>
                  <span><b className="text-zinc-100">Storm duration:</b> how long it rains. Total rain is intensity × duration.</span>
                  <span><b className="text-zinc-100">Soil saturation:</b> how wet the ground already is. It gets wetter as the storm goes on, so later rain runs off faster.</span>
                  <span>Runoff drains into the rivers (teal). Once a river is over its banks it spills onto the floodplain (blue).</span>
                </>
              )}
            </InfoTip>
          </h2>
          <label className="flex flex-col gap-1.5 text-sm">
            <span className="font-medium">Weather source</span>
            <select
              value={weatherMode}
              onChange={(e) => {
                touched.current = true;
                setWeatherMode(e.target.value as "manual" | "yesterday" | "saved");
                setWeatherError(null);
                setWeatherLoading(false);
              }}
              className="rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-zinc-100"
            >
              <option value="manual">Manual conditions</option>
              <option value="yesterday">Yesterday’s weather at this location</option>
              {weatherMode === "saved" && <option value="saved">Loaded scenario’s hourly weather</option>}
            </select>
          </label>
          {weatherMode !== "manual" && (
            <div className="flex flex-col gap-2 rounded-lg border border-sky-900 bg-sky-950/30 p-3 text-xs text-sky-100" aria-live="polite">
              {weatherLoading || (!weather && !weatherError) ? <p>Loading yesterday’s hourly weather for {place.name}…</p> : weatherError ? (
                <>
                  <p role="alert">{weatherError}</p>
                  <button type="button" className={btn} onClick={() => setWeatherReload((n) => n + 1)}>Retry weather</button>
                </>
              ) : weather && weatherMatchesPlace ? (
                <>
                  <p className="font-medium">{weather.date} · {weather.timezone} · 00:00–24:00</p>
                  <p>Wind and humidity change hourly. Floods use each hour’s liquid rainfall. Soil saturation stays manual.</p>
                  <p>{weatherRainTotal({ ...params, weather }, 24).toFixed(1)} mm rain over the day</p>
                  {weather.dayHours && weather.dayHours !== 24 && (
                    <p>This local day had {weather.dayHours} hours. The 24-hour timeline combines repeated hours or fills a skipped hour, preserving the day’s rain total.</p>
                  )}
                  <a className="underline" href="https://open-meteo.com/" target="_blank" rel="noreferrer">Modelled weather by Open-Meteo</a>
                </>
              ) : null}
            </div>
          )}
          {meta.params.map((k) => {
            const pm = PARAM_META[k];
            if (weatherMode !== "manual" && k !== "saturation") return null;
            return (
              <label key={k} className="flex flex-col gap-1.5">
                <span className="flex items-center justify-between text-sm">
                  <span className="font-medium">{pm.label}</span>
                  <span className="flex items-center gap-1.5 tabular-nums text-zinc-300">
                    {k === "windDir" && (
                      <svg viewBox="0 0 24 24" className="size-4" style={{ transform: `rotate(${params.windDir + 180}deg)` }} aria-hidden="true">
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
                  className="w-full accent-brand"
                />
              </label>
            );
          })}
          {meta.originLabel && (
            <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
              <span className="flex items-center gap-2">
                <Icon name="target" className="size-4 text-orange-400" />
                <span>
                  <span className="flex items-center gap-2 font-medium">
                    {meta.originLabel}
                    <InfoTip label={meta.originLabel}>
                      <span>
                        Required. Click the map to place it. <b className="text-zinc-100">That point is exactly where the fire starts</b>, and it spreads outward from there.
                      </span>
                      <span>Click somewhere else to move it, or press × to clear it.</span>
                    </InfoTip>
                  </span>
                  <span className={`block text-xs ${origin ? "text-zinc-500" : "text-amber-400"}`}>
                    {origin
                      ? `Starts at ${origin[1].toFixed(4)}, ${origin[0].toFixed(4)}`
                      : "Required · click the map where the fire starts"}
                  </span>
                </span>
              </span>
              {origin && !viewRun && (
                <button onClick={() => setOrigin(null)} className="text-zinc-500 hover:text-zinc-200" aria-label="Clear point">
                  <Icon name="x" />
                </button>
              )}
            </div>
          )}
          {viewRun ? (
            <>
              <button
                onClick={clearSimulation}
                disabled={computing}
                className="inline-flex items-center justify-center gap-2 rounded-lg border border-zinc-600 bg-zinc-800 px-4 py-2.5 font-medium text-zinc-100 hover:bg-zinc-700 disabled:opacity-50"
              >
                <Icon name="x" />
                Clear simulation
              </button>
              <p className="text-xs text-zinc-500">
                Clear the current simulation to{" "}
                {meta.originLabel ? `place a new ${meta.originLabel.toLowerCase()}` : "generate another"}. It stays in
                saved scenarios.
              </p>
            </>
          ) : (
            <button
              onClick={generate}
              disabled={!terrain || computing || missingOrigin || !weatherReady}
              className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-hover disabled:opacity-50"
            >
              <Icon name="play" />
              {computing
                ? "Simulating 24 hours…"
                : !weatherReady
                  ? weatherError ? "Weather unavailable · retry or use manual" : "Loading weather…"
                : missingOrigin
                  ? `Set the ${meta.originLabel?.toLowerCase()} first`
                  : "Generate simulation"}
            </button>
          )}
          {simNote && <p className="text-xs text-amber-400">{simNote}</p>}
          {viewRun?.note && <p className="text-xs text-amber-400">{viewRun.note}</p>}
          {dbNote && <p className="text-xs text-zinc-500">{dbNote}</p>}
        </section>

        {runs.length > 0 && (
          <section className="flex flex-col gap-2">
            <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Saved scenarios</h2>
            {runs.map((r) => (
              <div
                key={r.id}
                className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${
                  r.id === activeId ? "border-zinc-500 bg-zinc-800/70" : "border-zinc-800 bg-zinc-900"
                }`}
              >
                <button onClick={() => viewScenario(r)} className="flex min-w-0 flex-1 items-center gap-2 text-left">
                  <span className="size-2.5 shrink-0 rounded-full" style={{ background: RUN_COLORS[r.id % RUN_COLORS.length] }} />
                  <span className="min-w-0">
                    <span className="block truncate text-sm font-medium">
                      Run {r.id} · {HAZARDS[r.hazard].label}
                    </span>
                    <span className="block truncate text-xs text-zinc-500">
                      {r.place.name} · {describeParams(r.hazard, r.params)}
                    </span>
                  </span>
                </button>
                <button onClick={() => loadSettings(r)} className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-700">
                  Load settings
                </button>
                <button
                  onClick={() => deleteRun(r)}
                  className="shrink-0 text-zinc-500 hover:text-zinc-200"
                  aria-label={`Delete run ${r.id}`}
                >
                  <Icon name="x" />
                </button>
              </div>
            ))}
          </section>
        )}
      </aside>

      {/* ---- Map + timeline ---- */}
      <main className="flex min-w-0 flex-1 flex-col lg:h-screen">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
          <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700">
            {(["satellite", "streets"] as Basemap[]).map((b) => (
              <button
                key={b}
                onClick={() => setBasemap(b)}
                className={`px-3 py-1.5 capitalize ${basemap === b ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}
              >
                {b}
              </button>
            ))}
          </div>
          <label className="inline-flex items-center gap-2 text-zinc-300">
            <input type="checkbox" checked={terrain3d} onChange={(e) => setTerrain3d(e.target.checked)} className="accent-brand" />
            3D terrain
          </label>
          <span className="ml-auto text-zinc-400">
            {viewRun ? (
              <>
                Run {viewRun.id} · {HAZARDS[viewRun.hazard].label} · {describeParams(viewRun.hazard, viewRun.params)}
                {viewRun.source === "backend" && (viewRun.hazard === "flood" ? " · river routing" : " · LA maps")}
              </>
            ) : (
              "No simulation shown. Set conditions and press Generate."
            )}
          </span>
        </div>

        <div className="relative h-[60vh] lg:h-auto lg:flex-1">
          <SimMap
            center={place.center}
            showLaAoi={place.name === "Los Angeles"}
            terrain={viewSim?.grid ?? terrain}
            hazard={viewSim ? viewRun!.hazard : hazard}
            frame={viewSim?.result.frames[frameIdx] ?? null}
            origin={meta.originLabel ? (viewRun ? viewRun.origin : origin) : null}
            safePoints={viewSim ? hourSafePoints : []}
            basemap={basemap}
            terrain3d={terrain3d}
            onMapClick={(ll) => {
              if (!meta.originLabel) return;
              if (terrain && lngLatToCell(terrain, ll) < 0) {
                setSimNote("Choose a starting point inside the loaded 12 km simulation area.");
                return;
              }
              setSimNote(null);
              setPlaying(false);
              setActiveId(null);
              setOrigin(ll);
            }}
            badge={viewRun ? { text: `Run ${viewRun.id} · ${formatT(t)}`, color: RUN_COLORS[viewRun.id % RUN_COLORS.length] } : null}
          />
          {computing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/50 text-sm font-medium backdrop-blur-sm">
              Running cellular automaton…
            </div>
          )}
          {viewSim && <Legend hazard={viewRun!.hazard} safePoints={hourSafePoints.length > 0} />}
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-800 px-4 py-3">
          {shownWeather && (
            <p className="text-xs text-sky-200" aria-live="polite">
              {shownWeather.date} · {shownWeather.timezone} · {String(Math.floor(viewRun ? t : 0)).padStart(2, "0")}:{String(Math.round(((viewRun ? t : 0) % 1) * 60)).padStart(2, "0")}
              {" · "}{shownConditions.windSpeed.toFixed(1)} km/h {compass(shownConditions.windDir)} wind
              {" · "}{shownConditions.humidity.toFixed(0)}% humidity
              {" · "}{shownConditions.rainfall.toFixed(1)} mm/h rain
            </p>
          )}
          <div className="flex flex-wrap items-center gap-2">
            <button className={btn} onClick={() => { setPlaying(false); setT(0); }} disabled={!viewRun} aria-label="Rewind to start">
              <Icon name="rewind" />
            </button>
            <button className={btn} onClick={() => stepBy(-1)} disabled={!viewRun}>
              <Icon name="back" /> 1h
            </button>
            <button
              className={`${btn} min-w-24 border-brand bg-brand text-white hover:bg-brand-hover`}
              onClick={togglePlay}
              disabled={!viewRun}
            >
              <Icon name={playing ? "pause" : "play"} /> {playing ? "Pause" : "Play"}
            </button>
            <button className={btn} onClick={() => stepBy(1)} disabled={!viewRun}>
              1h <Icon name="forward" />
            </button>
            <button
              className={btn}
              onClick={() => setSpeed((s) => SPEEDS[(SPEEDS.indexOf(s) + 1) % SPEEDS.length])}
              disabled={!viewRun}
              aria-label="Change playback speed"
            >
              <Icon name="fast" /> {speed}h/s
            </button>
            {viewRun && (
              <StatsPanel
                hazard={viewRun.hazard}
                title={`Run ${viewRun.id} · ${HAZARDS[viewRun.hazard].label} statistics`}
                stats={viewRun.stats}
                safePoints={viewRun.safePoints && hourSafePoints}
                hour={hour}
                status={runStatus}
                buttonClassName={btn}
              />
            )}
            <span className="ml-auto flex items-baseline gap-4 tabular-nums">
              {viewSim && (
                <span className="text-sm text-zinc-400">
                  {area.toFixed(2)} km² affected
                </span>
              )}
              <span className="text-lg font-semibold">{formatT(t)}</span>
            </span>
          </div>
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
            className="w-full accent-brand disabled:opacity-40"
            aria-label="Simulation time"
          />
          <div className="flex justify-between text-xs tabular-nums text-zinc-500">
            {[0, 6, 12, 18, 24].map((h) => (
              <span key={h}>{h}h</span>
            ))}
          </div>
        </div>
      </main>
    </div>
  );
}

function Legend({ hazard, safePoints }: { hazard: Hazard; safePoints: boolean }) {
  const items =
    hazard === "wildfire"
      ? [["#ff9a14", "Burning"], ["#37120c", "Burnt"]]
      : [["#2dd4bf", "River (within its banks)"], ["#5abeff", "Flood, shallow (0.15 m+)"], ["#0a46d7", "Flood, deep (2.5 m+)"]];
  return (
    <div className="pointer-events-none absolute bottom-8 right-3 z-10 flex flex-col gap-1 rounded-lg bg-zinc-950/80 px-3 py-2 text-xs text-zinc-200 backdrop-blur">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-2">
          <span className="size-3 rounded-sm" style={{ background: c }} />
          {l}
        </span>
      ))}
      {safePoints && (
        <span className="flex items-center gap-2">
          <span className="size-3 rounded-full border-2 border-white bg-emerald-500" />
          Safe point (evacuation centre)
        </span>
      )}
    </div>
  );
}
