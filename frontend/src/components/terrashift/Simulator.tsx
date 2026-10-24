"use client";

import { useEffect, useRef, useState } from "react";
import { api, decodeFrames, type Controls, type DecodedSimulation, type GridMetadata, type Hazard, type LngLat, type PlaceMetadata } from "@/lib/api";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";
import { Icon, type IconName } from "./Icon";
import { InfoTip } from "./InfoTip";
import { SimMap, type Basemap } from "./SimMap";

const PRESETS: PlaceMetadata[] = [
  { slug: "fort-mcmurray", name: "Fort McMurray", center: [-111.38, 56.726], cityAoi: null, cityAoiSource: null, coverage: null, grids: { wildfire: null, flood: null } },
  { slug: "oxford", name: "Oxford", center: [-1.255, 51.745], cityAoi: null, cityAoiSource: null, coverage: null, grids: { wildfire: null, flood: null } },
  { slug: "brisbane", name: "Brisbane", center: [153.025, -27.47], cityAoi: null, cityAoiSource: null, coverage: null, grids: { wildfire: null, flood: null } },
  { slug: "los-angeles", name: "Los Angeles", center: [-118.2437, 34.0522], cityAoi: null, cityAoiSource: null, coverage: null, grids: { wildfire: null, flood: null } },
];
const HAZARD_META: Record<Hazard, { label: string; icon: IconName; origin: string; description: string; controls: (keyof Controls)[] }> = {
  wildfire: { label: "Wildfire", icon: "flame", origin: "Ignition point", description: "Illustrative spread using prepared elevation and a Sentinel-2 fuel proxy.", controls: ["windSpeed", "windDir", "humidity"] },
  flood: { label: "Flood", icon: "drop", origin: "Breach point", description: "Illustrative rain and breach flow over prepared elevation.", controls: ["rainfall", "saturation"] },
};
const CONTROL_META: Record<keyof Controls, { label: string; min: number; max: number; step: number; unit: string }> = {
  windSpeed: { label: "Wind speed", min: 0, max: 100, step: 5, unit: "km/h" },
  windDir: { label: "Wind direction (from)", min: 0, max: 355, step: 5, unit: "°" },
  humidity: { label: "Relative humidity", min: 0, max: 100, step: 5, unit: "%" },
  rainfall: { label: "Rainfall intensity", min: 0, max: 100, step: 5, unit: "mm/h" },
  saturation: { label: "Soil saturation", min: 0, max: 100, step: 5, unit: "%" },
};
const DEFAULT_CONTROLS: Controls = { windSpeed: 35, windDir: 45, humidity: 30, rainfall: 50, saturation: 40 };
const RUN_COLORS = ["#f97316", "#38bdf8", "#a3e635", "#e879f9", "#facc15", "#f87171"];
const SPEEDS = [0.5, 1, 2, 4];
const HOURS = 24;
const FRAMES_PER_HOUR = 4;
const MAX_RUNS = 6;
const buttonClass = "inline-flex items-center justify-center gap-1.5 rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm font-medium text-zinc-200 hover:bg-zinc-800 disabled:opacity-40";

type Run = { id: number; cacheKey: string; place: PlaceMetadata; grid: GridMetadata; hazard: Hazard; controls: Controls; clickedOrigin: LngLat; result: DecodedSimulation };

function formatT(hours: number) {
  const f = Math.round(hours * FRAMES_PER_HOUR);
  return `T+${Math.floor(f / FRAMES_PER_HOUR)}h ${String((f % FRAMES_PER_HOUR) * 15).padStart(2, "0")}m`;
}
function describe(hazard: Hazard, c: Controls) {
  return hazard === "wildfire" ? `${c.windSpeed} km/h wind · ${c.humidity}% RH` : `${c.rainfall} mm/h rain · ${c.saturation}% soil`;
}
function sourceDates(grid: GridMetadata) {
  return Array.isArray(grid.sourceDates) ? grid.sourceDates.join(", ") : grid.sourceDates;
}

