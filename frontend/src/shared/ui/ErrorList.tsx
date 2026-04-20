/**
 * ErrorList — renders a collection of validation / API errors as a
 * titled list. Returns `null` when there is nothing to show so callers
 * can unconditionally render it.
 *
 * Usage:
 *   <ErrorList
 *     title="Validation"
 *     errors={[
 *       "could not reach the server",
 *       { key: "ROAD_FPS", reason: "must be a positive integer" },
 *     ]}
 *   />
 */
import { cx } from "../lib/cx";

import styles from "./ErrorList.module.css";

export interface ErrorListItem {
  key?: string;
  reason: string;
  message?: string;
}

type ErrorEntry = string | ErrorListItem;

interface ErrorListProps {
  errors: ReadonlyArray<ErrorEntry>;
  title?: string;
  variant?: "danger" | "warning";
  className?: string;
}

function normalize(entry: ErrorEntry): ErrorListItem {
  return typeof entry === "string" ? { reason: entry } : entry;
}

export function ErrorList({ errors, title, variant = "danger", className }: ErrorListProps) {
  if (errors.length === 0) return null;

  const variantClass = variant === "warning" ? styles.warning : styles.danger;
  const rootClass = cx(styles.root, variantClass, className);

  return (
    <div className={rootClass} role="alert">
      {title && <h4 className={styles.title}>{title}</h4>}
      <ul className={styles.list}>
        {errors.map((entry, idx) => {
          const item = normalize(entry);
          const rowKey = item.key ?? `${idx}-${item.reason}`;
          return (
            <li key={rowKey} className={styles.row}>
              {item.key && <code className={styles.key}>{item.key}</code>}
              <span className={styles.reason}>{item.reason}</span>
              {item.message && item.message !== item.reason && (
                <span className={styles.message}>— {item.message}</span>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}
