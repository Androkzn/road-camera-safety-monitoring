/**
 * MonitoringPage — watchdog incident queue (composition shell).
 *
 * The watchdog emits *fingerprinted* incidents — not a scrolling log tail.
 * Many raw error lines that share a fingerprint collapse into one card
 * with a "Seen Nx" pill. This keeps the operator's queue actionable
 * instead of a wall of red (see `services/watchdog.py` on the backend).
 *
 * All grouping/severity/sorting lives in `utils/incidents.ts`.
 * Filtering, selection, and bulk actions live in `useMonitoringIncidents`.
 * Each visual block is its own component under `components/`.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: the whole Monitoring screen — page chrome at the top, the
 *   summary header with title and Select / Clear-All buttons, the four
 *   filter tiles, the three meta cards, the optional bulk-select toolbar,
 *   the Immediate Actions strip, and the scrolling incident feed below.
 * Backend: GET /api/live/status, GET /api/live/stream (SSE),
 *   plus watchdog finding fetch/delete via the watchdog feature context.
 */

// Cross-feature hooks come from `shared/`. Feature code must never reach
// into another feature's folder — that would break the feature boundary.
import { useEventStreamConnection } from "../../shared/hooks/useEventStream";
import { useLiveStatus } from "../../shared/hooks/useLiveStatus";
import { PageChrome } from "../../shared/layout/PageChrome";
// `watchdog` is a sibling feature that owns the shared watchdog context.
// It's exposed via a barrel so this import stays on the public surface.
import { useWatchdogCtx } from "../watchdog";

// Barrel import: each named export lives in its own file under `components/`.
import {
  IncidentFeed,
  ImmediateActions,
  MetaGrid,
  SelectionBar,
  SummaryGrid,
  SummaryHeader,
} from "./components";
import { useMonitoringIncidents } from "./hooks/useMonitoringIncidents";

// CSS Modules: `styles.page` becomes a unique auto-generated class name,
// so styles scoped here can't collide with styles from other pages.
import styles from "./MonitoringPage.module.css";

/**
 * The Monitoring page. Pure composition — all state lives in hooks and
 * all rendering lives in sub-components. Makes the page file easy to read
 * and keeps the heavy logic (grouping, filtering, bulk delete) testable.
 */
export function MonitoringPage() {
  // Custom hooks return whatever the hook wants — here a boolean "SSE
  // stream connected?" flag, a TanStack-Query result with `.data`, and
  // the context value from <WatchdogProvider>. Destructure only what you use.
  const connected = useEventStreamConnection();
  const { data: liveStatus } = useLiveStatus();
  const { status, findings, deleteFindings, clearAll } = useWatchdogCtx();

  // One fat custom hook owns all derived state for this page — filter,
  // selection, bulk-action orchestration, counts, and the immediate-action
  // queue. Keeps MonitoringPage free of business logic.
  const {
    filter,
    showLow,
    setShowLow,
    selectMode,
    setSelectMode,
    selected,
    setSelected,
    deleting,
    filtered,
    errors,
    warnings,
    infos,
    totalIncidents,
    repeatingIncidents,
    actionQueue,
    toggle,
    exitSelectMode,
    toggleSelect,
    selectAllVisible,
    handleDeleteSelected,
    handleClearAll,
  } = useMonitoringIncidents({ findings, deleteFindings, clearAll });

  // `?.` is optional chaining — if `liveStatus` is undefined this yields
  // undefined instead of throwing. `??` is the nullish-coalesce operator:
  // fall back only when the left side is null/undefined (NOT 0 or "").
  const sourceName = liveStatus?.source ?? "—";

  // JSX = HTML-like syntax that compiles to React.createElement calls.
  // `<>…</>` is a Fragment — groups siblings without adding a DOM node.
  return (
    <>
      <PageChrome page="monitoring" sourceName={sourceName} connected={connected} />

      <div className={styles.page}>
        <div className={styles.header}>
          <SummaryHeader
            selectMode={selectMode}
            totalIncidents={totalIncidents}
            filteredCount={filtered.length}
            deleting={deleting}
            // Inline arrow functions hand callbacks to children. Cheap here
            // because SummaryHeader is small — optimise with useCallback
            // only if a child is memoised and re-renders are a problem.
            onEnterSelect={() => setSelectMode(true)}
            onClearAll={handleClearAll}
          >
            {/* Children passed via JSX nesting, received by the parent as
                `children` prop. Lets us slot arbitrary content into slots. */}
            <label className={styles.showLow}>
              <input
                type="checkbox"
                checked={showLow}
                // Controlled input: value comes from React state, React
                // writes it back in onChange. The event is synthetic, not
                // a raw DOM Event — React normalises across browsers.
                onChange={(e) => setShowLow(e.target.checked)}
              />
              Show low severity
            </label>
          </SummaryHeader>

          <SummaryGrid
            errors={errors}
            warnings={warnings}
            infos={infos}
            totalIncidents={totalIncidents}
            filter={filter}
            onToggle={toggle}
            onShowAll={() => toggle("all")}
          />

          <MetaGrid
            status={status}
            filteredCount={filtered.length}
            repeatingIncidents={repeatingIncidents}
          />
        </div>

        {/* `{cond && <X/>}` is the standard React short-circuit render —
            if `cond` is false, nothing renders. The bar only appears in
            bulk-select mode. */}
        {selectMode && (
          <SelectionBar
            selectedCount={selected.size}
            filteredCount={filtered.length}
            deleting={deleting}
            onSelectAll={selectAllVisible}
            onDeselectAll={() => setSelected(new Set())}
            onDeleteSelected={handleDeleteSelected}
            onCancel={exitSelectMode}
          />
        )}

        <div className={styles.content}>
          <ImmediateActions incidents={actionQueue} />
          <IncidentFeed
            filter={filter}
            status={status}
            incidents={filtered}
            selectMode={selectMode}
            selected={selected}
            onToggleSelect={toggleSelect}
            onDelete={(rawKeys) => deleteFindings(rawKeys)}
          />
        </div>
      </div>
    </>
  );
}
