/**
 * PageChrome — page-level wrapper that owns the TopBar and auto-wires
 * the cross-cutting context reads (watchdog error count + drift count)
 * that every page currently plumbs by hand.
 *
 * The four pages (Admin, Dashboard, Monitoring, Settings) all render
 * `<TopBar />` at the top with the same boilerplate: call
 * `useWatchdogCtx()` for `errorCount`, call `useDriftCount()` for the
 * validator red-bubble, forward `sourceName` + `connected`. PageChrome
 * centralises those two context reads so the pages can shrink to:
 *
 *   <PageChrome page="admin" connected={connected} sourceName={name}>
 *     <MyPageBody />
 *   </PageChrome>
 *
 * Deliberately kept "open": we don't render a layout shell yet —
 * callers still own their own main/section markup. The goal at this
 * step is removing the 4 copies of context wiring, nothing more.
 *
 * NOTE: `page`, `eventCount`, `uptimeSec`, `lastEventTs`,
 * `perceptionState`, `onClearEvents`, `clearing` are accepted on the
 * props type so future iterations can surface them without churning
 * every call site again. Today they are held but not rendered — the
 * underlying TopBar has no slot for them yet and we don't want to
 * widen TopBar in this patch.
 *
 * --- Backend coupling ---
 * No direct backend calls. PageChrome reads only from React context
 * providers (`WatchdogProvider`, drift/validation context) that are
 * mounted once in `app/providers.tsx`. Those providers own the
 * network traffic — PageChrome just subscribes.
 *
 * --- Child components hosted ---
 * - `TopBar` (this folder): the actual rendered header strip.
 * - `testBadge` slot: consumers pass in a `<TestBadge />` from
 *   `features/tests` which PageChrome forwards as `children` to TopBar.
 *
 * --- UI mapping ---
 * Used on: All pages (global layout). Wraps the body of AdminPage,
 *   DashboardPage, MonitoringPage, SettingsPage and ValidationPage.
 * UI element: the global page wrapper that renders the TopBar above
 *   each page's content and auto-wires the Monitoring/Validation red
 *   bubble counts from context.
 */
import type { ReactNode } from "react";

import { useDriftCount } from "../../features/validation";
import { useWatchdogCtx } from "../../features/watchdog";

import { TopBar } from "./TopBar";

export type PageKey = "admin" | "dashboard" | "monitoring" | "settings" | "validation";

export interface PageChromeProps {
  /** Page identity — reserved for future per-page decoration. */
  page?: PageKey;
  connected?: boolean;
  sourceName?: string | null;
  eventCount?: number | null;
  uptimeSec?: number | null;
  lastEventTs?: number | string | null;
  perceptionState?: string | null;
  onClearEvents?: () => void;
  clearing?: boolean;
  /**
   * Optional override — by default PageChrome derives `errorCount`
   * from `useWatchdogCtx()`. Pass a number to override.
   */
  errorCount?: number;
  /**
   * Optional override — by default PageChrome derives `driftCount`
   * from `useDriftCount()`. Pass a number to override.
   */
  driftCount?: number;
  /** Test-runner badge (TestBadge) rendered inside TopBar as a child. */
  testBadge?: ReactNode;
  children?: ReactNode;
}

/**
 * PageChrome — renders the shared TopBar above `children`.
 *
 * Layout outlet: produces a fragment of `<TopBar /> + children`. The
 * TopBar is the "chrome" (fixed header row); `children` is the page's
 * own main/section markup rendered directly below, with no intervening
 * container so per-page layouts stay free.
 *
 * Props: see `PageChromeProps` above for the full shape. The only two
 * that affect rendering today are `connected`/`sourceName` (forwarded
 * to TopBar's live-status pill) and `errorCount`/`driftCount` (override
 * the context-derived red-bubble counts). `testBadge` is slotted into
 * TopBar's right-side children outlet.
 *
 * How it works: reads watchdog + validator counts from context so callers
 * don't have to. Props take precedence (`??`) when explicitly passed so
 * tests or special pages can override the auto-derived values.
 */
export function PageChrome({
  connected,
  sourceName,
  errorCount,
  driftCount,
  testBadge,
  children,
}: PageChromeProps) {
  // Read watchdog status via context — one hook call, any descendant.
  const { status: wdStatus } = useWatchdogCtx();
  const autoErrorCount = wdStatus?.by_severity?.error ?? 0;
  const autoDriftCount = useDriftCount();

  // Nullish-coalescing (`??`): use the prop if provided, else auto-derived.
  const resolvedErrorCount = errorCount ?? autoErrorCount;
  const resolvedDriftCount = driftCount ?? autoDriftCount;

  return (
    <>
      <TopBar
        sourceName={sourceName ?? undefined}
        connected={connected}
        errorCount={resolvedErrorCount}
        driftCount={resolvedDriftCount}
      >
        {testBadge}
      </TopBar>
      {children}
    </>
  );
}
