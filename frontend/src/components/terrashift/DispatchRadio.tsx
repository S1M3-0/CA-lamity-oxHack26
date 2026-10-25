"use client";

import { useEffect, useRef, useState } from "react";
import { summarizeRun, templateBriefing, type BriefingInput } from "@/lib/sim/briefing";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";

type Briefing = { text: string; writer: "Gemini" | "built-in"; audioUrl?: string };
type Services = { gemini: boolean; elevenlabs: boolean };

const JSON_POST = { method: "POST", headers: { "Content-Type": "application/json" } };

// Which keys the backend has (asked once), so unconfigured services are never called.
let services: Promise<Services> | null = null;
const getServices = () =>
  (services ??= fetch("/api/dispatch/status")
    .then((r) => (r.ok ? r.json() : { gemini: false, elevenlabs: false }))
    .catch(() => ({ gemini: false, elevenlabs: false })));

/** Languages the briefing can be written and spoken in; keep in sync with LANGUAGES in backend dispatch.py. */
const LANGUAGES = [
  { name: "English", label: "English", speech: "en-US" },
  { name: "Spanish", label: "Español", speech: "es-ES" },
  { name: "Polish", label: "Polski", speech: "pl-PL" },
  { name: "Arabic", label: "العربية", speech: "ar-SA" },
  { name: "Chinese", label: "中文", speech: "zh-CN" },
  { name: "Korean", label: "한국어", speech: "ko-KR" },
] as const;
type Language = (typeof LANGUAGES)[number]["name"];

// Per run and language, so replaying a run doesn't spend API credits again.
const cache = new Map<string, Briefing>();
// Remembered across runs, so the next run's briefing comes in the same language.
let lastLanguage: Language = "English";

async function writeBriefing(input: BriefingInput, language: Language): Promise<Briefing> {
  const facts = summarizeRun(input);
  if ((await getServices()).gemini) {
    try {
      const res = await fetch("/api/dispatch/briefing", { ...JSON_POST, body: JSON.stringify({ facts, language }) });
      if (res.ok) return { text: (await res.json()).text, writer: "Gemini" };
    } catch {}
  }
  return { text: templateBriefing(facts), writer: "built-in" };
}

async function elevenLabsAudio(text: string): Promise<string | undefined> {
  if (!(await getServices()).elevenlabs) return undefined;
  try {
    const res = await fetch("/api/dispatch/speech", { ...JSON_POST, body: JSON.stringify({ text }) });
    if (res.ok) return URL.createObjectURL(await res.blob());
  } catch {}
  return undefined;
}

/** Radio briefing for one run. Mount with key={run.id}; unmounting stops the audio. */
export function DispatchRadio({ runId, input }: { runId: number; input: BriefingInput }) {
  const [language, setLanguage] = useState<Language>(lastLanguage);
  const key = `${runId}:${language}`;
  const [briefing, setBriefing] = useState<Briefing | null>(cache.get(key) ?? null);
  const [state, setState] = useState<"idle" | "writing" | "speaking">("idle");
  const [voice, setVoice] = useState<"ElevenLabs" | "browser voice" | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  function stop() {
    stopRef.current?.();
    stopRef.current = null;
    setState("idle");
  }

  function changeLanguage(l: Language) {
    stop();
    lastLanguage = l;
    setLanguage(l);
    setBriefing(cache.get(`${runId}:${l}`) ?? null);
    setVoice(null);
  }

  async function play() {
    setState("writing");
    let b = cache.get(key);
    if (!b) {
      b = await writeBriefing(input, language);
      b.audioUrl = await elevenLabsAudio(b.text);
      cache.set(key, b);
    }
    setBriefing(b);
    setState("speaking");

    if (b.audioUrl) {
      const audio = new Audio(b.audioUrl);
      audio.onended = stop;
      stopRef.current = () => audio.pause();
      try {
        await audio.play();
        setVoice("ElevenLabs");
        return;
      } catch {}
    }
    if (!("speechSynthesis" in window)) return setState("idle");
    const u = new SpeechSynthesisUtterance(b.text);
    // the built-in fallback briefing is always English
    u.lang = b.writer === "Gemini" ? LANGUAGES.find((l) => l.name === language)!.speech : "en-US";
    u.rate = 1.05;
    u.onend = u.onerror = () => setState("idle");
    stopRef.current = () => speechSynthesis.cancel();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setVoice("browser voice");
  }

  return (
    <section className="flex flex-col gap-2.5 rounded-xl border border-white/[0.07] bg-white/[0.02] p-3">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          Dispatch radio
          <InfoTip label="dispatch radio">
            <span>
              Turns the simulation (spread, the real fire stations it reaches, the places to evacuate first) into the briefing a
              dispatcher would radio to every unit.
            </span>
            <span>Written by Gemini, voiced by ElevenLabs. Pick a language: warnings only work if people understand them.</span>
          </InfoTip>
        </h2>
        <select
          value={language}
          onChange={(e) => changeLanguage(e.target.value as Language)}
          aria-label="Briefing language"
          className="rounded-md border border-white/10 bg-transparent px-1.5 py-0.5 text-[12px] text-zinc-300"
        >
          {LANGUAGES.map((l) => (
            <option key={l.name} value={l.name} className="bg-zinc-900">
              {l.label}
            </option>
          ))}
        </select>
      </div>
      <button
        onClick={state === "speaking" ? stop : play}
        disabled={state === "writing"}
        className={`inline-flex items-center justify-center gap-2 rounded-lg px-3 py-2 text-[13px] font-semibold disabled:opacity-50 ${
          state === "speaking" ? "bg-white text-zinc-950" : "bg-white/[0.08] text-zinc-100 hover:bg-white/[0.12]"
        }`}
      >
        {state === "speaking" ? (
          <span className="flex items-end gap-0.5" aria-hidden="true">
            {[0, 1, 2, 3].map((b) => (
              <span key={b} className="w-0.5 animate-pulse bg-zinc-950" style={{ height: 6 + ((b * 5) % 9), animationDelay: `${b * 120}ms` }} />
            ))}
          </span>
        ) : (
          <Icon name="radio" />
        )}
        {state === "writing" ? "Writing briefing…" : state === "speaking" ? "Stop briefing" : "Play radio briefing"}
      </button>
      {briefing && (
        <div>
          <p dir="auto" className="max-h-32 overflow-y-auto text-[12px] leading-relaxed text-zinc-300">
            {briefing.text}
          </p>
          <p className="mt-1.5 font-mono text-[10px] uppercase tracking-wider text-zinc-600">
            {briefing.writer === "Gemini"
              ? `Gemini${language === "English" ? "" : ` · ${language}`}`
              : `Built-in briefing${language === "English" ? "" : " · English only"}`}
            {voice && ` · ${voice}`}
          </p>
        </div>
      )}
    </section>
  );
}
