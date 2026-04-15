import { useState, useEffect } from "react";
import { TopBar } from "../components/layout/TopBar";
import { Pill } from "../components/ui";
import { HealthStrip, VideoFeed, DetectionsPanel, HistoryPanel, TabBar } from "../components/admin";
import { AdminEventCard } from "../components/events";
import { useAdminHealth } from "../hooks/useAdminHealth";
import { useDetections } from "../hooks/useDetections";
import { useEventStream } from "../hooks/useEventStream";
import { formatUptime } from "../lib/format";
import styles from "./AdminPage.module.css";

export function AdminPage() {
  const { data: health } = useAdminHealth();
  const { frames, stats } = useDetections();
  const { events: liveEvents } = useEventStream();

  const isRunning = health?.server.running ?? false;
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

  return (
    <>
      <TopBar
        sourceName={health?.server.source ?? "—"}
        connected={isRunning ? true : isRunning === false ? false : undefined}
      >
        <Pill style={{ marginLeft: 8 }}>
          uptime <strong style={{ marginLeft: 4 }}>{formatUptime(uptimeSec)}</strong>
        </Pill>
      </TopBar>

      <HealthStrip health={health} />

      <div className={styles.main}>
        <VideoFeed stats={stats} />

        <div className={styles.sidebar}>
          <TabBar
            defaultTab="detections"
            tabs={[
              {
                id: "detections",
                label: "Detections",
                content: <DetectionsPanel frames={frames} />,
              },
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
