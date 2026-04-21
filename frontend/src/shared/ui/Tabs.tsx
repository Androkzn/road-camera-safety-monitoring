/**
 * Tabs — minimal accessible tab strip. Pass `tabs` (id + label + content)
 * and an optional `defaultTab` id; Tabs handles the active state.
 *
 * The label can be any ReactNode (string, fragment with a count badge,
 * etc.) so callers don't lose composability.
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

export interface TabSpec {
  id: string;
  label: ReactNode;
  content: ReactNode;
  disabled?: boolean;
}

interface TabsProps {
  tabs: TabSpec[];
  defaultTab?: string;
  onChange?: (id: string) => void;
  className?: string;
}

/**
 * Tabs — controlled-by-default tab strip. `useState` holds the active id
 * internally; pass `onChange` to also bubble changes up to the parent.
 */
export function Tabs({ tabs, defaultTab, onChange, className }: TabsProps) {
  // Active tab id — initial value falls back through `defaultTab` → first
  // tab → empty string so the component is robust to a zero-tab spec.
  const [active, setActive] = useState<string>(defaultTab ?? tabs[0]?.id ?? "");
  const current = tabs.find((t) => t.id === active) ?? tabs[0];
  const cls = cx(styles.root, className);
  return (
    <div className={cls}>
      <div role="tablist" className={styles.list}>
        {tabs.map((tab) => {
          const isActive = tab.id === active;
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
                setActive(tab.id);
                onChange?.(tab.id);
              }}
            >
              {tab.label}
            </button>
          );
        })}
      </div>
      <div role="tabpanel" id={`tab-panel-${current?.id ?? ""}`} className={styles.panel}>
        {current?.content}
      </div>
    </div>
  );
}
