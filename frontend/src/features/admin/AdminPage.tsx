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

import { useEffect, useMemo, useState } from "react";

import { useEventStream } from "../../shared/hooks/useEventStream";
import { TopBar } from "../../shared/layout/TopBar";
import { Pill, Tabs } from "../../shared/ui";
import { formatUptime } from "../../shared/lib/format";
import { useWatchdogCtx } from "../watchdog";

import {
  AdminEventCard,
  DetectionsPanel,
  HealthStrip,
  HistoryPanel,
  MultiSourceGrid,
  SelectedStreamHeader,
  VehicleMap,
} from "./components";
import { useAdminHealth } from "./hooks/useAdminHealth";
import { useDetections } from "./hooks/useDetections";
import { useLiveSources } from "./hooks/useLiveSources";

import styles from "./AdminPage.module.css";

export function AdminPage() {
  const { data: health } = useAdminHealth();
  const { frames } = useDetections();
  const { events: liveEvents, connected } = useEventStream();
  const liveSources = useLiveSources(5000);
  const { status: wdStatus } = useWatchdogCtx();

  const [focusedId, setFocusedId] = useState<string | null>(() => {
    if (typeof window === "undefined") return null;
    return window.localStorage.getItem("road_admin_focused_id");
  });

  useEffect(() => {
    if (typeof window === "undefined") return;
    if (focusedId) window.localStorage.setItem("road_admin_focused_id", focusedId);
    else window.localStorage.removeItem("road_admin_focused_id");
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
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setUptimeSec(Date.now() / 1000 - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const evtCount = liveEvents.length;
  const isDashcam = selectedSource?.stream_type === "dashcam_file";

  // Pick the stream the map should follow. Preference order:
  //   1. The focused source if it's a running dashcam_file.
  //   2. Any running dashcam_file.
  //   3. The primary source (even if paused, so the badge is still useful).
  // This lets the map sync to whichever camera is actually producing frames
  // when the primary is a placeholder / paused.
  const mapClockSource = useMemo(() => {
    const list = liveSources.sources;
    if (list.length === 0) return null;
    const focused = focusedId ? list.find((s) => s.id === focusedId) : null;
    if (focused?.stream_type === "dashcam_file" && focused.running) {
      return focused;
    }
    const runningDash = list.find(
      (s) => s.stream_type === "dashcam_file" && s.running,
    );
    if (runningDash) return runningDash;
    return selectedSource;
  }, [liveSources.sources, focusedId, selectedSource]);

  // Debug: inspect which stream is driving the map.
  useEffect(() => {
    if (!mapClockSource) return;
    console.debug("[map-sync] clock source:", {
      id: mapClockSource.id,
      name: mapClockSource.name,
      running: mapClockSource.running,
      uptime_sec: mapClockSource.uptime_sec,
      frames: mapClockSource.frames_processed,
    });
  }, [
    mapClockSource?.id,
    mapClockSource?.running,
    mapClockSource?.uptime_sec,
  ]);

  return (
    <>
      <TopBar
        sourceName={health?.server.source ?? "—"}
        connected={connected}
        errorCount={wdStatus?.by_severity?.error ?? 0}
      >
        <Pill style={{ marginLeft: 8 }}>
          uptime{" "}
          <strong style={{ marginLeft: 4 }}>{formatUptime(uptimeSec)}</strong>
        </Pill>
      </TopBar>

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
            liveSources={liveSources}
            focusedId={focusedId}
            onFocusChange={setFocusedId}
          />
          {isDashcam && mapClockSource && (
            <div className={styles.mapSlot}>
              <VehicleMap
                videoKey="front"
                clock={{
                  // Wallclock since stream start — works for any transport
                  // (MJPEG, polled JPEGs, file-loop). With ``videoKey`` set
                  // the track is already in video time, so the marker is
                  // driven directly by the playhead (no loop compression).
                  uptimeSec: mapClockSource.uptime_sec,
                  running: mapClockSource.running,
                  videoDurationSec: null,
                }}
              />
            </div>
          )}
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
                      <span style={{ fontSize: "10px", color: "var(--muted)" }}>
                        ({evtCount})
                      </span>
                    )}
                  </>
                ),
                content: (
                  <div className={styles.evtList}>
                    {liveEvents.length === 0 ? (
                      <div className={styles.empty}>
                        No events yet — they appear here in real time
                      </div>
                    ) : (
                      liveEvents.map((ev) => (
                        <AdminEventCard key={ev.event_id} event={ev} />
                      ))
                    )}
                  </div>
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
