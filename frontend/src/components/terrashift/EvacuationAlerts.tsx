"use client";

import { useEffect, useRef, useState } from "react";
import type { PersonAlert } from "@/lib/sim/alerts";
import type { Person } from "@/lib/sim";
import { Icon } from "./Icon";
import { InfoTip } from "./InfoTip";

type Status = { twilio: boolean; voice: boolean };
/** "sending" | "sent" | "failed: <reason>" per run + person */
type SendState = Record<string, string>;

let status: Promise<Status> | null = null;
const getStatus = () =>
  (status ??= fetch("/api/alerts/status")
    .then((r) => (r.ok ? r.json() : { twilio: false, voice: false }))
    .catch(() => ({ twilio: false, voice: false })));

function useAlertStatus() {
  const [s, setS] = useState<Status>({ twilio: false, voice: false });
  useEffect(() => {
    getStatus().then(setS);
  }, []);
  return s;
}

/**
 * Sends a real SMS (and optionally a call) once per run and person, when the alert time is
 * reached during playback. Scrubbing the timeline never sends anything.
 */
export function useAlertSender(runId: number | null, fired: PersonAlert[], playing: boolean, call: boolean) {
  const { twilio } = useAlertStatus();
  const [sent, setSent] = useState<SendState>({});
  const done = useRef(new Set<string>());

  useEffect(() => {
    if (runId === null || !playing || !twilio) return;
    for (const a of fired) {
      const key = `${runId}:${a.person.id}`;
      if (!a.person.phone.trim() || !a.text || done.current.has(key)) continue;
      done.current.add(key);
      setSent((s) => ({ ...s, [key]: "sending" }));
      fetch("/api/alerts/send", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ to: a.person.phone, text: a.text, call }),
      })
        .then(async (res) => {
          const body = await res.json().catch(() => ({}));
          setSent((s) => ({ ...s, [key]: res.ok ? "sent" : `failed: ${body.detail ?? res.status}` }));
        })
        .catch(() => setSent((s) => ({ ...s, [key]: "failed: backend unreachable" })));
    }
  }, [runId, fired, playing, twilio, call]);

  return sent;
}

export function PeoplePanel({
  people,
  setPeople,
  placing,
  setPlacing,
  call,
  setCall,
}: {
  people: Person[];
  setPeople: (f: (old: Person[]) => Person[]) => void;
  placing: boolean;
  setPlacing: (v: boolean) => void;
  call: boolean;
  setCall: (v: boolean) => void;
}) {
  const { twilio, voice } = useAlertStatus();
  const edit = (id: number, patch: Partial<Person>) => setPeople((old) => old.map((p) => (p.id === id ? { ...p, ...patch } : p)));
  const input =
    "min-w-0 rounded-md border border-white/10 bg-white/[0.03] px-2 py-1 text-[13px] text-zinc-100 placeholder:text-zinc-600 focus:border-brand/60 focus:outline-none";

  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="flex items-center gap-1.5 text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">
          People to warn
          <InfoTip label="people to warn">
            <span>
              Pin someone&apos;s home on the map. If the disaster will reach it, they get an alert{" "}
              <b className="text-zinc-100">an hour before it arrives</b>, with the direction of the nearest safe ground.
            </span>
            <span>Every message starts with &quot;SIMULATION - not a real emergency&quot;.</span>
          </InfoTip>
        </h2>
        <button onClick={() => setPlacing(!placing)} className="text-[11px] font-medium text-brand hover:text-brand-hover">
          {placing ? "Cancel" : "+ Add person"}
        </button>
      </div>
      {placing && <p className="text-[11px] text-zinc-400">Click their home on the map.</p>}
      {people.length === 0 && !placing && <p className="text-[11px] text-zinc-600">Nobody pinned yet.</p>}
      {people.map((p) => (
        <div key={p.id} className="grid grid-cols-[1fr_1.3fr_auto] items-center gap-1.5">
          <input className={input} value={p.name} onChange={(e) => edit(p.id, { name: e.target.value })} placeholder="Name" aria-label="Name" />
          <input
            className={input}
            value={p.phone}
            onChange={(e) => edit(p.id, { phone: e.target.value })}
            placeholder={twilio ? "+44 phone" : "Phone (optional)"}
            aria-label={`Phone number for ${p.name}`}
            type="tel"
          />
          <button onClick={() => setPeople((old) => old.filter((x) => x.id !== p.id))} className="text-zinc-600 hover:text-zinc-200" aria-label={`Remove ${p.name}`}>
            <Icon name="x" className="size-3.5" />
          </button>
        </div>
      ))}
      {twilio && people.length > 0 && (
        <label className="inline-flex items-center gap-2 text-[12px] text-zinc-400">
          <input type="checkbox" checked={call} onChange={(e) => setCall(e.target.checked)} className="accent-brand" />
          Also phone them {voice ? "(ElevenLabs voice)" : "(Twilio voice)"}
        </label>
      )}
    </section>
  );
}

export type PhoneMessage = { key: string; name: string; at: string; text: string; phone: string; state?: string };

/** Alerts sent so far for the run on screen, newest first. Shown even when real texts are off. */
export function AlertFeed({ messages, hazard }: { messages: PhoneMessage[]; hazard: string }) {
  return (
    <section className="flex flex-col gap-2">
      <div className="flex items-center justify-between">
        <h2 className="text-[11px] font-medium uppercase tracking-[0.14em] text-zinc-500">Alerts sent</h2>
        <span className="font-mono text-[11px] text-zinc-500">{messages.length}</span>
      </div>
      {messages.length === 0 && (
        <p className="text-[12px] text-zinc-600">Each person is alerted an hour before the {hazard} reaches them.</p>
      )}
      {[...messages].reverse().map((m) => (
        <div key={m.key} className="flex flex-col gap-1 rounded-xl bg-white/[0.03] p-2.5">
          <span className="flex justify-between text-[11px]">
            <span className="font-medium text-zinc-300">To {m.name || "resident"}</span>
            <span className="font-mono text-zinc-500">{m.at}</span>
          </span>
          <p className="text-[12px] leading-snug text-zinc-300">{m.text}</p>
          <span className="text-[10px] text-zinc-600">
            {!m.phone.trim()
              ? "On screen only"
              : m.state === "sent"
                ? `Texted ${m.phone} ✓`
                : m.state === "sending"
                  ? `Texting ${m.phone}…`
                  : m.state?.startsWith("failed")
                    ? `Text ${m.state}`
                    : "On screen only"}
          </span>
        </div>
      ))}
    </section>
  );
}
