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
import styles from "./DashboardPage.module.css";

export function DashboardPage() {
  const { events, perception, connected, counts } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  const { data: scene } = useScene();
  const { data: drift, refetch: refreshDrift } = useDrift();
  const { status: testStatus, rerun: rerunTests } = useTests();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const prevTestStatus = useRef<string>("idle");

  const [filterRisk, setFilterRisk] = useState("");
  const [filterType, setFilterType] = useState("");

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

  useEffect(() => {
    if (!liveStatus?.started_at) return;
    const tick = () => {
      setUptimeSec(Math.max(0, Date.now() / 1000 - liveStatus.started_at!));
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [liveStatus?.started_at]);

  const mergedPerception = perception ?? (liveStatus?.perception || null);

  const eventTypes = useMemo(() => {
    const seen = new Set<string>();
    for (const ev of events) if (ev.event_type) seen.add(ev.event_type);
    return Array.from(seen).sort();
  }, [events]);

  const filtered = useMemo(() => {
    let list = events;
    if (filterRisk) list = list.filter((e) => e.risk_level === filterRisk);
    if (filterType) list = list.filter((e) => e.event_type === filterType);
    return list;
  }, [events, filterRisk, filterType]);

  const hasFilters = filterRisk !== "" || filterType !== "";

  return (
    <>
      <TopBar sourceName={sourceName} connected={connected}>
        <TestBadge status={testStatus} onClick={() => setDrawerOpen((o) => !o)} />
      </TopBar>

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
          <SceneBannerRow scene={scene} />
          <DriftBannerRow drift={drift} onRefresh={refreshDrift} />

          <div className={styles.filterBar}>
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
              {eventTypes.map((t) => (
                <option key={t} value={t}>
                  {humanEventType(t)}
                </option>
              ))}
            </select>
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
              {hasFilters
                ? `${filtered.length} / ${events.length}`
                : `${events.length}`}{" "}
              events
            </span>
          </div>

          <div className={styles.stream}>
            {events.length === 0 && (
              <div className={styles.empty}>Waiting for events…</div>
            )}
            {events.length > 0 && filtered.length === 0 && (
              <div className={styles.empty}>No events match filters</div>
            )}
            {filtered.map((ev, i) => (
              <EventCard key={ev.event_id} event={ev} isNew={i === 0} />
            ))}
          </div>
        </section>

        <CopilotPanel />
      </div>
    </>
  );
}
