/**
 * App.tsx — top-level router that maps URLs to page components.
 *
 * What it does:
 *   Declares which page renders for each URL path. "/" and anything unknown
 *   go to AdminPage; "/admin" is a permanent redirect to "/"; "/dashboard"
 *   renders the operator dashboard; "/monitoring" renders the watchdog
 *   incident monitor.
 *
 * Purpose:
 *   A single-page app only loads one HTML file; the "pages" are switched by
 *   JavaScript based on the URL. This file is where that switching is
 *   defined — the one place to look to see what URLs the app supports.
 *
 * How it works:
 *   - <Routes> is a react-router component that picks ONE <Route> whose
 *     "path" matches the current URL and renders that route's "element".
 *   - <Navigate to="..." replace /> redirects the browser to another path.
 *     "replace" swaps the history entry instead of pushing a new one, so the
 *     Back button skips the redirect.
 *   - `path="*"` is a catch-all that matches any URL no other route handled.
 *   - `export function App()` is a React "component" — a plain function that
 *     returns JSX (HTML-like syntax that React turns into real DOM).
 *
 * Connects to:
 *   - Backend: none — pure routing shell.
 *   - UI: rendered by frontend/src/main.tsx inside <BrowserRouter>. Children
 *     are frontend/src/pages/AdminPage.tsx, DashboardPage.tsx, and
 *     MonitoringPage.tsx.
 */
// react-router: <Routes> picks one matching <Route>; <Navigate> redirects.
import { Routes, Route, Navigate } from "react-router-dom";
import { DashboardPage } from "./pages/DashboardPage";
import { AdminPage } from "./pages/AdminPage";
import { MonitoringPage } from "./pages/MonitoringPage";

// Top-level component rendered by main.tsx. Maps URL paths to page components;
// the user sees only one page at a time based on the current URL.
export function App() {
  return (
    <Routes>
      {/* Home page ("/") — renders the operator admin console (AdminPage). */}
      <Route path="/" element={<AdminPage />} />
      {/* Legacy URL: "/admin" is permanently redirected to "/". */}
      <Route path="/admin" element={<Navigate to="/" replace />} />
      {/* "/dashboard" — renders the live event-stream dashboard page. */}
      <Route path="/dashboard" element={<DashboardPage />} />
      {/* "/monitoring" — renders the watchdog incident monitor page. */}
      <Route path="/monitoring" element={<MonitoringPage />} />
      {/* Catch-all ("*"): any unknown URL is redirected back to "/". */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}
