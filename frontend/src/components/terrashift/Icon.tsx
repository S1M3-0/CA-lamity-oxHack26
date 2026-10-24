const PATHS = {
  play: "M7 4.5v15l12-7.5z",
  pause: "M7 4h3.5v16H7zM13.5 4H17v16h-3.5z",
  rewind: "M5 5h2v14H5zM19 5v14L8.5 12z",
  back: "M18 5v14l-9-7zM7 5H5v14h2z",
  forward: "M6 5v14l9-7zM17 5h2v14h-2z",
  fast: "M3 5v14l8.5-7zM12.5 5v14L21 12z",
  flame:
    "M12 2c1 3.5 5 6 5 11a5 5 0 0 1-10 0c0-2 1-3.5 2-4.5 0 1.5.8 2.7 2 3-.5-3 .3-6.5 1-9.5z",
  drop: "M12 2.5s6 6.8 6 11.5a6 6 0 0 1-12 0c0-4.7 6-11.5 6-11.5z",
  pin: "M12 2a7 7 0 0 0-7 7c0 5 7 13 7 13s7-8 7-13a7 7 0 0 0-7-7zm0 9.5a2.5 2.5 0 1 1 0-5 2.5 2.5 0 0 1 0 5z",
  target:
    "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20zm0 3a7 7 0 1 1 0 14 7 7 0 0 1 0-14zm0 3.5a3.5 3.5 0 1 0 0 7 3.5 3.5 0 0 0 0-7z",
  x: "M6.4 5 12 10.6 17.6 5 19 6.4 13.4 12 19 17.6 17.6 19 12 13.4 6.4 19 5 17.6 10.6 12 5 6.4z",
} as const;

export type IconName = keyof typeof PATHS;

export function Icon({ name, className = "size-4" }: { name: IconName; className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="currentColor" aria-hidden="true">
      <path d={PATHS[name]} fillRule="evenodd" />
    </svg>
  );
}
