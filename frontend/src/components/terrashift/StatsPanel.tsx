"use client";

import { useEffect, useRef, useState } from "react";
import type { RunStats, SafePoint } from "@/lib/api";
import { compass, type Hazard } from "@/lib/sim";
import { Icon } from "./Icon";

const WIDTH = 344;
const GAP = 8;
/** One series per chart; both steps pass lightness and 3:1 contrast on the zinc-900 panel. */
const BAR_COLOR: Record<Hazard, string> = { wildfire: "#ea580c", flood: "#0284c7" };

type Props = {
  hazard: Hazard;
  title: string;
  stats: RunStats | null;
  /** safe points for the hour being shown */
  safePoints: SafePoint[] | null;
  hour: number;
  /** why stats or safe points aren't available yet (saving, not configured, …) */
  status: string | null;
  buttonClassName: string;
};

const fmt = (v: number) => (v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2));

/** "Statistics" button that opens a panel of run statistics and the hour's evacuation centres, read from Tiger Data. */
export function StatsPanel(props: Props) {
  const [pos, setPos] = useState<{ right: number; bottom: number } | null>(null);
  const ref = useRef<HTMLDivElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const open = pos !== null;

  function toggle() {
    if (open) return setPos(null);
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      right: Math.max(8, Math.min(window.innerWidth - r.right, window.innerWidth - WIDTH - 8)),
      bottom: window.innerHeight - r.top + GAP,
    });
  }

  useEffect(() => {
    if (!open) return;
    const close = () => setPos(null);
    const onDown = (e: PointerEvent) => !ref.current?.contains(e.target as Node) && close();
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && close();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("resize", close);
    };
  }, [open]);

  return (
    <div ref={ref} className="inline-flex">
      <button ref={btnRef} type="button" className={props.buttonClassName} onClick={toggle} aria-expanded={open}>
        <Icon name="chart" /> Statistics
      </button>
      {pos && (
        <div
          role="dialog"
          aria-label={props.title}
          style={{ right: pos.right, bottom: pos.bottom, width: WIDTH }}
          className="fixed z-50 flex max-h-[70vh] flex-col gap-3 overflow-y-auto rounded-lg border border-zinc-600/60 bg-zinc-900/95 p-3 text-xs text-zinc-200 shadow-xl backdrop-blur-sm"
        >
          <div className="flex items-baseline justify-between gap-2">
            <span className="text-sm font-semibold text-zinc-100">{props.title}</span>
            <span className="text-zinc-500">Tiger Data</span>
          </div>
          {props.stats ? <StatsBody hazard={props.hazard} stats={props.stats} /> : (
            <p className="text-zinc-400">{props.status ?? "Loading statistics…"}</p>
          )}
          <SafePointList points={props.safePoints} hour={props.hour} status={props.status} />
        </div>
      )}
    </div>
  );
}

function Tile({ label, value, unit, note }: { label: string; value: number | undefined; unit: string; note?: string }) {
  return (
    <div className="rounded-md bg-zinc-800/70 px-2.5 py-2">
      <div className="text-zinc-400">{label}</div>
      <div className="mt-0.5 text-base font-semibold tabular-nums text-zinc-100">
        {value === undefined ? "–" : fmt(value)} <span className="text-xs font-normal text-zinc-400">{unit}</span>
      </div>
      {note && <div className="text-zinc-500">{note}</div>}
    </div>
  );
}

