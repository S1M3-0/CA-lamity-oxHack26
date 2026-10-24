"use client";

import { useCallback, useEffect, useState } from "react";
import { api, type Item } from "@/lib/api";

/**
 * End-to-end example: form -> FastAPI -> database -> list.
 * Rename/reshape this into your real feature.
 */
export function ItemsPanel() {
  const [items, setItems] = useState<Item[]>([]);
  const [title, setTitle] = useState("");
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      setItems(await api.items.list());
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    run(async () => {});
  }, [run]);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    const t = title.trim();
    if (!t) return;
    setTitle("");
    await run(() => api.items.create({ title: t }));
  }

  return (
    <section className="rounded-2xl border border-zinc-200 bg-white p-6 shadow-sm dark:border-zinc-800 dark:bg-zinc-900">
      <h2 className="text-lg font-medium">Items</h2>

      <form onSubmit={onSubmit} className="mt-4 flex gap-2">
        <input
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          placeholder="Add something…"
          className="min-w-0 flex-1 rounded-lg border border-zinc-300 bg-transparent px-3 py-2 outline-none focus:border-brand dark:border-zinc-700"
        />
        <button
          type="submit"
          className="rounded-lg bg-brand px-4 py-2 font-medium text-white hover:bg-brand-hover disabled:opacity-50"
          disabled={!title.trim()}
        >
          Add
        </button>
      </form>

      {error && <p className="mt-3 text-sm text-red-600">{error}</p>}

      <ul className="mt-4 divide-y divide-zinc-100 dark:divide-zinc-800">
        {loading && <li className="py-3 text-sm text-zinc-500">Loading…</li>}
        {!loading && items.length === 0 && (
          <li className="py-3 text-sm text-zinc-500">Nothing yet.</li>
        )}
        {items.map((item) => (
          <li key={item.id} className="flex items-center gap-3 py-3">
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => run(() => api.items.update(item.id, { done: !item.done }))}
              className="size-4 accent-brand"
            />
            <span className={`flex-1 ${item.done ? "text-zinc-400 line-through" : ""}`}>
              {item.title}
            </span>
            <button
              onClick={() => run(() => api.items.remove(item.id))}
              className="text-sm text-zinc-400 hover:text-red-600"
              aria-label={`Delete ${item.title}`}
            >
              Delete
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
