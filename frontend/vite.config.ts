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

// defineConfig — Vite helper that just returns its argument but adds type-checking.
import { defineConfig } from "vite";
// React plugin — enables JSX/TSX transforms and Fast Refresh (hot reload).
import react from "@vitejs/plugin-react";

export default defineConfig({
  // plugins — turn on the React plugin so .tsx files compile correctly.
  plugins: [react()],
  server: {
    // port — dev server runs on http://localhost:3000 (the browser URL).
    port: 3000,
    // proxy — dev-only path forwarding. Anything the browser fetches under
    // these prefixes gets relayed to the FastAPI backend on 127.0.0.1:8001
    // (the project's preferred port; matches `start.py --port 8001`). Without
    // this, browser requests would hit Vite and fail, or require CORS headers.
    proxy: {
      // All REST endpoints (defined in road_safety/server.py & api/*.py).
      "/api": "http://127.0.0.1:8001",
      // SSE endpoints like /stream/events used by useEventStream.
      "/stream": "http://127.0.0.1:8001",
      // Copilot chat endpoint consumed by useChat.
      "/chat": "http://127.0.0.1:8001",
      // Static thumbnails served by FastAPI for EventCard <img src>.
      "/thumbnails": "http://127.0.0.1:8001",
      // Live MJPEG video stream shown in the Admin "Live" tab.
      "/admin/video_feed": "http://127.0.0.1:8001",
      // Raw detections overlay stream (debug view).
      "/admin/detections": "http://127.0.0.1:8001",
    },
  },
  build: {
    // outDir — production build output folder. FastAPI mounts this at "/" in prod.
    outDir: "dist",
  },
});
