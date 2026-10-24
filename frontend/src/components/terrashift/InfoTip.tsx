"use client";

import { useEffect, useRef, useState } from "react";

const WIDTH = 256;
const GAP = 6;

/**
 * Small "i" icon that shows a short explanation on hover (or keyboard focus; tap on touch screens).
 * The popover opens diagonally above-right of the icon, fixed-positioned so the scrolling sidebar can't clip it.
 */
export function InfoTip({ label, children }: { label: string; children: React.ReactNode }) {
  const [pos, setPos] = useState<{ left: number; bottom: number } | null>(null);
  const ref = useRef<HTMLSpanElement>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const pointerType = useRef("mouse");
  const open = pos !== null;

  function show() {
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    setPos({
      left: Math.max(8, Math.min(r.right + GAP, window.innerWidth - WIDTH - 8)),
      bottom: window.innerHeight - r.top + GAP,
    });
  }
  const hide = () => setPos(null);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) hide();
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && hide();
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("keydown", onKey);
    window.addEventListener("scroll", hide, true);
    window.addEventListener("resize", hide);
    return () => {
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("keydown", onKey);
      window.removeEventListener("scroll", hide, true);
      window.removeEventListener("resize", hide);
    };
  }, [open]);

  return (
    <span
      ref={ref}
      className="inline-flex"
      onPointerEnter={(e) => e.pointerType === "mouse" && show()}
      onPointerLeave={(e) => e.pointerType === "mouse" && hide()}
    >
      <button
        ref={btnRef}
        type="button"
        onPointerDown={(e) => (pointerType.current = e.pointerType)}
        onClick={(e) => {
          e.preventDefault();
          // mouse users get hover; taps toggle
          if (pointerType.current !== "mouse") (open ? hide : show)();
        }}
        // keyboard focus only; a tap also focuses the button and would cancel out its toggle
        onFocus={(e) => e.currentTarget.matches(":focus-visible") && show()}
        onBlur={hide}
        aria-label={`About ${label}`}
        aria-expanded={open}
        className={`flex size-4 cursor-help items-center justify-center rounded-full border text-[10px] font-bold normal-case leading-none ${
          open ? "border-zinc-300 bg-zinc-300 text-zinc-900" : "border-zinc-500 text-zinc-400 hover:border-zinc-300 hover:text-zinc-200"
        }`}
      >
        i
      </button>
      {pos && (
        <span
          role="tooltip"
          style={{ left: pos.left, bottom: pos.bottom, width: WIDTH }}
          className="pointer-events-none fixed z-50 flex flex-col gap-1.5 rounded-lg border border-zinc-600/60 bg-zinc-900/75 p-3 text-xs font-normal normal-case leading-relaxed tracking-normal text-zinc-200 shadow-xl backdrop-blur-sm"
        >
          {children}
        </span>
      )}
    </span>
  );
}
