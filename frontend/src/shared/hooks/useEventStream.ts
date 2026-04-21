/**
 * useEventStream — thin wrapper around the app-wide `EventStreamProvider`.
 *
 * Backed by the SSE endpoint `/api/events/stream` (the single EventSource
 * lives in EventStreamProvider, not here). This module re-exports
 * context-reader hooks for backwards compatibility with existing consumers.
 *
 * The underlying SSE connection lives in the provider (see
 * `shared/events/EventStreamProvider.tsx`). This hook exists for
 * source-compat with existing consumers (AdminPage, DashboardPage,
 * MonitoringPage, ValidationPage). New code may prefer
 * `useEventStreamCtx()` directly to make the dependency on the provider
 * explicit.
 *
 * Prior D6 regression: each consumer opened its own `EventSource`, so
 * two visible pages = two connections + two drifting event buffers.
 * This hook now always reads the one shared buffer.
 * For status-only consumers, use `useEventStreamConnection()`.
 *
 * --- UI mapping ---
 * Used on: DashboardPage, MonitoringPage, AdminPage, ValidationPage —
 *   any page that consumes live safety events.
 * UI element: the live-event ticker that powers incident feeds,
 *   detection panels, and live tiles — this hook is the React-side
 *   subscription, not a visible element on its own.
 */

// useEventStream — returns the full event-stream context from the provider:
//   { events: SafetyEvent[]; connected: boolean; ... } (see EventStreamProvider).
// Subscribes the caller to the shared event buffer and re-renders on new events.
// Side effect: registers the component as a context consumer (no network I/O here;
// the provider owns the single EventSource).
export { useEventStreamCtx as useEventStream } from "../events/EventStreamProvider";
// useEventStreamConnection — returns only the { connected: boolean } slice.
// Prefer this for status pills / indicators so the component doesn't re-render
// on every new event — only on connection-state flips.
export { useEventStreamConnection } from "../events/EventStreamProvider";
