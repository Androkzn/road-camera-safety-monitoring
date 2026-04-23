/**
 * PageLayout — thin shell helpers used by route-level Suspense and
 * ErrorBoundary fallbacks. Pages themselves still own their own
 * <TopBar/> markup so the existing component contracts don't break.
 *
 * Purpose: three stateless CSS-module wrappers — `PageShell` (outer
 * flex column), `PageBody` (scrollable content region), `RouteFallback`
 * (spinner shown while a lazy route chunk downloads). None of these
 * components fetch or subscribe to anything.
 *
 * --- Backend coupling ---
 * None. This module is pure layout + styling; all three exports are
 * stateless and do not call any backend endpoints.
 *
 * --- Child components hosted ---
 * - `Spinner` from `shared/ui` (used by RouteFallback only).
 * - Otherwise each helper is a single `<div>` wrapper that renders its
 *   `children` prop; the page contents come from the feature route.
 *
 * --- UI mapping ---
 * Used on: All pages (global layout). PageShell / PageBody wrap route
 *   content; RouteFallback shows during route lazy-load on every page
 *   transition.
 * UI element: outer page container plus the route loading fallback
 *   (centred spinner with a "Loading…" label) shown while a page chunk
 *   is being fetched.
 */
import type { ReactNode } from "react";

import { Spinner } from "../ui";

import styles from "./PageLayout.module.css";

/**
 * PageShell — outermost flex-column wrapper for a route.
 * Renders a single `<div>` styled by `styles.page` (flex column, full
 * viewport height) that hosts the page's TopBar + body. Props:
 *   - `children`: the route's full page content (usually a PageChrome
 *     + PageBody pair).
 */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

/**
 * PageBody — scrollable content region inside PageShell.
 * Acts as the main content outlet below the TopBar; `styles.body`
 * provides the overflow-y container so long feeds/lists scroll
 * independently of the fixed header. Props:
 *   - `children`: the feature's page-specific markup (forms, grids,
 *     event feeds, etc.).
 */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

/**
 * RouteFallback — Suspense fallback shown while a lazy route chunk loads.
 * Rendered by `<RouteShell>` (in `app/router.tsx`) as the Suspense
 * fallback during every route transition. Props:
 *   - `label` (default `"Loading…"`): the visible + announced text.
 *
 * Accessibility: `role="status"` + `aria-live="polite"` tells assistive
 * tech to announce the loading state without interrupting the user.
 */
export function RouteFallback({ label = "Loading…" }: { label?: string }) {
  return (
    <div className={styles.fallback} role="status" aria-live="polite">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
