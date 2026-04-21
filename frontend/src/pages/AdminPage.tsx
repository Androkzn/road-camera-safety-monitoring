/**
 * AdminPage.tsx — admin console page at "/" showing live camera health.
 *
 * What it does:
 *   Renders the operator admin view: top bar with server source + uptime,
 *   a health strip, the live video feed with detection stats, and a
 *   tabbed sidebar that toggles between Detections / Events / History.
 *
 * Purpose:
 *   The home screen for the dashcam operator. Used to verify the pipeline
 *   is running, watch events arrive in real time, and browse past events.
 *
 * How it works:
 *   - Custom hooks load the data this page needs:
 *       useAdminHealth()  → polls /api/admin/health for server stats
 *       useDetections()   → subscribes to /admin/detections SSE stream
 *       useEventStream()  → subscribes to /stream/events SSE stream
 *     (A "custom hook" is a reusable function starting with `use` that
 *     encapsulates stateful logic — see files in frontend/src/hooks/.)
 *   - useState: stores a value that re-renders the component when changed;
 *     here it holds the live uptime counter in seconds.
 *   - useEffect: runs side-effects after the component renders. The effect
 *     here starts a setInterval tick every second to refresh uptime, and
 *     returns a cleanup function that clearInterval()s it when the component
 *     unmounts or `startedAt` changes.
 *   - `??` is the "nullish coalescing" operator — returns the right side if
 *     the left is null or undefined.
 *   - The tabs are driven by a `tabs` array with id/label/content shapes;
 *     <TabBar> switches between them via internal state.
 *
 * Connects to:
 *   - Backend: /api/admin/health (poll), /admin/detections (SSE),
 *     /stream/events (SSE) — all defined in road_safety/server.py.
 *   - UI: mounted by frontend/src/App.tsx at path "/". Renders children from
 *     components/layout/TopBar, components/admin/{HealthStrip,VideoFeed,
 *     DetectionsPanel,HistoryPanel,TabBar}, and components/events/AdminEventCard.
 */
// React hooks: useState holds a value that re-renders on change; useEffect
// runs side-effects (timers, subscriptions) after render.
import { useState, useEffect } from "react";
import { TopBar } from "../components/layout/TopBar";
import { Pill } from "../components/ui";
import { HealthStrip, VideoFeed, DetectionsPanel, HistoryPanel, TabBar } from "../components/admin";
import { AdminEventCard } from "../components/events";
// Custom hooks bundle the data-fetching each panel needs.
import { useAdminHealth } from "../hooks/useAdminHealth";
import { useDetections } from "../hooks/useDetections";
import { useEventStream } from "../hooks/useEventStream";
import { formatUptime } from "../lib/format";
// CSS Modules: `styles.foo` = a locally-scoped classname generated at build time.
import styles from "./AdminPage.module.css";

// Renders the whole admin page at "/" — top bar, health strip, live video
// column, and a tabbed sidebar (Detections / Events / History).
export function AdminPage() {
  // Polls /api/admin/health — feeds HealthStrip + top-bar source/uptime pill.
  const { data: health } = useAdminHealth();
  // SSE /admin/detections — `frames` is the rolling buffer, `stats` the counters.
  const { frames, stats } = useDetections();
  // SSE /stream/events — `liveEvents` feeds the Events tab; `connected` the dot.
  const { events: liveEvents, connected } = useEventStream();

  // Optional chaining `?.` + nullish coalescing `??`: safely reads
  // health.server.started_at if health exists, otherwise falls back to null.
  const startedAt = health?.server.started_at ?? null;

  // Holds the ticking uptime in seconds shown in the top-bar pill.
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);

  // Runs whenever `startedAt` changes: starts a 1s interval that recomputes
  // uptime from the server start time. Returns a cleanup function that
  // clearInterval()s it when the component unmounts or startedAt changes.
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setUptimeSec(Date.now() / 1000 - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  // Used in the Events tab label to show a "(N)" counter.
  const evtCount = liveEvents.length;

  return (
    <>
      {/* Top navigation bar: source name + connection dot, with the uptime pill on the right. */}
      <TopBar
        sourceName={health?.server.source ?? "—"}
        connected={connected}
      >
        {/* "uptime 00:05:12" chip shown on the far right of the top bar. */}
        <Pill style={{ marginLeft: 8 }}>
          uptime <strong style={{ marginLeft: 4 }}>{formatUptime(uptimeSec)}</strong>
        </Pill>
      </TopBar>

      {/* Horizontal row of coloured status chips below the top bar (perception, scene, model, etc.). */}
      <HealthStrip health={health} />

      {/* Main two-column content area: live video on the left, tabbed sidebar on the right. */}
      <div className={styles.main}>
        {/* Live MJPEG video preview with the detection-count overlay. */}
        <VideoFeed stats={stats} />

        {/* Right-hand sidebar hosting the three tabs. */}
        <div className={styles.sidebar}>
          {/* Tab switcher: clicking a tab swaps the content area below it. */}
          <TabBar
            defaultTab="detections"
            tabs={[
              {
                // Tab 1: list of recent per-frame detection snapshots.
                id: "detections",
                label: "Detections",
                content: <DetectionsPanel frames={frames} />,
              },
              {
                // Tab 2: live event cards arriving over SSE.
                id: "events",
                label: (
                  <>
                    {/* Tab title with a small "(N)" badge when there are events. */}
                    Events{" "}
                    {evtCount > 0 && (
                      <span style={{ fontSize: "10px", color: "var(--muted)" }}>
                        ({evtCount})
                      </span>
                    )}
                  </>
                ),
                content: (
                  // Scrolling list of AdminEventCard items, one per live event.
                  <div className={styles.evtList}>
                    {liveEvents.length === 0 ? (
                      // Placeholder shown before the first event arrives.
                      <div className={styles.empty}>
                        No events yet — they appear here in real time
                      </div>
                    ) : (
                      // Maps each event to a card. `key` lets React diff the list efficiently.
                      liveEvents.map((ev) => (
                        <AdminEventCard key={ev.event_id} event={ev} />
                      ))
                    )}
                  </div>
                ),
              },
              {
                // Tab 3: paginated past-events browser (loaded from /api/events).
                id: "history",
                label: "History",
                content: <HistoryPanel />,
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}
