/**
 * TabBar.tsx — simple tabbed container with one active panel at a time.
 *
 * What it does:
 *   Shows a row of tab buttons at the top; clicking a tab reveals its panel
 *   below and hides the others. All panels are mounted simultaneously (just
 *   hidden with CSS) so they keep their internal state when switched away.
 *
 * Purpose:
 *   Organizes the Admin page sidebar into three views — Detections, Events,
 *   and History — without dropping state when the operator jumps between
 *   them.
 *
 * How it works:
 *   - Props: `tabs` is an array of `{ id, label, content }` objects (label
 *     and content are `ReactNode`, meaning any renderable JSX — text,
 *     elements, fragments). `defaultTab` optionally picks which tab starts
 *     active.
 *   - `useState(defaultTab ?? tabs[0]?.id ?? "")` stores the id of the
 *     currently-active tab. When `setActive(tab.id)` fires on click, React
 *     re-renders and the matching panel gets the `activePanel` class.
 *   - All panels are rendered; visibility is a CSS class toggle, not a
 *     mount/unmount — so a form typed into tab A is still there when you
 *     come back.
 *
 * Connects to:
 *   - Backend: none — structural only.
 *   - UI: used by `pages/AdminPage.tsx` to host the Detections / Events /
 *     History sidebar.
 */
import { useState, type ReactNode } from "react";
import styles from "./TabBar.module.css";

// Shape of one tab: a unique id, a label (anything renderable, e.g. text or an icon),
// and the content node shown when the tab is active.
interface Tab {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

// Props: array of tabs plus optional id of the one that starts active.
interface TabBarProps {
  tabs: Tab[];
  defaultTab?: string;
}

// Renders a row of tab buttons with one active panel shown below them.
// On AdminPage this hosts the Detections / Events / History sidebar.
export function TabBar({ tabs, defaultTab }: TabBarProps) {
  // `active` holds the id of the currently-selected tab.
  // `??` = nullish coalescing: use the next value when the previous is null/undefined.
  // So active = defaultTab, or the first tab's id, or "" as a last fallback.
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");

  return (
    // Outer container wrapping both the tab bar and the panels
    <div className={styles.container}>
      {/* Top row of clickable tab buttons */}
      <div className={styles.bar}>
        {/* Loops tabs into buttons; the active one gets the extra `.active` class */}
        {tabs.map((tab) => (
          <button
            key={tab.id}
            className={`${styles.tab} ${active === tab.id ? styles.active : ""}`}
            onClick={() => setActive(tab.id)}
            type="button"
          >
            {tab.label}
          </button>
        ))}
      </div>
      {/* All panels are rendered at once — only the active one is visible via CSS.
          This preserves internal state (scroll position, form values) when switching tabs. */}
      {tabs.map((tab) => (
        <div
          key={tab.id}
          className={`${styles.panel} ${active === tab.id ? styles.activePanel : ""}`}
        >
          {tab.content}
        </div>
      ))}
    </div>
  );
}
