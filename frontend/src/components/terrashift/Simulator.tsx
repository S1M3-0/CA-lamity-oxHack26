"use client";

import { useEffect, useRef, useState } from "react";
import {
  DEFAULT_PARAMS,
  FRAMES_PER_HOUR,
  HAZARDS,
  HOURS,
  PARAM_META,
  compass,
  describeParams,
  loadTerrain,
  runSeed,
  runSimulation,
  terrainKey,
  type Hazard,
  type LngLat,
  type Params,
  type SimResult,
  type Terrain,
} from "@/lib/sim";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";
import { Icon, type IconName } from "./Icon";
import { InfoTip } from "./InfoTip";
import { SimMap, type Basemap } from "./SimMap";

type Place = { name: string; center: LngLat };

type Run = {
  id: number;
  seed: number;
  hazard: Hazard;
  place: Place;
  terrain: Terrain;
  params: Params;
  origin: LngLat | null;
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

const btn =
  "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";

export function Simulator() {
  const [place, setPlace] = useState<Place>(PRESETS[0]);
  const [terrains, setTerrains] = useState<Record<string, Terrain>>({});
  const [terrainError, setTerrainError] = useState<string | null>(null);
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
  const nextId = useRef(1);

  const key = terrainKey(place.center);
  const terrain = terrains[key] ?? null;
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

  function changePlace(p: Place) {
    if (terrainKey(p.center) !== key) setOrigin(null);
    setPlace(p);
  }

  function generate() {
    if (!terrain || missingOrigin) return;
    const o = meta.originLabel ? origin : null;
    const seed = runSeed(hazard, terrain, params, o);
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
      const result = runSimulation(hazard, terrain, params, o);
      const run: Run = { id: nextId.current++, seed, hazard, place, terrain, params, origin: o, result };
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
                  <span><b className="text-zinc-100">Rainfall:</b> how hard it rains over the whole area. Some soaks in; the rest flows downhill and pools in low ground.</span>
                  <span><b className="text-zinc-100">Soil saturation:</b> how wet the ground already is. Wetter ground soaks up less, so more water floods.</span>
                </>
              )}
            </InfoTip>
          </h2>
          {meta.params.map((k) => {
            const pm = PARAM_META[k];
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
                <Icon name="target" className={`size-4 ${hazard === "flood" ? "text-sky-400" : "text-orange-400"}`} />
                <span>
                  <span className="flex items-center gap-2 font-medium">
                    {meta.originLabel}
                    <InfoTip label={meta.originLabel}>
                      {hazard === "wildfire" ? (
                        <>
                          <span>
                            Required. Click the map to place it. <b className="text-zinc-100">That point is exactly where
                            the fire starts</b>, and it spreads outward from there.
                          </span>
                          <span>Click somewhere else to move it, or press × to clear it.</span>
                        </>
                      ) : (
                        <>
                          <span>
                            Required. Click the map to place it. <b className="text-zinc-100">That point is exactly where
                            the river bursts its banks</b>, and the extra water pours out from there on top of the rain.
                          </span>
                          <span>Heavier rain means more water. Click somewhere else to move it, or press × to clear it.</span>
                        </>
                      )}
                    </InfoTip>
                  </span>
                  <span className={`block text-xs ${origin ? "text-zinc-500" : "text-amber-400"}`}>
                    {origin
                      ? `Starts at ${origin[1].toFixed(4)}, ${origin[0].toFixed(4)}`
                      : `Required · click the map where the ${hazard === "wildfire" ? "fire" : "breach"} starts`}
                  </span>
                </span>
              </span>
              {origin && (
                <button onClick={() => setOrigin(null)} className="text-zinc-500 hover:text-zinc-200" aria-label="Clear point">
                  <Icon name="x" />
                </button>
              )}
            </div>
          )}
          <button
            onClick={generate}
            disabled={!terrain || computing || missingOrigin}
            className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          >
            <Icon name="play" />
            {computing
              ? "Simulating 24 hours…"
              : missingOrigin
                ? `Set the ${meta.originLabel?.toLowerCase()} first`
                : "Generate simulation"}
          </button>
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
                  onClick={() => {
                    setRuns((old) => old.filter((x) => x.id !== r.id));
                    if (r.id === activeId) setActiveId(null);
                  }}
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
            terrain={terrain}
            hazard={viewRun?.hazard ?? null}
            frame={viewRun?.result.frames[frameIdx] ?? null}
            origin={meta.originLabel ? (viewRun ? viewRun.origin : origin) : null}
            basemap={basemap}
            terrain3d={terrain3d}
            onMapClick={(ll) => meta.originLabel && setOrigin(ll)}
            badge={viewRun ? { text: `Run ${viewRun.id} · ${formatT(t)}`, color: RUN_COLORS[viewRun.id % RUN_COLORS.length] } : null}
          />
          {computing && (
            <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/50 text-sm font-medium backdrop-blur-sm">
              Running cellular automaton…
            </div>
          )}
          {viewRun && <Legend hazard={viewRun.hazard} />}
        </div>

        <div className="flex flex-col gap-2 border-t border-zinc-800 px-4 py-3">
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
            <span className="ml-auto flex items-baseline gap-4 tabular-nums">
              {viewRun && (
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

function Legend({ hazard }: { hazard: Hazard }) {
  const items =
    hazard === "wildfire"
      ? [["#ff9a14", "Burning"], ["#37120c", "Burnt"]]
      : [["#5abeff", "Shallow (0.15 m+)"], ["#0a46d7", "Deep (2.5 m+)"]];
  return (
    <div className="pointer-events-none absolute bottom-8 right-3 z-10 flex flex-col gap-1 rounded-lg bg-zinc-950/80 px-3 py-2 text-xs text-zinc-200 backdrop-blur">
      {items.map(([c, l]) => (
        <span key={l} className="flex items-center gap-2">
          <span className="size-3 rounded-sm" style={{ background: c }} />
          {l}
        </span>
      ))}
    </div>
  );
}
