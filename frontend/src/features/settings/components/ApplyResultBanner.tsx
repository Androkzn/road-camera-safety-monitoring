/**
 * ApplyResultBanner — apply success summary that hangs around until
 * the operator dismisses it.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: the green/red banner that appears at the top of the page
 *   after the operator presses Apply, summarising what changed.
 *
 * Backend: no direct calls here. The parent page POSTs to
 *   /api/settings/apply and feeds the response (diff, applied_now,
 *   pending_restart, audit_id) into this banner as `result`.
 */
import { humanize } from "../utils/formatting";
import type { DraftValue } from "../types";

import styles from "../SettingsPage.module.css";

export interface ApplyResultPayloadView {
  kind: "apply";
  diff: Record<string, { before: DraftValue; after: DraftValue }>;
  applied_now: string[];
  pending_restart: string[];
  audit_id?: string | null;
}

interface ApplyResultBannerProps {
  result: ApplyResultPayloadView | null;
  onDismiss: () => void;
}

/**
 * Render the "changes applied" banner.
 *
 * Parent: SettingsPage (owns apply-mutation state and passes the result).
 * Children: none — plain markup + a Dismiss button.
 * BE: indirect — renders the shape returned by POST /api/settings/apply.
 *
 * Renders nothing (null) when there's no result yet, so the parent can
 * mount this unconditionally.
 */
export function ApplyResultBanner({ result, onDismiss }: ApplyResultBannerProps) {
  if (!result) return null;
  // Pluralisation driver — also used to decide whether to render the
  // per-key before→after diff block at the bottom.
  const diffCount = Object.keys(result.diff).length;
  return (
    <div className={styles.successBanner} role="status">
      <div>
        <strong>
          {`Applied ${diffCount} change${diffCount === 1 ? "" : "s"}.`}
        </strong>
        {result.applied_now.length > 0 && (
          <>
            {" "}
            Live now:{" "}
            {result.applied_now.map((k, i) => (
              <span key={k}>
                {i > 0 ? ", " : ""}
                <code>{humanize(k)}</code>
              </span>
            ))}
            .
          </>
        )}
        {result.pending_restart.length > 0 && (
          <>
            {" "}
            <strong>Needs restart to take effect:</strong>{" "}
            {result.pending_restart.map((k, i) => (
              <span key={k}>
                {i > 0 ? ", " : ""}
                <code>{humanize(k)}</code>
              </span>
            ))}
            .
          </>
        )}
        {result.audit_id && (
          <>
            {" "}
            Impact session <code>{result.audit_id.slice(0, 18)}</code> started — watch the card on
            the right.
          </>
        )}
      </div>
      {/* Per-key before → after diff highlighting: each line shows the
          humanized key and the raw before/after values joined by an arrow.
          Rendered only when there is at least one change, in the subtle
          style so it reads as auxiliary detail under the main summary. */}
      {diffCount > 0 && (
        <div className={styles.subtle} style={{ fontSize: 11 }}>
          {Object.entries(result.diff).map(([k, ba]) => (
            <div key={k}>
              <code>{humanize(k)}</code>: {String(ba.before)} → {String(ba.after)}
            </div>
          ))}
        </div>
      )}
      <button type="button" className={styles.dismiss} onClick={onDismiss}>
        Dismiss
      </button>
    </div>
  );
}
