/**
 * DashboardPage — fleet overview + LLM copilot.
 *
 * Reads (mostly via TanStack Query): live status, scene context, drift,
 * pytest status, plus the SSE event stream. Owns local UI state for the
 * filter bar and TestDrawer toggle. Everything else is composition.
 *
 * This is a "thin orchestrator" page: it wires custom hooks together and
 * composes feature components. The fetching / stateful logic is pushed
 * into hooks; the JSX is mostly layout.
 *
 * React/TS concepts first introduced in this file:
 *   - `useEffect(fn, deps)` — side-effects after render.
 *   - `useMemo(fn, deps)` — cache a derived value across renders.
 *   - `useRef<T>(initial)` — mutable cell, no re-render on write.
 *   - Multiple `useState` slots for independent filter fields.
 *   - Destructuring a hook's return object in one statement.
 *   - Conditional JSX fragments + React fragment shorthand `<>...</>`.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: the whole dashboard screen — top bar, the four KPI tiles,
 *   the three status banners (perception / scene / drift), the filter bar,
 *   the scrolling event feed in the middle, and the Copilot chat panel
 *   on the right.
 * Backend: GET /api/live/status, GET /api/live/scene, GET /api/drift,
 *   GET /api/live/stream (SSE), DELETE /api/events
 */

import { useEffect, useMemo, useRef, useState } from "react";

import { useEventStream } from "../../shared/hooks/useEventStream";
import { useLiveStatus } from "../../shared/hooks/useLiveStatus";
import { useUptimeTicker } from "../../shared/hooks/useUptimeTicker";
import { PageChrome } from "../../shared/layout/PageChrome";
import { EventFilterBar } from "../../shared/ui";
import { EventCard, EventDialog } from "../../shared/events";
import type { SafetyEvent } from "../../shared/types/common";
import { TestBadge, TestDrawer, useTests } from "../tests";
import { useWatchdogCtx } from "../watchdog";

import {
  CopilotPanel,
  DriftBannerRow,
  PerceptionBannerRow,
  SceneBannerRow,
  SummaryTiles,
} from "./components";
import { useClearEvents } from "./hooks/useClearEvents";
import { useDrift } from "./hooks/useDrift";
import { useScene } from "./hooks/useScene";

import styles from "./DashboardPage.module.css";

/**
 * Fleet-wide dashboard page. Mounted at `/` by the app router.
 * Renders the SummaryTiles, banners, event stream, and Copilot panel.
 */
