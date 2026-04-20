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
 */

import { useCallback, useEffect, useMemo, useState } from "react";

import { POLL_INTERVAL_MS } from "../../shared/config/runtime";
import { useEventStream } from "../../shared/hooks/useEventStream";
import { useUptimeTicker } from "../../shared/hooks/useUptimeTicker";
import { PageChrome } from "../../shared/layout/PageChrome";
import { Pill, Tabs } from "../../shared/ui";
import { formatUptime } from "../../shared/lib/format";

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
  const { data: health } = useAdminHealth();
  const { frames } = useDetections();
  const { events: liveEvents, connected, clearEvents } = useEventStream();
  const liveSources = useLiveSources(POLL_INTERVAL_MS.liveSources);

  const handleRestart = useCallback(async () => {
    clearEvents();
    await liveSources.restartAll();
  }, [clearEvents, liveSources]);

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

  const startedAt = health?.server.started_at ?? null;
  const tickerSec = useUptimeTicker(startedAt);
  const uptimeSec = startedAt === null ? null : tickerSec;

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
            onRestart={handleRestart}
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
                        visibleEvents.map((ev) => <AdminEventCard key={ev.event_id} event={ev} />)
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
    </>
  );
}
