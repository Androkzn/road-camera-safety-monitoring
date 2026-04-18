/**
 * App.tsx — Root React component. Owns the route table.
 *
 * WHAT THIS FILE IS
 *   A tiny functional component that decides WHICH PAGE to show based on the
 *   current URL. It is rendered exactly once by main.tsx and then re-renders
 *   automatically whenever the URL changes (e.g. when the user clicks a
 *   <Link> in TopBar).
 *
 * WHERE IT FITS
 *   main.tsx -> <App /> -> <Routes> picks one of:
 *     "/"           -> AdminPage        (live detection feed via SSE)
 *     "/dashboard"  -> DashboardPage    (fleet overview + LLM copilot chat)
 *     "/monitoring" -> MonitoringPage   (watchdog incident queue)
 *
 * REACT / ROUTER CONCEPTS INTRODUCED
 *   - Functional component: a plain function that returns JSX. `App` below is
 *     one. React calls it to get the UI tree; it must be pure given its props.
 *   - `export function App()`: named export; `main.tsx` imports it by name.
 *   - `<Routes>`: a container from react-router that looks at the current URL
 *     and renders exactly one matching `<Route>`'s element.
 *   - `<Route path="..." element={...} />`: a URL-to-component mapping.
 *     `path` is matched against the browser URL; `element` is the JSX to show.
 *   - `<Navigate to="..." replace />`: a declarative redirect. Rendering this
 *     causes react-router to change the URL. `replace` means "replace the
 *     current history entry" instead of pushing a new one (so the back button
 *     doesn't get stuck bouncing through redirects).
 *   - Path `"*"`: wildcard catch-all; matches anything not matched above.
 *
 *   Note: each page component owns its own layout including the TopBar. There
 *   is no shared <Outlet /> layout route here — each page imports TopBar
 *   individually. If we later add a layout route, it would look like:
 *     <Route element={<Layout />}>
 *       <Route path="/" element={<AdminPage/>} />
 *       ...
 *     </Route>
 *   and <Layout /> would render its children via `<Outlet />`.
 */

// --- Imports ---

// `Routes` / `Route` form the declarative route table.
// `Navigate` is used to render a redirect as a component.
import { Routes, Route, Navigate } from "react-router-dom";

// The three top-level pages of the app. Each is a functional component.
// Defined in pages/DashboardPage.tsx, pages/AdminPage.tsx, pages/MonitoringPage.tsx.
import { DashboardPage } from "./pages/DashboardPage";
import { AdminPage } from "./pages/AdminPage";
import { MonitoringPage } from "./pages/MonitoringPage";

// --- Root component ---

/**
 * `App` is the root of the component tree (below providers). React calls this
 * function every time something above causes a re-render; it simply hands back
 * the route table. No state, no effects — pure routing.
 */
export function App() {
  return (
    // <Routes> walks its children and renders the first <Route> whose `path`
    // matches the current URL. Only ONE route renders at a time.
    <Routes>
      {/* "/" — the landing URL shows the live detections (Admin) page. */}
      <Route path="/" element={<AdminPage />} />

      {/* "/admin" — legacy URL. We redirect to "/" so bookmarks still work.
          `replace` swaps the history entry so Back doesn't re-trigger the redirect. */}
      <Route path="/admin" element={<Navigate to="/" replace />} />

      {/* "/dashboard" — fleet overview with summary tiles + copilot chat. */}
      <Route path="/dashboard" element={<DashboardPage />} />

      {/* "/monitoring" — watchdog incident queue (errors/warnings/info). */}
      <Route path="/monitoring" element={<MonitoringPage />} />

      {/* "*" — wildcard. Anything else (typos, stale links) bounces home. */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
