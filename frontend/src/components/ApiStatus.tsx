"use client";

import { useEffect, useState } from "react";
import { api } from "@/lib/api";

type State = { kind: "loading" } | { kind: "ok"; db: string } | { kind: "down" };

export function ApiStatus() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    api
      .health()
      .then((h) => setState({ kind: "ok", db: h.database }))
      .catch(() => setState({ kind: "down" }));
  }, []);

  const dot =
    state.kind === "ok" ? "bg-emerald-500" : state.kind === "down" ? "bg-red-500" : "bg-zinc-400";
  const label =
    state.kind === "ok"
      ? `API ok · ${state.db}`
      : state.kind === "down"
        ? "API unreachable"
        : "Checking API…";

  return (
    <span className="inline-flex items-center gap-2 rounded-full border border-zinc-200 px-3 py-1 text-sm dark:border-zinc-800">
      <span className={`size-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}
