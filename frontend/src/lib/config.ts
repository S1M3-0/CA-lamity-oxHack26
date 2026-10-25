// Rename the app in one place once you have a theme.
export const APP_NAME = "TerraShift";
export const APP_TAGLINE =
  "Pick a real place and a disaster, set the conditions, and watch it unfold over 24 hours.";

// Set these in frontend/.env.local (never commit the key). With no key the
// map falls back to MapLibre + Esri imagery.
export const GOOGLE_MAPS_API_KEY = process.env.NEXT_PUBLIC_GOOGLE_MAPS_API_KEY ?? "";
// Advanced markers need a map ID; Google's DEMO_MAP_ID is fine for development.
export const GOOGLE_MAPS_MAP_ID = process.env.NEXT_PUBLIC_GOOGLE_MAPS_MAP_ID || "DEMO_MAP_ID";