function StatsBody({ hazard, stats }: { hazard: Hazard; stats: RunStats }) {
  const s = stats.summary;
  const at = (h: number | undefined) => (h === undefined ? undefined : `at T+${h}h`);
  const tiles =
    hazard === "wildfire" ? (
      <>
        <Tile label="Total burned" value={s.final_area_km2} unit="km²" note="after 24 h" />
        <Tile label="Fastest spread" value={s.peak_growth_km2} unit="km²/h" note={at(s.peak_growth_hour)} />
        <Tile label="Average spread" value={s.mean_growth_km2} unit="km²/h" note={`over ${s.hours_spreading ?? 0} h spreading`} />
        <Tile label="Peak burning" value={s.peak_active_km2} unit="km²" note={at(s.peak_active_hour)} />
      </>
    ) : (
      <>
        <Tile label="Total rainfall" value={s.total_rain_mm} unit="mm" note={s.hourly_weather ? "Hourly weather over 24 h" : `${s.rain_rate_mm_h ?? 0} mm/h average over ${s.storm_hours ?? 24} h`} />
        <Tile label="Peak flooded" value={s.peak_area_km2} unit="km²" note={at(s.peak_area_hour)} />
        <Tile label="Peak 1 m+ deep" value={s.peak_active_km2} unit="km²" note={at(s.peak_active_hour)} />
        <Tile label="Flooded at 24 h" value={s.final_area_km2} unit="km²" />
      </>
    );
  const series = stats.hourly
    .filter((r) => r.hour >= 1)
    .map((r) => ({ hour: r.hour, value: hazard === "wildfire" ? r.growth_km2 : r.area_km2 }));
  return (
    <>
      <div className="grid grid-cols-2 gap-1.5">{tiles}</div>
      <HourBars
        title={hazard === "wildfire" ? "Area burned each hour" : "Area flooded at each hour"}
        unit="km²"
        color={BAR_COLOR[hazard]}
        data={series}
      />
    </>
  );
}

/** Single-series hourly bar chart: thin bars, rounded tops, hover for the value. */
function HourBars({ title, unit, color, data }: { title: string; unit: string; color: string; data: { hour: number; value: number }[] }) {
  const [hover, setHover] = useState<number | null>(null);
  const max = Math.max(...data.map((d) => d.value), 0);
  const shown = hover !== null ? data[hover] : null;
  return (
    <figure className="flex flex-col gap-1.5">
      <figcaption className="flex items-baseline justify-between gap-2">
        <span className="font-medium text-zinc-200">{title}</span>
        <span className="tabular-nums text-zinc-400">
          {shown ? `T+${shown.hour}h · ${fmt(shown.value)} ${unit}` : `max ${fmt(max)} ${unit}`}
        </span>
      </figcaption>
      <div className="flex h-24 items-end gap-[2px] border-b border-zinc-700" onPointerLeave={() => setHover(null)}>
        {data.map((d, i) => (
          <div
            key={d.hour}
            className="flex h-full flex-1 items-end"
            onPointerEnter={() => setHover(i)}
            aria-hidden="true"
          >
            <div
              className="w-full rounded-t-[4px]"
              style={{
                height: `${max > 0 ? Math.max((d.value / max) * 100, d.value > 0 ? 2 : 0) : 0}%`,
                background: color,
                opacity: hover === null || hover === i ? 1 : 0.45,
              }}
            />
          </div>
        ))}
      </div>
      <div className="flex justify-between tabular-nums text-zinc-500">
        {[1, 6, 12, 18, 24].map((h) => (
          <span key={h}>{h}h</span>
        ))}
      </div>
      <table className="sr-only">
        <caption>{title}</caption>
        <tbody>
          {data.map((d) => (
            <tr key={d.hour}>
              <th scope="row">T+{d.hour}h</th>
              <td>
                {fmt(d.value)} {unit}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

function SafePointList({ points, hour, status }: { points: SafePoint[] | null; hour: number; status: string | null }) {
  return (
    <div className="flex flex-col gap-1.5 border-t border-zinc-700/70 pt-2.5">
      <div className="flex items-center gap-2 font-medium text-zinc-200">
        <span className="size-3 rounded-full border-2 border-white bg-emerald-500" aria-hidden="true" />
        Evacuation centres · T+{hour}h
      </div>
      {points === null ? (
        <p className="text-zinc-400">{status ?? "Finding evacuation centres…"}</p>
      ) : points.length === 0 ? (
        <p className="text-zinc-400">No centre within 15 km stays clear of this run.</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {points.map((p) => (
            <li key={p.sector} className="flex items-baseline gap-2">
              <span className="w-6 shrink-0 font-semibold text-zinc-400">{compass(p.sector * 45)}</span>
              <span className="min-w-0 flex-1 truncate text-zinc-100" title={p.name}>
                {p.name}
              </span>
              <span className="shrink-0 tabular-nums text-zinc-400">{(p.distance_m / 1000).toFixed(1)} km</span>
            </li>
          ))}
        </ul>
      )}
      <p className="text-zinc-500">
        Nearest school, college, community centre or shelter in each direction that the hazard never comes near
        during the run. Illustrative only; follow official evacuation orders.
      </p>
    </div>
  );
}
