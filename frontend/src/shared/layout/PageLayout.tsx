/**
 * PageLayout — thin shell helpers used by route-level Suspense and
 * ErrorBoundary fallbacks. Pages themselves still own their own
 * <TopBar/> markup so the existing component contracts don't break.
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

/** PageShell — outermost flex-column wrapper for a route. */
export function PageShell({ children }: { children: ReactNode }) {
  return <div className={styles.page}>{children}</div>;
}

/** PageBody — scrollable content region inside PageShell. */
export function PageBody({ children }: { children: ReactNode }) {
  return <div className={styles.body}>{children}</div>;
}

/**
 * RouteFallback — Suspense fallback shown while a lazy route chunk loads.
 * `aria-live="polite"` announces the loading state to screen readers.
 */
export function RouteFallback({ label = "Loading…" }: { label?: string }) {
  return (
    <div className={styles.fallback} role="status" aria-live="polite">
      <Spinner />
      <span>{label}</span>
    </div>
  );
}