export function DashboardPage() {
  // TEACH: `useEventStream` is a shared context-backed hook. The SSE
  // connection is opened *once* at app bootstrap (in providers.tsx) and
  // every consumer reads from the same context — we never open a new
  // EventSource here.
  const { events, perception, connected, clearEvents } = useEventStream();
  // D8: derive counts from the current `events` buffer instead of a ref —
  // the prior `counts: ref.current` shape silently stopped re-rendering
  // when a count changed without a new event pushing. `events` is capped
  // at ~100 in the provider so this is always O(100) at most.
  // TEACH: `useMemo(fn, deps)` caches a derived value. It re-runs only
  // when `events` changes. Without this we'd rescan the buffer on every
  // unrelated render (every keystroke in a filter box, for example).
  const counts = useMemo(() => {
    let high = 0;
    let medium = 0;
    for (const ev of events) {
      if (ev.risk_level === "high") high++;
      else if (ev.risk_level === "medium") medium++;
    }
    return { total: events.length, high, medium };
  }, [events]);
  const { data: liveStatus } = useLiveStatus();
  const { data: scene } = useScene();
  const { data: drift, refetch: refreshDrift } = useDrift();
  const { status: testStatus, rerun: rerunTests } = useTests();
  const { findings, clearAll: clearAllFindings } = useWatchdogCtx();
  const hasFindings = (findings?.length ?? 0) > 0;
  const { clear: handleClearEvents, clearing: clearingEvents } = useClearEvents({
    clearEvents,
    clearAllFindings,
    hasFindings,
  });

  const [drawerOpen, setDrawerOpen] = useState(false);
  // TEACH: `useRef` holds a mutable value across renders *without*
  // triggering a re-render when it changes. Here we track the previous
  // test status so we can detect the running → failed edge and open the
  // TestDrawer exactly once per transition.
  const prevTestStatus = useRef<string>("idle");

  const [filterRisk, setFilterRisk] = useState("");
  const [filterType, setFilterType] = useState("");
  const [showLow, setShowLow] = useState(false);
  // Event-detail modal: clicking any EventCard opens the same dialog
  // already used by the validation page, so reviewers can scrub the
  // annotated \u00b13s clip without leaving the dashboard.
  const [selectedEvent, setSelectedEvent] = useState<SafetyEvent | null>(null);

  // TEACH: `useEffect(fn, deps)` runs `fn` AFTER render, whenever a
  // dep changes. The deps list here is `[testStatus?.status]` — we
  // deliberately omit `drawerOpen` and `testStatus` itself so we only
  // react to status *transitions*, not to unrelated re-renders.
  // Auto-open the TestDrawer when tests flip running → failed.
  useEffect(() => {
    if (testStatus?.status === "failed" && prevTestStatus.current === "running" && !drawerOpen) {
      setDrawerOpen(true);
    }
    if (testStatus) prevTestStatus.current = testStatus.status;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [testStatus?.status]);

  const sourceName = liveStatus?.source ?? "—";
  const startedAt = liveStatus?.started_at ?? null;
  const tickerSec = useUptimeTicker(startedAt);
  const uptimeSec = startedAt === null ? null : tickerSec;

  const mergedPerception = perception ?? (liveStatus?.perception || null);

  const eventTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const ev of events) if (ev.event_type) seen.add(ev.event_type);
    return Array.from(seen).sort();
  }, [events]);

  const filtered = useMemo(() => {
    let list = events;
    if (!showLow && filterRisk !== "low") {
      list = list.filter((e) => e.risk_level !== "low");
    }
    if (filterRisk) list = list.filter((e) => e.risk_level === filterRisk);
    if (filterType) list = list.filter((e) => e.event_type === filterType);
    return list;
  }, [events, filterRisk, filterType, showLow]);

  const hasFilters = filterRisk !== "" || filterType !== "";

  return (
    // TEACH: `<>...</>` is a React Fragment — renders children without
    // adding an extra DOM node. Used when a component returns siblings.
    <>
      <PageChrome
        page="dashboard"
        sourceName={sourceName}
        connected={connected}
        testBadge={<TestBadge status={testStatus} onClick={() => setDrawerOpen((o) => !o)} />}
      />

      <TestDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        status={testStatus}
        onRerun={rerunTests}
      />

      <div className={styles.app}>
        <section className={styles.panel}>
          <SummaryTiles
            total={counts.total}
            high={counts.high}
            medium={counts.medium}
            uptimeSec={uptimeSec}
          />
          <PerceptionBannerRow perception={mergedPerception} />
          <SceneBannerRow scene={scene ?? null} />
          <DriftBannerRow drift={drift ?? null} onRefresh={() => refreshDrift()} />

          <div className={styles.filterBar}>
            <EventFilterBar
              className={styles.filterBarInner}
              riskLevel={filterRisk}
              onRiskLevelChange={setFilterRisk}
              eventType={filterType}
              onEventTypeChange={setFilterType}
              showLow={showLow}
              onShowLowChange={setShowLow}
              availableTypes={eventTypes}
              onClear={() => {
                setFilterRisk("");
                setFilterType("");
              }}
            />
            <span className={styles.filterCount}>
              {hasFilters ? `${filtered.length} / ${events.length}` : `${events.length}`} events
            </span>
            <button
              type="button"
              className={styles.clearAllBtn}
              onClick={() => void handleClearEvents()}
              disabled={clearingEvents || (events.length === 0 && !hasFindings)}
              title="Clear events and all corresponding monitoring records"
            >
              {clearingEvents ? "Clearing…" : "Clear all events"}
            </button>
          </div>

          <div className={styles.stream}>
            {events.length === 0 && <div className={styles.empty}>Waiting for events…</div>}
            {events.length > 0 && filtered.length === 0 && (
              <div className={styles.empty}>No events match filters</div>
            )}
            {/* TEACH: `.map` over a list with a stable `key` per item.
                 `event_id` is globally unique so React can diff the
                 list correctly across renders. */}
            {filtered.map((ev, i) => (
              <EventCard key={ev.event_id} event={ev} isNew={i === 0} onSelect={setSelectedEvent} />
            ))}
          </div>
        </section>

        <CopilotPanel />
      </div>
      <EventDialog event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </>
  );
}
