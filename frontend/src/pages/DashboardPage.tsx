import { useState, useEffect, useRef } from "react";
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
import { WatchdogBadge, WatchdogDrawer } from "../components/watchdog";
import { useEventStream } from "../hooks/useEventStream";
import { useLiveStatus } from "../hooks/useLiveStatus";
import { useScene } from "../hooks/useScene";
import { useDrift } from "../hooks/useDrift";
import { useTests } from "../hooks/useTests";
import { useWatchdog } from "../hooks/useWatchdog";
import styles from "./DashboardPage.module.css";

export function DashboardPage() {
  const { events, perception, connected, counts } = useEventStream();
  const { data: liveStatus } = useLiveStatus();
  const { data: scene } = useScene();
  const { data: drift, refetch: refreshDrift } = useDrift();
  const { status: testStatus, rerun: rerunTests } = useTests();
  const { status: wdStatus, findings: wdFindings } = useWatchdog();

  const [drawerOpen, setDrawerOpen] = useState(false);
  const [wdDrawerOpen, setWdDrawerOpen] = useState(false);
  const prevTestStatus = useRef<string>("idle");

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

  return (
    <>
      <TopBar sourceName={sourceName} connected={connected}>
        <WatchdogBadge status={wdStatus} onClick={() => setWdDrawerOpen((o) => !o)} />
        <TestBadge status={testStatus} onClick={() => setDrawerOpen((o) => !o)} />
      </TopBar>

      <WatchdogDrawer
        open={wdDrawerOpen}
        onClose={() => setWdDrawerOpen(false)}
        status={wdStatus}
        findings={wdFindings}
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
          <SceneBannerRow scene={scene} />
          <DriftBannerRow drift={drift} onRefresh={refreshDrift} />
          <div className={styles.stream}>
            {events.length === 0 && (
              <div className={styles.empty}>Waiting for events…</div>
            )}
            {events.map((ev, i) => (
              <EventCard key={ev.event_id} event={ev} isNew={i === 0} />
            ))}
          </div>
        </section>

        <CopilotPanel />
      </div>
    </>
  );
}
