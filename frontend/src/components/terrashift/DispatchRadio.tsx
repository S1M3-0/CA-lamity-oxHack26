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

// Per run id, so replaying a run doesn't spend API credits again.
const cache = new Map<number, Briefing>();

async function writeBriefing(input: BriefingInput): Promise<Briefing> {
  const facts = summarizeRun(input);
  if ((await getServices()).gemini) {
    try {
      const res = await fetch("/api/dispatch/briefing", { ...JSON_POST, body: JSON.stringify({ facts }) });
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
  const [briefing, setBriefing] = useState<Briefing | null>(cache.get(runId) ?? null);
  const [state, setState] = useState<"idle" | "writing" | "speaking">("idle");
  const [voice, setVoice] = useState<"ElevenLabs" | "browser voice" | null>(null);
  const stopRef = useRef<(() => void) | null>(null);

  useEffect(() => () => stopRef.current?.(), []);

  function stop() {
    stopRef.current?.();
    stopRef.current = null;
    setState("idle");
  }

  async function play() {
    setState("writing");
    let b = cache.get(runId);
    if (!b) {
      b = await writeBriefing(input);
      b.audioUrl = await elevenLabsAudio(b.text);
      cache.set(runId, b);
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
    u.lang = "en-US";
    u.rate = 1.05;
    u.onend = u.onerror = () => setState("idle");
    stopRef.current = () => speechSynthesis.cancel();
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
    setVoice("browser voice");
  }

  return (
    <div className="flex items-start gap-3 rounded-lg border border-amber-500/30 bg-amber-500/5 px-3 py-2">
      <div className="flex shrink-0 items-center gap-2">
        <button
          onClick={state === "speaking" ? stop : play}
          disabled={state === "writing"}
          className="inline-flex items-center justify-center gap-2 rounded-lg bg-amber-500 px-3 py-2 text-sm font-semibold text-zinc-950 hover:bg-amber-400 disabled:opacity-50"
        >
          <Icon name={state === "speaking" ? "pause" : "radio"} />
          {state === "writing" ? "Writing briefing…" : state === "speaking" ? "Stop briefing" : "Play radio briefing"}
        </button>
        <InfoTip label="dispatch radio">
          <span>
            Reads the finished simulation (how far and which way it spreads, which real fire stations it reaches and
            when) and turns it into the briefing a dispatcher would radio to every unit.
          </span>
          <span>Written by Gemini and voiced by ElevenLabs when their keys are set on the server.</span>
        </InfoTip>
      </div>
      {briefing ? (
        <p className="max-h-20 min-w-0 flex-1 overflow-y-auto text-sm leading-snug text-zinc-200">
          {briefing.text}
          <span className="mt-0.5 block text-xs text-zinc-500">
            {briefing.writer === "Gemini" ? "Written by Gemini" : "Built-in briefing (no Gemini key)"}
            {voice && ` · ${voice}`}
          </span>
        </p>
      ) : (
        <p className="self-center text-sm text-zinc-400">Dispatch radio: hear the briefing for this run.</p>
      )}
    </div>
  );
}
