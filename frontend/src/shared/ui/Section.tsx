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

// `title` is typed ReactNode (not string) so callers can pass a
// composite header (e.g. title + badge). We still accept plain strings
// and auto-wrap them in a styled <h4>. Omit the native `title` attr
// from HTMLAttributes — our prop replaces its meaning.
// `actions` is an optional slot rendered on the right side of the
// header (e.g. a "Refresh" button, a collapse toggle).
interface SectionProps extends Omit<HTMLAttributes<HTMLElement>, "title"> {
  title?: ReactNode;
  actions?: ReactNode;
}

/**
 * Renders a <section> with an optional header row (title + actions)
 * followed by children. Header is only rendered when a title or
 * actions slot is supplied — keeps markup lean when Section is used
 * purely for semantic grouping.
 */
export function Section({ title, actions, className, children, ...rest }: SectionProps) {
  // Merge caller className after the base styles so page-specific
  // tweaks can override spacing/layout without !important.
  const cls = cx(styles.section, className);
  return (
    <section className={cls} {...rest}>
      {(title || actions) && (
        <header className={styles.header}>
          {/* String titles get the built-in small-uppercase-muted <h4>
              treatment. Passing a ReactNode lets callers supply richer
              content (icon + text, inline controls) while still getting
              the rest of the header layout. */}
          {typeof title === "string" ? <h4 className={styles.title}>{title}</h4> : title}
          {actions}
        </header>
      )}
      {children}
    </section>
  );
}
