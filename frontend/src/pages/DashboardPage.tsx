/**
 * DashboardPage — fleet overview + LLM copilot.
 *
 * Route binding:
 *   Rendered by <Route path="/" element={<DashboardPage/>} /> in
 *   frontend/src/App.tsx (the default landing page).
 *
 * What the user sees (plain English):
 *   - A top bar with the current video source, SSE connection dot, and a
 *     TestBadge button that opens a slide-in TestDrawer.
 *   - A grid of tiles: total / high / medium event counts and uptime.
 *   - Three banner rows: perception health, current scene context (urban,
 *     highway, …), and model drift status.
 *   - A filter bar (risk dropdown + event-type dropdown + Clear button) that
 *     narrows the event stream below.
 *   - A live stream of EventCard tiles, newest-first.
 *   - On the right: CopilotPanel — a chat that asks the LLM about fleet state.
 *
 * Hooks called:
 *   - useEventStream()  → { events, perception, connected, counts }
 *       See hooks/useEventStream.ts. Wraps an EventSource to /api/live/stream,
 *       keeps a trimmed event buffer, and derives roll-up counters.
 *   - useLiveStatus()   → { data: liveStatus }
 *       See hooks/useLiveStatus.ts. HTTP poll of /api/live/status — giving the
 *       source name, server start time, perception snapshot, etc.
 *   - useScene()        → { data: scene }            — current scene tag.
 *   - useDrift()        → { data: drift, refetch }   — drift report + refresh.
 *   - useTests()        → { status, rerun }          — CI-style in-app tests.
 *   - useState / useRef / useEffect / useMemo        — local state & memoisation.
 *
 * Child components composed here:
 *   - components/layout/TopBar.tsx
 *   - components/dashboard/SummaryTiles.tsx
 *   - components/dashboard/PerceptionBanner.tsx (exports PerceptionBannerRow)
 *   - components/dashboard/SceneBannerRow
 *   - components/dashboard/DriftBannerRow
 *   - components/dashboard/CopilotPanel.tsx    — the chat pipeline.
 *   - components/events/EventCard.tsx          — one event in the stream.
 *   - components/tests/TestBadge.tsx + TestDrawer.tsx
 *
 * React concepts demonstrated:
 *   - Lifting state up: `drawerOpen` lives here and is pushed down to both
 *     TestBadge (via onClick) and TestDrawer (via open/onClose).
 *   - Controlled inputs: the two <select> elements bind `value` to state and
 *     update via `onChange` — React's canonical form pattern.
 *   - useMemo for derived lists (`eventTypes`, `filtered`) — avoids rebuilding
 *     arrays each render and stabilises references for child props.
 *   - useRef to hold a mutable value that does NOT trigger re-renders
 *     (`prevTestStatus`).
 *   - Conditional rendering with `&&` and with `{cond ? a : b}`.
 *   - List rendering with `key` and with an index-based `isNew` flag.
 *   - CSS Modules for scoped styling (`styles.filterBar`, …).
 *
 * Page-specific mechanics:
 *   - Polling vs push: useLiveStatus/useScene/useDrift/useTests poll HTTP
 *     endpoints on an interval; useEventStream receives pushes over SSE. This
 *     page mixes both — counts update instantly, status updates lag by a tick.
 *   - Chat send pipeline: CopilotPanel owns its own state and POSTs to the
 *     LLM backend. The pipeline preserves the privacy invariant documented in
 *     CLAUDE.md (no raw plate text leaves the edge node).
 *   - Scoring decay: counts/driver scores are rendered by SummaryTiles; decay
 *     cadence is controlled server-side by ROAD_SCORE_DECAY_INTERVAL_SEC.
 *   - Drawer auto-open: when tests flip running → failed, the TestDrawer pops
 *     open automatically (see the useEffect below).
 */

// TEACH: We import multiple hooks in one line. React re-exports them as named
// exports, so `import { useState } from "react"` binds `React.useState`.
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
import { useEventStream } from "../hooks/useEventStream";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useScene } from "../hooks/useScene";
import { useDrift } from "../hooks/useDrift";
import { useTests } from "../hooks/useTests";
import { humanEventType } from "../lib/format";
// TEACH: CSS Modules — see the matching DashboardPage.module.css file. Each
// key on `styles` maps to a generated, scoped class name at build time.
import styles from "./DashboardPage.module.css";

