import { ApiStatus } from "@/components/ApiStatus";
import { ItemsPanel } from "@/components/ItemsPanel";
import { APP_NAME, APP_TAGLINE } from "@/lib/config";

export default function Home() {
  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 px-4 py-12">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-3xl font-semibold tracking-tight">{APP_NAME}</h1>
          <p className="mt-1 text-zinc-500">{APP_TAGLINE}</p>
        </div>
        <ApiStatus />
      </header>

      {/* Placeholder feature: replace with whatever the theme needs. */}
      <ItemsPanel />

      <footer className="text-sm text-zinc-500">
        API docs at{" "}
        <a href="/api/docs" className="text-brand underline underline-offset-2">
          /api/docs
        </a>
      </footer>
    </main>
  );
}
