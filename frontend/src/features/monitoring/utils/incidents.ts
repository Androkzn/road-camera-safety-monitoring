/**
 * Pure helpers that turn raw `WatchdogFinding[]` into `WatchdogIncident[]`
 * (deduped, fingerprinted, sorted by severity → priority → recency).
 *
 * This is the HOT part of the "incident queue, not log tail" design:
 * one fingerprint → one card. A flapping error emits 50 lines but
 * surfaces as a single card with a `count: 50` pill.
 *
 * No React, no I/O — easy to unit-test.
 *
 * --- UI mapping ---
 * Page: MonitoringPage ([file](frontend/src/features/monitoring/MonitoringPage.tsx))
 * UI element: No direct UI — supports each incident card in the feed and
 *   the "Seen Nx" repeat pill on it by collapsing raw findings into one
 *   sorted incident per fingerprint.
 */
import type { WatchdogFinding } from "../../../shared/types/common";

import type { WatchdogIncident } from "../types";

/** Sort weight: lower number = more severe = shown higher in the list. */
const SEV_ORDER: Record<string, number> = { error: 0, warning: 1, info: 2 };

/** Stable per-row identity so the UI can later ask the server to delete it. */
export function findingKey(f: WatchdogFinding): string {
  return `${f.snapshot_id}_${f.ts}`;
}

/**
 * Grouping key. Prefer the backend-supplied `fingerprint` (stable across
 * flaps); fall back to "category:title" when the server hasn't computed one.
 */
export function incidentId(f: WatchdogFinding): string {
  return f.fingerprint || `${f.category}:${f.title}`;
}

/**
 * Collapse raw findings into sorted incidents.
 *
 * How it works:
 *  1. Walk findings; group them by `incidentId()` via a Map.
 *  2. On every hit for an existing group: bump count, push the rawKey,
 *     upgrade severity if stronger, widen first/last-seen window, and
 *     keep the most-recent finding as `latest` for display.
 *  3. Sort by severity → priority_score → count → recency.
 */
export function buildIncidents(items: WatchdogFinding[]): WatchdogIncident[] {
  // Map<K, V> keeps insertion order (we re-sort later anyway). Keyed by
  // incidentId so duplicate fingerprints fold into one entry.
  const groups = new Map<string, WatchdogIncident>();

  for (const finding of items) {
    const id = incidentId(finding);
    const key = findingKey(finding);
    const existing = groups.get(id);

    if (!existing) {
      groups.set(id, {
        id,
        fingerprint: finding.fingerprint || id,
        severity: finding.severity,
        category: finding.category || "system",
        title: finding.title,
        owner: finding.owner,
        count: 1,
        firstSeen: finding.ts,
        lastSeen: finding.ts,
        rawKeys: [key],
        latest: finding,
      });
      continue;
    }

    existing.count += 1;
    existing.rawKeys.push(key);

    // Severity upgrade only: if THIS finding is more severe than what we
    // had, promote the group. We never downgrade — if it's ever been an
    // error we keep treating it as one.
    if ((SEV_ORDER[finding.severity] ?? 9) < (SEV_ORDER[existing.severity] ?? 9)) {
      existing.severity = finding.severity;
    }
    if (new Date(finding.ts).getTime() < new Date(existing.firstSeen).getTime()) {
      existing.firstSeen = finding.ts;
    }
    if (new Date(finding.ts).getTime() >= new Date(existing.lastSeen).getTime()) {
      existing.lastSeen = finding.ts;
      existing.latest = finding;
      existing.category = finding.category || existing.category;
      existing.title = finding.title || existing.title;
      existing.owner = finding.owner || existing.owner;
    }
  }

  // Final ordering: severity first, then priority_score desc, then
  // count desc (more-flappy floats higher), then most-recent first.
  return Array.from(groups.values()).sort((a, b) => {
    const sev = (SEV_ORDER[a.severity] ?? 9) - (SEV_ORDER[b.severity] ?? 9);
    if (sev !== 0) return sev;
    const pri = (b.latest.priority_score ?? 0) - (a.latest.priority_score ?? 0);
    if (pri !== 0) return pri;
    if (b.count !== a.count) return b.count - a.count;
    return b.lastSeen.localeCompare(a.lastSeen);
  });
}
