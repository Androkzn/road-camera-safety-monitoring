/**
 * vite.config.ts — Vite dev-server and build configuration for the React UI.
 *
 * What it does:
 *   Wires up the React plugin, chooses the frontend dev-server port, proxies
 *   backend paths to the Python FastAPI server, and picks an output folder
 *   for production builds.
 *
 * Purpose:
 *   Lets us run `npm run dev` against a live Python backend without CORS
 *   headaches: anything the React app fetches under /api, /stream, /chat,
 *   /thumbnails, or /admin/... is transparently forwarded to the FastAPI
 *   process on 127.0.0.1:8001 (the project's preferred local backend port —
 *   `start.py --port 8001`). React itself runs on port 3000 in dev.
 *
 * How it works:
 *   - `defineConfig({...})` is a Vite helper that gives type-checking on
 *     the config object without requiring any runtime changes.
 *   - `plugins: [react()]` enables JSX/TSX transforms and Fast Refresh.
 *   - `server.port: 3000` runs the dev server on http://localhost:3000.
 *   - `server.proxy` maps path prefixes to the backend. For example, a
 *     fetch to `/api/live/status` from the browser hits Vite, which then
 *     forwards the request to `http://127.0.0.1:8001/api/live/status`.
 *     This mirrors what api.ts expects in production where FastAPI serves
 *     both the built SPA and the API on the same origin.
 *   - `build.outDir: "dist"` writes production assets to `frontend/dist`,
 *     which start.py / the FastAPI static mount serve from.
 *
 * Connects to:
 *   - Backend: proxies to the FastAPI app in road_safety/server.py
 *     (running on port 8001 per the project's dev convention).
 *   - UI: used by every frontend/src/** file at dev-server and build time;
 *     the proxy config is what makes api.ts endpoints reachable during
 *     `npm run dev`.
 */

import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  server: {
    port: 3000,
    proxy: {
      "/api": "http://127.0.0.1:8001",
      "/stream": "http://127.0.0.1:8001",
      "/chat": "http://127.0.0.1:8001",
      "/thumbnails": "http://127.0.0.1:8001",
      "/admin/video_feed": "http://127.0.0.1:8001",
      "/admin/detections": "http://127.0.0.1:8001",
    },
  },
  build: {
    outDir: "dist",
  },
});
