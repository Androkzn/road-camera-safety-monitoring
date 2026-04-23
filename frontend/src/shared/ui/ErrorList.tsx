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
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Most heavily used by
 *   SettingsPage for validation errors and by ValidationPage / AdminPage
 *   for API error surfaces.
 * UI element: red (or amber, for warnings) bordered alert box with an
 *   optional title and a bulleted list of error rows; renders nothing
 *   when the errors array is empty.
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

// Accepts either a bare string or a structured ErrorListItem so callers can
// mix plain messages and keyed validation errors in the same array.
function normalize(entry: ErrorEntry): ErrorListItem {
  return typeof entry === "string" ? { reason: entry } : entry;
}

// `role="alert"` is an assertive live region — announced immediately by
// screen readers. Returning null on empty input lets callers render this
// unconditionally without wrapping each call site in a ternary.
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
          // Prefer the stable `key` (e.g. "ROAD_FPS") when present; fall
          // back to index+reason so duplicate unkeyed rows still get
          // distinct React keys.
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
