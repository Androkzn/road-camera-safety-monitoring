import { useState, type ReactNode } from "react";
import styles from "./TabBar.module.css";

interface Tab {
  id: string;
  label: ReactNode;
  content: ReactNode;
}

interface TabBarProps {
  tabs: Tab[];
  defaultTab?: string;
}

export function TabBar({ tabs, defaultTab }: TabBarProps) {
  const [active, setActive] = useState(defaultTab ?? tabs[0]?.id ?? "");

  return (
    <div className={styles.container}>
      <div className={styles.bar}>
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
