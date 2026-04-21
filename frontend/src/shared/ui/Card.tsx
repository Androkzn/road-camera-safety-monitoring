/**
 * Card — generic surface container. Composable header via `<Card.Header>`.
 *
 * Usage:
 *   <Card>
 *     <Card.Header title="Templates" actions={<Button size="sm">+</Button>} />
 *     ...body...
 *   </Card>
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). The standard surface used by
 *   AdminPage, DashboardPage, MonitoringPage, SettingsPage and
 *   ValidationPage to group related content.
 * UI element: rounded panel/card container with optional title bar and
 *   action slot on the right; comes in three padding sizes plus an
 *   optional elevated (shadowed) variant.
 */
import type { CSSProperties, HTMLAttributes, ReactNode } from "react";

import { cx } from "../lib/cx";
import styles from "./Card.module.css";

export type CardPad = "sm" | "md" | "lg";

interface CardProps extends HTMLAttributes<HTMLDivElement> {
  pad?: CardPad;
  elevated?: boolean;
}

interface HeaderProps {
  title?: ReactNode;
  actions?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

const padClass: Record<CardPad, string> = {
  sm: styles.padSm ?? "",
  md: styles.padMd ?? "",
  lg: styles.padLg ?? "",
};

/** Card — surface container. Pass `pad` / `elevated` for shadowed variants. */
export function Card({ pad = "md", elevated, className, children, ...rest }: CardProps) {
  const cls = cx(styles.card, padClass[pad], elevated && styles.elevated, className);
  return (
    <div className={cls} {...rest}>
      {children}
    </div>
  );
}

/** Header for a Card — accessed as `<Card.Header />` via the assignment below. */
function CardHeader({ title, actions, className, style }: HeaderProps) {
  const cls = cx(styles.header, className);
  return (
    <div className={cls} style={style}>
      {typeof title === "string" ? <h3 className={styles.title}>{title}</h3> : title}
      {actions}
    </div>
  );
}

// Attach as a static property so callers write `<Card.Header>` — a common
// "compound component" pattern for grouping related primitives.
Card.Header = CardHeader;
