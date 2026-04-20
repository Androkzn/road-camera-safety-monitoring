/**
 * DashboardPage — fleet overview + LLM copilot.
 *
 * Reads (mostly via TanStack Query): live status, scene context, drift,
 * pytest status, plus the SSE event stream. Owns local UI state for the
 * filter bar and TestDrawer toggle. Everything else is composition.
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

export function DashboardPage() {
  const { events, perception, connected, clearEvents } = useEventStream();
  // D8: derive counts from the current `events` buffer instead of a ref —
  // the prior `counts: ref.current` shape silently stopped re-rendering
  // when a count changed without a new event pushing. `events` is capped
  // at ~100 in the provider so this is always O(100) at most.
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
  const prevTestStatus = useRef<string>("idle");

  const [filterRisk, setFilterRisk] = useState("");
  const [filterType, setFilterType] = useState("");
  const [showLow, setShowLow] = useState(false);
  // Event-detail modal: clicking any EventCard opens the same dialog
  // already used by the validation page, so reviewers can scrub the
  // annotated \u00b13s clip without leaving the dashboard.
  const [selectedEvent, setSelectedEvent] = useState<SafetyEvent | null>(null);

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
