/**
 * Tabs — minimal accessible tab strip. Pass `tabs` (id + label + content)
 * and an optional `defaultTab` id; Tabs handles the active state.
 *
 * Purpose: group related content into switchable panels without the
 *   weight of a router (intra-page navigation only).
 * Visual role: horizontal row of buttons above a single content panel.
 *   Styling lives entirely in `Tabs.module.css`.
 *
 * The label can be any ReactNode (string, fragment with a count badge,
 * etc.) so callers don't lose composability.
 *
 * State model: uncontrolled by default — Tabs owns the active id in
 *   local state. Pass `defaultTab` to seed it; pass `onChange` to also
 *   bubble the change to the parent for side effects (URL sync, query
 *   invalidation, telemetry). There is no fully-controlled `value` prop;
 *   if a caller needs that, promote to an external state machine.
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Used wherever a feature needs
 *   in-page tabs — for example AdminPage, SettingsPage, MonitoringPage.
 * UI element: horizontal tab strip with a clickable button per tab and a
 *   panel area below that swaps content based on the active tab.
 */
import { useState, type ReactNode } from "react";

import { cx } from "../lib/cx";
import styles from "./Tabs.module.css";

// Shape of a single tab entry. `id` must be unique within the strip; it
// is also used to derive the aria-controls / panel id for a11y linkage.
export interface TabSpec {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

// Props:
//   tabs       — ordered array of TabSpec; first non-disabled is shown if
//                no defaultTab is given.
//   defaultTab — initial active id (uncontrolled seed only, not sync'd).
//   onChange   — fired after internal state updates so parents can react
//                (e.g. push to router, refetch). Optional.
//   className  — extra class for the outer wrapper.
interface TabsProps {
  tabs: TabSpec[];
  defaultTab?: string;
  onChange?: (id: string) => void;
  className?: string;
}

/**
 * Tabs — controlled-by-default tab strip. `useState` holds the active id
 * internally; pass `onChange` to also bubble changes up to the parent.
 *
 * a11y: root uses role="tablist" with role="tab" buttons and a single
 *   role="tabpanel". `aria-selected` reflects active state and
 *   `aria-controls` links each tab to the panel id so screen readers
 *   can associate them. Disabled tabs use the native `disabled`
 *   attribute (keyboard focus is skipped automatically).
 */
export function Tabs({ tabs, defaultTab, onChange, className }: TabsProps) {
  // Active tab id — initial value falls back through `defaultTab` → first
  // tab → empty string so the component is robust to a zero-tab spec.
  const [active, setActive] = useState<string>(defaultTab ?? tabs[0]?.id ?? "");
  // Resolve the active spec; if the caller mutates `tabs` and drops the
  // active id, fall back to the first tab rather than rendering nothing.
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const cls = cx(styles.root, className);
  return (
    <div className={cls}>
      <div role="tablist" className={styles.list}>
        {tabs.map((tab) => {
          const isActive = tab.id === active;
          // Toggle the active-state CSS class; `cx` drops falsy values.
          const tabCls = cx(styles.tab, isActive && styles.tabActive);
          return (
            // `key` gives React stable identity across re-renders so it
            // doesn't tear down/recreate each tab on every state change.
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={isActive}
              aria-controls={`tab-panel-${tab.id}`}
              disabled={tab.disabled}
              className={tabCls}
              onClick={() => {
                // Controlled/uncontrolled handoff: update local state
                // first so the UI reflects the click immediately, then
                // notify the parent (if any) so side effects see the
                // new value rather than the stale one.
                setActive(tab.id);
                onChange?.(tab.id);
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      {/* Single panel swapped by content — simpler than one-panel-per-tab
          and fine for this app because tab bodies are already lazy or
          cheap to re-render. Panel id matches each tab's aria-controls. */}
      <div role="tabpanel" id={`tab-panel-${current?.id ?? ""}`} className={styles.panel}>
        {current?.content}
      </div>
    </div>
  );
}
