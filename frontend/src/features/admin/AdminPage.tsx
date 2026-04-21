/**
 * AdminPage — live detection feed orchestrator.
 *
 * Owns:
 *   - SSE connection (events + perception state) via useEventStream
 *   - Per-frame detection stats via useDetections (SSE)
 *   - Admin health snapshot via useAdminHealth (TanStack Query)
 *   - Multi-source lifecycle via useLiveSources (TanStack Query)
 *   - Local UI state for the focused source
 *
 * Composition: TopBar → SelectedStreamHeader → optional HealthStrip →
 *              MultiSourceGrid + Tabs(Detections | Events | History).
 *
 * --- UI mapping ---
 * Page: AdminPage ([AdminPage.tsx](frontend/src/features/admin/AdminPage.tsx))
 * UI element: the entire admin shell — orchestrates the focused-stream
 *   header, optional pipeline-health strip, the live video grid, and the
 *   right-hand tabs that switch between live detections, the live events
 *   list, and the past-events history list.
 * Backend: GET /api/admin/health (health snapshot), GET /api/live/sources
 *   (multi-source lifecycle, via useLiveSources), SSE /stream/events (shared
 *   event stream consumed through useEventStream), SSE /admin/detections
 *   (per-frame detection stats consumed through useDetections).
 */

import { useEffect, useMemo, useState } from "react";

import { POLL_INTERVAL_MS } from "../../shared/config/runtime";
import { EventDialog } from "../../shared/events";
import { useEventStream } from "../../shared/hooks/useEventStream";
import { useUptimeTicker } from "../../shared/hooks/useUptimeTicker";
import { PageChrome } from "../../shared/layout/PageChrome";
import { Pill, Tabs } from "../../shared/ui";
import { formatUptime } from "../../shared/lib/format";
import type { SafetyEvent } from "../../shared/types/common";

import {
  AdminEventCard,
  DetectionsPanel,
  HealthStrip,
  HistoryPanel,
  MultiSourceGrid,
  SelectedStreamHeader,
} from "./components";
import { useAdminHealth } from "./hooks/useAdminHealth";
import { useDetections } from "./hooks/useDetections";
import { useLiveSources } from "./hooks/useLiveSources";

import styles from "./AdminPage.module.css";

export function AdminPage() {
  // Polled snapshot of server + per-source health (GET /api/admin/health).
  const { data: health } = useAdminHealth();
  // Per-frame detection stream (SSE /api/admin/detections) used by DetectionsPanel.
  const { frames } = useDetections();
  // Single app-wide SSE connection to /api/events/stream; `connected` drives the
  // live/offline pill in PageChrome, `liveEvents` feeds the Events tab.
  const { events: liveEvents, connected } = useEventStream();
  // TanStack-Query-backed list of live sources (GET /api/live/sources) with
  // start/pause/add/remove mutations; polled at POLL_INTERVAL_MS.liveSources.
  const liveSources = useLiveSources(POLL_INTERVAL_MS.liveSources);

  // The event the user clicked; drives the <EventDialog> at the bottom.
  const [selectedEvent, setSelectedEvent] = useState<SafetyEvent | null>(null);

  // Persist the "focused" tile (single-stream zoom) across reloads so the
  // operator's last selection isn't lost on refresh. SSR guard covers test envs.
  const [focusedId, setFocusedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("road_admin_focused_id");
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (focusedId) window.localStorage.setItem("road_admin_focused_id", focusedId);
    else window.localStorage.removeItem("road_admin_focused_id");
    // LivePreviewCard on SettingsPage subscribes to this CustomEvent to
    // mirror the focused stream selection when both pages are open in the
    // same tab. The `storage` event covers cross-tab updates.
    window.dispatchEvent(new CustomEvent("admin-focused-id-changed"));
  }, [focusedId]);

  // Drop focus if the focused source disappeared (operator removed it).
  useEffect(() => {
    if (focusedId && !liveSources.sources.some((s) => s.id === focusedId)) {
      setFocusedId(null);
    }
  }, [focusedId, liveSources.sources]);

  // Resolve the source shown in the header/health strip. Priority: explicit
  // focus → backend-designated primary → first source in the list.
  const selectedSource = useMemo(() => {
    const list = liveSources.sources;
    if (list.length === 0) return null;
    if (focusedId) {
      const hit = list.find((s) => s.id === focusedId);
      if (hit) return hit;
    }
    if (liveSources.primaryId) {
      const primary = list.find((s) => s.id === liveSources.primaryId);
      if (primary) return primary;
    }
    return list[0] ?? null;
  }, [focusedId, liveSources.primaryId, liveSources.sources]);

  // Uptime pill: re-tick every second locally rather than refetching /health.
  const startedAt = health?.server.started_at ?? null;
  const tickerSec = useUptimeTicker(startedAt);
  const uptimeSec = startedAt === null ? null : tickerSec;

  // Hide low-risk noise from the Events tab by default — operator opts in.
  const [showLowEvents, setShowLowEvents] = useState(false);
  const visibleEvents = useMemo(
    () => (showLowEvents ? liveEvents : liveEvents.filter((ev) => ev.risk_level !== "low")),
    [liveEvents, showLowEvents],
  );
  const hiddenLowCount = liveEvents.length - visibleEvents.length;
  const evtCount = visibleEvents.length;

  return (
    <>
      <PageChrome
        page="admin"
        sourceName={health?.server.source ?? "—"}
        connected={connected}
        testBadge={
          <Pill style={{ marginLeft: 8 }}>
            uptime <strong style={{ marginLeft: 4 }}>{formatUptime(uptimeSec)}</strong>
          </Pill>
        }
      />

      <SelectedStreamHeader
        source={selectedSource}
        isFocused={!!focusedId && selectedSource?.id === focusedId}
        totalSources={liveSources.sources.length}
        onClear={() => setFocusedId(null)}
      />

      {focusedId && <HealthStrip health={health ?? null} />}

      <div className={styles.main}>
        <div className={styles.leftCol}>
          <MultiSourceGrid
            focusedId={focusedId}
            onFocusChange={setFocusedId}
          />
        </div>

        <div className={styles.sidebar}>
          <Tabs
            defaultTab="events"
            tabs={[
              {
                id: "events",
                label: (
                  <>
                    Events{" "}
                    {evtCount > 0 && (
                      <span style={{ fontSize: "10px", color: "var(--muted)" }}>({evtCount})</span>
                    )}
                  </>
                ),
                content: (
                  <>
                    <div className={styles.evtControls}>
                      <label>
                        <input
                          type="checkbox"
                          checked={showLowEvents}
                          onChange={(e) => setShowLowEvents(e.target.checked)}
                        />
                        Show low risk
                        {hiddenLowCount > 0 && !showLowEvents ? ` (${hiddenLowCount} hidden)` : ""}
                      </label>
                    </div>
                    <div className={styles.evtList}>
                      {visibleEvents.length === 0 ? (
                        <div className={styles.empty}>
                          {liveEvents.length === 0
                            ? "No events yet — they appear here in real time"
                            : "No events match the current filter"}
                        </div>
                      ) : (
                        visibleEvents.map((ev) => (
                          <AdminEventCard key={ev.event_id} event={ev} onSelect={setSelectedEvent} />
                        ))
                      )}
                    </div>
                  </>
                ),
              },
              {
                id: "detections",
                label: "Detections",
                content: <DetectionsPanel frames={frames} />,
              },
              {
                id: "history",
                label: "History",
                content: <HistoryPanel />,
              },
            ]}
          />
        </div>
      </div>
      <EventDialog event={selectedEvent} onClose={() => setSelectedEvent(null)} />
    </>
  );
}
