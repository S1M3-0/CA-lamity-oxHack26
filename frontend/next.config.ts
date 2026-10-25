import type { NextConfig } from "next";

/**
 * All /api/* requests are forwarded to the FastAPI backend (../backend).
 *  - Locally: uvicorn on :8000 (started by `npm run dev` in the repo root).
 *  - Production: the public Vultr backend, regardless of build environment variables.
 *  - Development: API_URL can override the local uvicorn server.
 * Because of this, don't put Next.js route handlers under src/app/api.
 */
const API_URL =
  process.env.NODE_ENV === "production"
    ? "https://api.ca-lamity.live"
    : (process.env.API_URL?.trim() || "http://127.0.0.1:8000").replace(/\/$/, "");

const nextConfig: NextConfig = {
  async rewrites() {
    return [
      {
        source: "/api/:path*",
        destination: `${API_URL}/api/:path*`,
      },
    ];
  },
};

export default nextConfig;
