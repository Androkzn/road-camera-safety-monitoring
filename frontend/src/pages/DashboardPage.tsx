/**
 * DashboardPage.tsx — operator dashboard page at "/dashboard".
 *
 * What it does:
 *   Shows the live safety feed: summary tiles (totals/high/medium/uptime),
 *   banners for perception, scene, and drift state, a risk+type filter bar,
 *   a live-updating list of event cards, a test-runner badge with drawer,
 *   and a chat "Copilot" side panel.
 *
 * Purpose:
 *   The main operator view for watching events stream in from the dashcam
 *   pipeline and spotting changes in perception/scene/drift over time.
 *
 * How it works:
 *   - Custom hooks drive the data:
 *       useEventStream() → /stream/events SSE (events + perception + counts)
 *       useLiveStatus()  → /api/live/status poll (source name, started_at)
 *       useScene()       → /api/live/scene poll
 *       useDrift()       → /api/drift poll
 *       useTests()       → /api/tests/status poll with auto-open-on-fail
 *   - useState: holds drawer open flag, risk filter, type filter, and the
 *     live-ticking uptime in seconds. Changing state re-renders this page.
 *   - useRef: holds a value that survives renders without causing a re-
 *     render. `prevTestStatus` remembers the previous test status so we can
 *     auto-open the drawer exactly when status transitions running→failed.
 *   - useEffect: runs side-effects after render. One effect watches the
 *     test status; another ticks a 1-second interval to refresh uptime and
 *     cleans it up on unmount.
 *   - useMemo: caches a computed value until its dependencies change. Used
 *     to derive the unique set of event types for the filter dropdown and
 *     to apply both filters to the events list.
 *
 * Connects to:
 *   - Backend: /stream/events (SSE), /api/live/status, /api/live/scene,
 *     /api/drift, /api/tests/status, /api/tests/run — all in
 *     road_safety/server.py.
 *   - UI: mounted by frontend/src/App.tsx at "/dashboard". Children from
 *     components/dashboard (SummaryTiles, PerceptionBannerRow,
 *     SceneBannerRow, DriftBannerRow, CopilotPanel), components/events
 *     (EventCard), components/tests (TestBadge, TestDrawer), and
 *     components/layout/TopBar.
 */
// React hooks: useState = state that re-renders, useEffect = side-effects,
// useRef = mutable value that survives renders without triggering re-renders,
// useMemo = cached computed value recomputed only when inputs change.
import { useState, useEffect, useRef, useMemo } from "react";
import { TopBar } from "../components/layout/TopBar";
import {
  SummaryTiles,
  PerceptionBannerRow,
  SceneBannerRow,
  DriftBannerRow,
  CopilotPanel,
} from "../components/dashboard";
import { EventCard } from "../components/events";
import { TestBadge, TestDrawer } from "../components/tests";
// Data-fetching hooks — each wraps one API endpoint / SSE stream.
import { useEventStream } from "../hooks/useEventStream";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useScene } from "../hooks/useScene";
import { useDrift } from "../hooks/useDrift";
import { useTests } from "../hooks/useTests";
import { humanEventType } from "../lib/format";
import styles from "./DashboardPage.module.css";

