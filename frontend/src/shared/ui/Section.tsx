/**
 * Section — a labelled grouping inside a page or card. The header
 * uses small uppercase muted text — used for "Evidence", "What To Check",
 * "Operational" sub-blocks etc.
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Used inside Cards on
 *   MonitoringPage incident detail, SettingsPage groups, AdminPage and
 *   DashboardPage panels.
 * UI element: a sub-block inside a card with a small uppercase muted
 *   title row (and optional action slot) followed by its content.
 */
import type { HTMLAttributes, ReactNode } from "react";

import { cx } from "../lib/cx";
import styles from "./Section.module.css";

interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
}

export function Section({ title, actions, className, children, ...rest }: SectionProps) {
  const cls = cx(styles.section, className);
  return (
    <section className={cls} {...rest}>
      {(title || actions) && (
        <header className={styles.header}>
          {typeof title === "string" ? <h4 className={styles.title}>{title}</h4> : title}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