export function Simulator() {
  const [places, setPlaces] = useState(PRESETS);
  const [placesError, setPlacesError] = useState<string | null>(null);
  const [placeSlug, setPlaceSlug] = useState(PRESETS[0].slug);
  const [hazard, setHazard] = useState<Hazard>("wildfire");
  const [grid, setGrid] = useState<GridMetadata | null>(null);
  const [gridError, setGridError] = useState<string | null>(null);
  const [gridLoading, setGridLoading] = useState(true);
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);
  const [origin, setOrigin] = useState<LngLat | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [activeId, setActiveId] = useState<number | null>(null);
  const [computing, setComputing] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [t, setT] = useState(0);
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const [basemap, setBasemap] = useState<Basemap>("satellite");
  const [terrain3d, setTerrain3d] = useState(false);
  const nextId = useRef(1);
  const place = places.find((p) => p.slug === placeSlug) ?? PRESETS.find((p) => p.slug === placeSlug) ?? PRESETS[0];
  const activeRun = runs.find((r) => r.id === activeId) ?? null;
  const viewRun = activeRun?.place.slug === placeSlug ? activeRun : null;
  const frameIndex = Math.max(0, Math.min(96, Math.round(t * FRAMES_PER_HOUR)));
  const meta = HAZARD_META[hazard];

  useEffect(() => {
    const controller = new AbortController();
    api.places(controller.signal).then(({ places: listed }) => {
      if (!controller.signal.aborted) { setPlaces(listed); setPlacesError(null); }
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) setPlacesError(e instanceof Error ? e.message : "Place service unavailable");
    });
    return () => controller.abort();
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    setGrid(null);
    setGridError(null);
    setGridLoading(true);
    api.grid(placeSlug, hazard, controller.signal).then((loaded) => {
      if (!controller.signal.aborted) setGrid(loaded);
    }).catch((e: unknown) => {
      if (!controller.signal.aborted) setGridError(e instanceof Error ? e.message : "Prepared grid unavailable");
    }).finally(() => { if (!controller.signal.aborted) setGridLoading(false); });
    return () => controller.abort();
  }, [placeSlug, hazard]);

  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = (now - last) / 1000;
      last = now;
      setT((v) => Math.min(HOURS, v + dt * speed));
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing, speed]);
  useEffect(() => { if (playing && t >= HOURS) setPlaying(false); }, [playing, t]);

  function changePlace(slug: string) {
    setPlaceSlug(slug);
    setOrigin(null);
    setRunError(null);
    setPlaying(false);
  }

  async function generate() {
    if (!grid || !origin || computing) return;
    const cacheKey = JSON.stringify([placeSlug, hazard, origin, controls, grid.id, grid.version, grid.modelVersion]);
    const cached = runs.find((r) => r.cacheKey === cacheKey);
    if (cached) { setActiveId(cached.id); setT(0); setPlaying(true); setRunError(null); return; }
    setComputing(true);
    setPlaying(false);
    setRunError(null);
    try {
      const response = await api.simulate({ place: placeSlug, hazard, origin: { longitude: origin[0], latitude: origin[1] }, controls });
      if (response.gridId !== grid.id || response.gridVersion !== grid.version || response.modelVersion !== grid.modelVersion) {
        throw new Error("The published grid or model changed during this run. Reload the grid and try again.");
      }
      const result = await decodeFrames(response);
      const run: Run = { id: nextId.current++, cacheKey, place, grid, hazard, controls: { ...controls }, clickedOrigin: origin, result };
      setRuns((old) => [run, ...old].slice(0, MAX_RUNS));
      setActiveId(run.id);
      setT(0);
      setPlaying(true);
    } catch (e) {
      setRunError(e instanceof Error ? e.message : "Simulation failed");
    } finally { setComputing(false); }
  }

  function viewScenario(run: Run) {
    setPlaceSlug(run.place.slug);
    setHazard(run.hazard);
    setOrigin(run.clickedOrigin);
    setActiveId(run.id);
    setT(0);
    setPlaying(false);
  }
  function loadSettings(run: Run) {
    viewScenario(run);
    setControls(run.controls);
    setOrigin(run.clickedOrigin);
  }
  function stepBy(hours: number) {
    setPlaying(false);
    setT((v) => Math.max(0, Math.min(HOURS, Math.round((v + hours) * FRAMES_PER_HOUR) / FRAMES_PER_HOUR)));
  }

  const unavailable = placesError || gridError;
  const displayedGrid = viewRun?.grid ?? grid;
  const area = viewRun?.result.areaKm2[frameIndex] ?? 0;

  return (
    <div className="min-h-screen bg-zinc-950 text-zinc-100 lg:flex">
      <aside className="flex flex-col gap-6 border-zinc-800 p-5 lg:sticky lg:top-0 lg:h-screen lg:w-[380px] lg:shrink-0 lg:overflow-y-auto lg:border-r">
        <header>
          <h1 className="text-2xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-sm text-zinc-400">{APP_TAGLINE}</p>
          <p className="mt-2 text-xs text-amber-300">Illustrative scenarios only · not operational hazard forecasts</p>
        </header>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Location</h2>
          <div className="grid grid-cols-2 gap-1.5">
            {places.map((p) => (
              <button key={p.slug} onClick={() => changePlace(p.slug)} className={`rounded-lg border px-2 py-2 text-sm ${placeSlug === p.slug ? "border-brand bg-brand/20 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}>
                {p.name}
              </button>
            ))}
          </div>
          <div className="rounded-lg border border-zinc-800 bg-zinc-900/70 p-3 text-xs text-zinc-300">
            <strong className="text-zinc-100">Central-area prototype · 12 × 12 km</strong>
            <p className="mt-1">200 × 200 cells at 60 m. The outline shows the grid, not citywide coverage.</p>
            {place.coverage && <p className="mt-1">Grid intersects {place.coverage.intersectionKm2.toFixed(1)} km² of the mapped city area ({place.coverage.percent.toFixed(1)}%).</p>}
            {place.cityAoiSource && <p className="mt-1">City boundary: {place.cityAoiSource}</p>}
            {!place.cityAoi && <p className="mt-1 text-amber-300">City boundary unavailable; coverage percentage cannot be shown.</p>}
          </div>
        </section>

        <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Hazard</h2>
          <div className="grid grid-cols-2 gap-1.5">
            {(["wildfire", "flood"] as Hazard[]).map((h) => (
              <button key={h} onClick={() => { setHazard(h); setRunError(null); setPlaying(false); }} className={`inline-flex items-center justify-center gap-2 rounded-lg border px-2 py-2 text-sm ${hazard === h ? "border-brand bg-brand/20 text-white" : "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"}`}>
                <Icon name={HAZARD_META[h].icon} className="size-5" />{HAZARD_META[h].label}
              </button>
            ))}
          </div>
          <p className="text-xs text-zinc-500">{meta.description}</p>
          {gridLoading && <p className="text-xs text-zinc-400" role="status">Loading published grid metadata…</p>}
          {unavailable && <p className="rounded-md border border-red-800 bg-red-950/50 p-2 text-xs text-red-200" role="alert">Prepared grid unavailable: {unavailable}</p>}
          {grid && !unavailable && <div className="rounded-md border border-zinc-800 bg-zinc-900/70 p-2 text-xs text-zinc-400">
            <p>Grid {grid.version} · model {grid.modelVersion} · {grid.processingVersion}</p>
            <p>{grid.crs} · {grid.width} × {grid.height} · {grid.cellSizeM} m cells</p>
            <p>Sentinel-2 dates: {sourceDates(grid) || "not recorded"}</p>
            {typeof grid.quality.demSourceDates === "string" && <p>Elevation source dates: {grid.quality.demSourceDates}</p>}
            {hazard === "wildfire" && <p>Vegetation input: {grid.fuelLabel || "fuel proxy"}; not a validated fuel map.</p>}
          </div>}
        </section>

        <section className="flex flex-col gap-4">
          <h2 className="flex items-center gap-2 text-xs font-semibold uppercase tracking-wider text-zinc-500">Environmental conditions
            <InfoTip label="environmental conditions">Adjust the scenario inputs, then generate a new 24-hour run.</InfoTip>
          </h2>
          {meta.controls.map((key) => {
            const m = CONTROL_META[key];
            return <label key={key} className="flex flex-col gap-1.5">
              <span className="flex items-center justify-between text-sm"><span className="font-medium">{m.label}</span><span className="tabular-nums text-zinc-300">{controls[key]}{m.unit}</span></span>
              <input type="range" min={m.min} max={m.max} step={m.step} value={controls[key]} onChange={(e) => setControls((c) => ({ ...c, [key]: Number(e.target.value) }))} className="w-full accent-brand" />
            </label>;
          })}
          <div className="flex items-center justify-between gap-2 rounded-lg border border-zinc-800 bg-zinc-900 px-3 py-2 text-sm">
            <span><span className="flex items-center gap-2 font-medium"><Icon name="target" className={`size-4 ${hazard === "flood" ? "text-sky-400" : "text-orange-400"}`} />{meta.origin}</span>
              <span className={`block text-xs ${origin ? "text-zinc-500" : "text-amber-400"}`}>{origin ? `${origin[1].toFixed(4)}, ${origin[0].toFixed(4)}` : "Required · click inside the grid"}</span>
            </span>
            {origin && <button onClick={() => setOrigin(null)} className="text-zinc-500 hover:text-zinc-200" aria-label="Clear point"><Icon name="x" /></button>}
          </div>
          {runError && <p className="rounded-md border border-red-800 bg-red-950/50 p-2 text-xs text-red-200" role="alert">{runError}</p>}
          <button onClick={generate} disabled={!grid || !!unavailable || computing || !origin} className="inline-flex items-center justify-center gap-2 rounded-lg bg-brand px-4 py-2.5 font-medium text-white hover:bg-brand-hover disabled:opacity-50">
            <Icon name="play" />{computing ? "Generating 97 frames…" : !origin ? `Set the ${meta.origin.toLowerCase()} first` : "Generate simulation"}
          </button>
        </section>

        {runs.length > 0 && <section className="flex flex-col gap-2">
          <h2 className="text-xs font-semibold uppercase tracking-wider text-zinc-500">Scenarios · browser memory ({runs.length}/{MAX_RUNS})</h2>
          {runs.map((run) => <div key={run.id} className={`flex items-center gap-2 rounded-lg border px-3 py-2 ${run.id === activeId ? "border-zinc-500 bg-zinc-800/70" : "border-zinc-800 bg-zinc-900"}`}>
            <button onClick={() => viewScenario(run)} className="flex min-w-0 flex-1 items-center gap-2 text-left"><span className="size-2.5 shrink-0 rounded-full" style={{ background: RUN_COLORS[run.id % RUN_COLORS.length] }} /><span className="min-w-0"><span className="block truncate text-sm font-medium">Run {run.id} · {HAZARD_META[run.hazard].label}</span><span className="block truncate text-xs text-zinc-500">{run.place.name} · {describe(run.hazard, run.controls)}</span></span></button>
            <button onClick={() => loadSettings(run)} className="shrink-0 rounded-md border border-zinc-700 px-2 py-1 text-xs hover:bg-zinc-700">Load</button>
            <button onClick={() => { setRuns((old) => old.filter((x) => x.id !== run.id)); if (run.id === activeId) setActiveId(null); }} className="shrink-0 text-zinc-500 hover:text-zinc-200" aria-label={`Delete run ${run.id}`}><Icon name="x" /></button>
          </div>)}
        </section>}
      </aside>

      <main className="flex min-w-0 flex-1 flex-col lg:h-screen">
        <div className="flex flex-wrap items-center gap-2 border-b border-zinc-800 px-4 py-2 text-sm">
          <div className="inline-flex overflow-hidden rounded-lg border border-zinc-700">{(["satellite", "streets"] as Basemap[]).map((b) => <button key={b} onClick={() => setBasemap(b)} className={`px-3 py-1.5 capitalize ${basemap === b ? "bg-zinc-700 text-white" : "text-zinc-400 hover:bg-zinc-800"}`}>{b}</button>)}</div>
          <label className="inline-flex items-center gap-2 text-zinc-300"><input type="checkbox" checked={terrain3d} onChange={(e) => setTerrain3d(e.target.checked)} className="accent-brand" />3D basemap</label>
          <span className="ml-auto text-zinc-400">{viewRun ? `Run ${viewRun.id} · ${HAZARD_META[viewRun.hazard].label} · ${describe(viewRun.hazard, viewRun.controls)}` : "Set conditions and press Generate."}</span>
        </div>
        <div className="relative h-[60vh] lg:h-auto lg:flex-1">
          <SimMap center={place.center} cityAoi={place.cityAoi} grid={displayedGrid} hazard={viewRun?.hazard ?? hazard} frame={viewRun?.result.frames[frameIndex] ?? null} origin={origin} basemap={basemap} terrain3d={terrain3d} onMapClick={setOrigin} badge={viewRun ? { text: `Run ${viewRun.id} · ${formatT(t)}`, color: RUN_COLORS[viewRun.id % RUN_COLORS.length] } : null} />
          {computing && <div className="absolute inset-0 z-10 flex items-center justify-center bg-zinc-950/50 text-sm font-medium backdrop-blur-sm" role="status">FastAPI is generating the scenario…</div>}
          {viewRun && <Legend hazard={viewRun.hazard} />}
        </div>
        <div className="flex flex-col gap-2 border-t border-zinc-800 px-4 py-3">
          <div className="flex flex-wrap items-center gap-2">
            <button className={buttonClass} onClick={() => { setPlaying(false); setT(0); }} disabled={!viewRun} aria-label="Rewind to start"><Icon name="rewind" /></button>
            <button className={buttonClass} onClick={() => stepBy(-1)} disabled={!viewRun}><Icon name="back" /> 1h</button>
            <button className={`${buttonClass} min-w-24 border-brand bg-brand text-white hover:bg-brand-hover`} onClick={() => { if (t >= HOURS) setT(0); setPlaying((v) => !v); }} disabled={!viewRun}><Icon name={playing ? "pause" : "play"} /> {playing ? "Pause" : "Play"}</button>
            <button className={buttonClass} onClick={() => stepBy(1)} disabled={!viewRun}>1h <Icon name="forward" /></button>
            <button className={buttonClass} onClick={() => setSpeed((v) => SPEEDS[(SPEEDS.indexOf(v) + 1) % SPEEDS.length])} disabled={!viewRun} aria-label="Change playback speed"><Icon name="fast" /> {speed}h/s</button>
            <span className="ml-auto flex items-baseline gap-4 tabular-nums">{viewRun && <span className="text-sm text-zinc-400">{area.toFixed(2)} km² affected</span>}<span className="text-lg font-semibold">{formatT(t)}</span></span>
          </div>
          <input type="range" min={0} max={HOURS} step={1 / FRAMES_PER_HOUR} value={t} onChange={(e) => { setPlaying(false); setT(Number(e.target.value)); }} disabled={!viewRun} className="w-full accent-brand disabled:opacity-40" aria-label="Simulation time" />
          <div className="flex justify-between text-xs tabular-nums text-zinc-500">{[0, 6, 12, 18, 24].map((h) => <span key={h}>{h}h</span>)}</div>
        </div>
      </main>
    </div>
  );
}

function Legend({ hazard }: { hazard: Hazard }) {
  const items = hazard === "wildfire" ? [["#ff9a14", "Burning"], ["#37120c", "Burnt"]] : [["#5abeff", "Shallow (0.15 m+)"], ["#0a46d7", "Deep (2.5 m+)"]];
  return <div className="pointer-events-none absolute bottom-8 right-3 z-10 flex flex-col gap-1 rounded-lg bg-zinc-950/80 px-3 py-2 text-xs text-zinc-200 backdrop-blur">{items.map(([color, label]) => <span key={label} className="flex items-center gap-2"><span className="size-3 rounded-sm" style={{ background: color }} />{label}</span>)}</div>;
}