export function DashboardPage() {
  // --- Hooks ---
  // TEACH: Destructuring assignment. `{ events, perception, connected, counts }`
  // unpacks those fields from the hook's return object into local `const`s.
  const { events, perception, connected, counts } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  const { data: scene } = useScene();
  const { data: drift, refetch: refreshDrift } = useDrift();
  const { status: testStatus, rerun: rerunTests } = useTests();

  // TEACH: Local UI state — drawer open/closed, filter selections. Each
  // `useState` call creates ONE piece of state; React identifies it by the
  // order of the call. Do not put useState inside an `if`.
  const [drawerOpen, setDrawerOpen] = useState(false);
  // TEACH: useRef returns a stable `{ current }` box that survives re-renders
  // and DOES NOT cause re-renders when `.current` is written. Use it for
  // "previous value" trackers, DOM refs, or any mutable handle.
  const prevTestStatus = useRef<string>("idle");

  const [filterRisk, setFilterRisk] = useState("");
  const [filterType, setFilterType] = useState("");

  // TEACH: Auto-open the TestDrawer when tests flip running→failed. This
  // effect depends on `testStatus?.status`; the optional chain lets React
  // compare undefined safely while the hook's first fetch is in flight.
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
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);

  // TEACH: Uptime ticker identical in shape to AdminPage — a `setInterval`
  // driven by a useEffect that cleans up with `clearInterval` on unmount.
  useEffect(() => {
    if (!liveStatus?.started_at) return;
    const tick = () => {
      setUptimeSec(Math.max(0, Date.now() / 1000 - liveStatus.started_at!));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [liveStatus?.started_at]);

  // --- Derived state ---
  // TEACH: Prefer the push (SSE) value when we have one, fall back to the
  // polled value. Precedence through `??` lets the dashboard render useful
  // data the moment either source has fired once.
  const mergedPerception = perception ?? (liveStatus?.perception || null);

  // TEACH: useMemo caches a computed value so long as its deps don't change.
  // Rebuilding this Set is cheap, but stable *references* help: when passed to
  // a memoised child, a new array identity forces unnecessary re-renders.
  const eventTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const ev of events) if (ev.event_type) seen.add(ev.event_type);
    return Array.from(seen).sort();
  }, [events]);

  // TEACH: Derive the filtered list from `events + filterRisk + filterType`.
  // Memoising keeps the array identity stable when filters are unchanged,
  // which matters for <EventCard> animation logic driven by identity.
  const filtered = useMemo(() => {
    let list = events;
    if (filterRisk) list = list.filter((e) => e.risk_level === filterRisk);
    if (filterType) list = list.filter((e) => e.event_type === filterType);
    return list;
  }, [events, filterRisk, filterType]);

  const hasFilters = filterRisk !== "" || filterType !== "";

  // --- Render ---
  return (
    <>
      {/* Top bar passes status pieces + a child TestBadge for test state. */}
      <TopBar sourceName={sourceName} connected={connected}>
        {/* TEACH: Event handler. `onClick={() => ...}` creates a fresh arrow
            function per render. That's usually fine here because TestBadge
            isn't memoised. If we ever wrap TestBadge in React.memo, we'd pass
            a useCallback-wrapped handler to keep its identity stable.
            The setter form `setDrawerOpen(o => !o)` is the "functional update"
            pattern — read-modify-write without racing against a stale value. */}
        <TestBadge status={testStatus} onClick={() => setDrawerOpen((o) => !o)} />
      </TopBar>

      {/* TestDrawer is controlled via lifted state: DashboardPage owns
          `drawerOpen`, TestBadge requests toggle, TestDrawer is displayed. */}
      <TestDrawer
        open={drawerOpen}
        onClose={() => setDrawerOpen(false)}
        status={testStatus}
        onRerun={rerunTests}
      />

      <div className={styles.app}>
        <section className={styles.panel}>
          {/* KPI tiles (total events, high risk, medium risk, uptime). */}
          <SummaryTiles
            total={counts.total}
            high={counts.high}
            medium={counts.medium}
            uptimeSec={uptimeSec}
          />
          {/* Three banner rows — each is a small presentational component. */}
          <PerceptionBannerRow perception={mergedPerception} />
          <SceneBannerRow scene={scene} />
          <DriftBannerRow drift={drift} onRefresh={refreshDrift} />

          {/* --- Filter bar (controlled inputs) --- */}
          <div className={styles.filterBar}>
            {/* TEACH: Controlled input — `value` binds to React state, and
                `onChange` pushes every edit back into state. React becomes the
                single source of truth; the DOM element only mirrors it. */}
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
            <select
              className={styles.filterSelect}
              value={filterType}
              onChange={(e) => setFilterType(e.target.value)}
            >
              <option value="">All types</option>
              {/* TEACH: List rendering with a mapped .map(). `key={t}` uses
                  the event-type string itself — unique because `eventTypes`
                  is built from a Set. */}
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {humanEventType(t)}
                </option>
              ))}
            </select>
            {/* TEACH: Conditional with `&&` — render the Clear button only
                when at least one filter is active. */}
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
            <span className={styles.filterCount}>
              {/* Ternary with template strings — shows "N / M events" when
                  filtering, "M events" when not. */}
              {hasFilters
                ? `${filtered.length} / ${events.length}`
                : `${events.length}`}{" "}
              events
            </span>
          </div>

          {/* --- Event stream --- */}
          <div className={styles.stream}>
            {/* Empty/zero-match states — plain conditional fragments. */}
            {events.length === 0 && (
              <div className={styles.empty}>Waiting for events…</div>
            )}
            {events.length > 0 && filtered.length === 0 && (
              <div className={styles.empty}>No events match filters</div>
            )}
            {/* TEACH: The second argument to .map is the index. We use it
                here only to flag the *first* item as `isNew` so EventCard can
                animate the most-recent arrival; `key` is still `event_id`, a
                stable unique identifier from the backend. Never use the
                index as `key` in a list that can reorder — it breaks React's
                reconciliation and causes lost component state. */}
            {filtered.map((ev, i) => (
              <EventCard key={ev.event_id} event={ev} isNew={i === 0} />
            ))}
          </div>
        </section>

        {/* Chat-with-fleet copilot (self-contained; talks to LLM backend). */}
        <CopilotPanel />
      </div>
    </>
  );
}
