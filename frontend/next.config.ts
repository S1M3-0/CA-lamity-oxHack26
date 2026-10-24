import type { NextConfig } from "next";

/**
 * All /api/* requests are forwarded to the FastAPI backend (../backend).
 *  - Locally: uvicorn on :8000 (started by `npm run dev` in the repo root).
 *  - Deployed: set API_URL to the backend's URL, e.g. https://my-api.vercel.app
 * Because of this, don't put Next.js route handlers under src/app/api.
 */
const API_URL = (process.env.API_URL || "http://127.0.0.1:8000").replace(/\/$/, "");

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
