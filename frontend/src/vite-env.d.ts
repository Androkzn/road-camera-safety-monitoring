/**
 * vite-env.d.ts — Vite's ambient type declarations.
 *
 * References the Vite client types so `import.meta.env.VITE_*` (and
 * asset-import suffixes like `?url` / `?raw`) are typed on the frontend
 * build. A `.d.ts` file holds TYPES ONLY — no runtime code is emitted.
 * Not a runtime file; TypeScript consults it at compile time only,
 * loaded via tsconfig.app.json's `include` list.
 *
 * --- UI mapping ---
 * Page: ALL pages (compile-time aid for the whole frontend build).
 * UI element: none; no DOM output. Enables typed `import.meta.env.*`
 *              lookups in any feature file.
 */

/// <reference types="vite/client" />
