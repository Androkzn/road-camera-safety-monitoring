---
name: frontend
description: React 19 + Vite + TypeScript conventions for frontend/
type: rules
paths:
  - "frontend/**/*.{ts,tsx}"
  - "frontend/**/*.css"
---

# Frontend conventions

- Stack: React 19, Vite 6, TypeScript ~5.8, react-router 7. No Redux, no Tailwind.
- Functional components + hooks only. No class components.
- File layout: pages in [frontend/src/pages/](frontend/src/pages/), shared components in `frontend/src/components/`, hooks in `frontend/src/hooks/`.
- Pages: `AdminPage` (live detections), `DashboardPage` (fleet overview), `MonitoringPage` (incident-queue watchdog).

## Data flow

- Backend talks to the frontend via SSE (`/api/live/stream`) and JSON endpoints (`/api/...`). No websockets.
- Public thumbnails only — never call endpoints requiring `X-DSAR-Token` from the frontend without an explicit privileged path.
- Admin endpoints require `Authorization: Bearer <ROAD_ADMIN_TOKEN>`; UI must surface auth failures, not retry silently.

## Build

- `cd frontend && npm run build` → `tsc -b && vite build` into `frontend/dist/`.
- `start.py` rebuilds the frontend before launching the server. The server serves from `frontend/dist/` if present, else `static/`.
- For frontend-only iteration: `cd frontend && npm run dev` (Vite dev server on a separate port).

## Type checking

- `cd frontend && npx tsc -b --noEmit` to type-check without writing.
- Don't disable `strict` in [frontend/tsconfig.json](frontend/tsconfig.json) without asking.
