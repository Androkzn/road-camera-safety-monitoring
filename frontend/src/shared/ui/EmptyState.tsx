/**
 * EmptyState — a labelled "nothing here yet" placeholder with optional
 * actions. Use whenever a list / panel renders zero items.
 *
 * Usage:
 *   <EmptyState
 *     title="No incidents"
 *     message="The watchdog hasn't found anything."
 *     actions={<Button onClick={refresh}>Refresh</Button>}
 *   />
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Shown by MonitoringPage when
 *   the incident queue is empty, by DashboardPage / AdminPage when the
 *   event feed has no entries, and by SettingsPage / ValidationPage list
 *   panels.
 * UI element: centred placeholder with optional icon, title, message and
 *   action buttons — used wherever a list or panel renders zero items.
 */
import type { ReactNode } from "react";

import { cx } from "../lib/cx";
import styles from "./EmptyState.module.css";

interface EmptyStateProps {
  title?: ReactNode;
  message?: ReactNode;
  icon?: ReactNode;
  actions?: ReactNode;
  className?: string;
}

export function EmptyState({ title, message, icon, actions, className }: EmptyStateProps) {
  const cls = cx(styles.root, className);
  return (
    <div className={cls} role="status">
      {icon}
      {title && <h3 className={styles.title}>{title}</h3>}
      {message && <p className={styles.message}>{message}</p>}
      {actions && <div className={styles.actions}>{actions}</div>}
    </div>
  );
}