// Renders the "/dashboard" page — the main operator view: summary tiles,
// perception/scene/drift banners, filter bar, live event feed, and the
// Copilot chat side panel.
export function DashboardPage() {
  // SSE /stream/events: rolling events list + perception snapshot + total/high/medium counters.
  const { events, perception, connected, counts } = useEventStream();
  // Polls /api/live/status — provides source name + pipeline start time.
  const { data: liveStatus } = useLiveStatus();
  // Polls /api/live/scene — feeds SceneBannerRow.
  const { data: scene } = useScene();
  // Polls /api/drift — feeds DriftBannerRow; `refetch` is called by its Refresh button.
  const { data: drift, refetch: refreshDrift } = useDrift();
  // Polls /api/tests/status and exposes a Re-run action for the drawer.
  const { status: testStatus, rerun: rerunTests } = useTests();

  // Controls the slide-in test drawer on the right side.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // useRef holds a value across renders without triggering a re-render when
  // changed — perfect for "remember previous value" logic. Here it remembers
  // the last test status so we can detect the running→failed transition.
  const prevTestStatus = useRef<string>("idle");

  // Event-list risk filter ("" = show all, else "high" | "medium" | "low").
  const [filterRisk, setFilterRisk] = useState("");
  // Event-list type filter (empty string = no type filter applied).
  const [filterType, setFilterType] = useState("");

  // Auto-opens the test drawer exactly when tests transition running → failed,
  // but only if the drawer is currently closed. Runs whenever testStatus.status changes.
  useEffect(() => {
    if (
      testStatus?.status === "failed" &&
      prevTestStatus.current === "running" &&
      !drawerOpen
    ) {
      setDrawerOpen(true);
    }
    if (testStatus) prevTestStatus.current = testStatus.status;
  }, [testStatus?.status]);

  const sourceName = liveStatus?.source ?? "—";
  // Live-ticking uptime (seconds since pipeline start) shown in SummaryTiles.
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);

  // Starts a 1s tick to refresh uptimeSec from liveStatus.started_at. The
  // returned cleanup clearInterval()s it when started_at changes or the
  // component unmounts. The "!" after started_at is a non-null assertion —
  // we already checked it truthy on the previous line.
  useEffect(() => {
    if (!liveStatus?.started_at) return;
    const tick = () => {
      setUptimeSec(Math.max(0, Date.now() / 1000 - liveStatus.started_at!));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [liveStatus?.started_at]);

  // Prefer the SSE-pushed perception state; fall back to the polled one.
  const mergedPerception = perception ?? (liveStatus?.perception || null);

  // Builds the unique, sorted list of event_type strings for the type filter
  // dropdown. Recomputes only when `events` changes — saves re-scanning every render.
  const eventTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const ev of events) if (ev.event_type) seen.add(ev.event_type);
    return Array.from(seen).sort();
  }, [events]);

  // Applies both risk + type filters to `events`. Recomputes only when events
  // or either filter changes; drives the rendered <EventCard> list below.
  const filtered = useMemo(() => {
    let list = events;
    if (filterRisk) list = list.filter((e) => e.risk_level === filterRisk);
    if (filterType) list = list.filter((e) => e.event_type === filterType);
    return list;
  }, [events, filterRisk, filterType]);

  // True if at least one dropdown is set — controls the "Clear" button visibility.
  const hasFilters = filterRisk !== "" || filterType !== "";

  return (
    <>
      {/* Top nav bar — source name + connection dot, with the test-status badge on the right. */}
      <TopBar sourceName={sourceName} connected={connected}>
        {/* Coloured "tests: passed/failed/running" chip; clicking toggles the drawer. */}
        <TestBadge status={testStatus} onClick={() => setDrawerOpen((o) => !o)} />
      </TopBar>

      {/* Slide-in right-side drawer showing per-test results; auto-opens on failure. */}
      <TestDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        status={testStatus}
        onRerun={rerunTests}
      />

      {/* Main two-column layout: left panel with the feed + banners, right panel with the Copilot. */}
      <div className={styles.app}>
        <section className={styles.panel}>
          {/* Four summary tiles at the top: Total events / High / Medium / Uptime. */}
          <SummaryTiles
            total={counts.total}
            high={counts.high}
            medium={counts.medium}
            uptimeSec={uptimeSec}
          />
          {/* Perception banner (e.g. "Night — low light"). */}
          <PerceptionBannerRow perception={mergedPerception} />
          {/* Scene banner (e.g. "Urban · high pedestrian rate"). */}
          <SceneBannerRow scene={scene} />
          {/* Drift banner with refresh button — surfaces precision trend shifts. */}
          <DriftBannerRow drift={drift} onRefresh={refreshDrift} />

          {/* Filter bar: risk dropdown + type dropdown + optional Clear button + count. */}
          <div className={styles.filterBar}>
            {/* Risk dropdown — filters the event list by risk_level. */}
            <select
              className={styles.filterSelect}
              value={filterRisk}
              onChange={(e) => setFilterRisk(e.target.value)}
            >
              <option value="">All risks</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
            </select>
            {/* Type dropdown — options built dynamically from the live events. */}
            <select
              className={styles.filterSelect}
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
            >
              <option value="">All types</option>
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {humanEventType(t)}
                </option>
              ))}
            </select>
            {/* "Clear" button — only visible while at least one filter is active. */}
            {hasFilters && (
              <button
                className={styles.clearBtn}
                onClick={() => {
                  setFilterRisk("");
                  setFilterType("");
                }}
              >
                Clear
              </button>
            )}
            {/* Small right-aligned "N / M events" counter. */}
            <span className={styles.filterCount}>
              {hasFilters
                ? `${filtered.length} / ${events.length}`
                : `${events.length}`}{" "}
              events
            </span>
          </div>

          {/* Scrolling live event feed — one EventCard per filtered event. */}
          <div className={styles.stream}>
            {/* Placeholder before any events arrive. */}
            {events.length === 0 && (
              <div className={styles.empty}>Waiting for events…</div>
            )}
            {/* Placeholder when events exist but filters excluded them all. */}
            {events.length > 0 && filtered.length === 0 && (
              <div className={styles.empty}>No events match filters</div>
            )}
            {/* The first card (i === 0) gets isNew so it can animate in. */}
            {filtered.map((ev, i) => (
              <EventCard key={ev.event_id} event={ev} isNew={i === 0} />
            ))}
          </div>
        </section>

        {/* Right-hand Copilot chat panel — LLM Q&A over live data. */}
        <CopilotPanel />
      </div>
    </>
  );
}
