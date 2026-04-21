/**
 * useEventStream — thin wrapper around the app-wide `EventStreamProvider`.
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

export { useEventStreamCtx as useEventStream } from "../events/EventStreamProvider";
export { useEventStreamConnection } from "../events/EventStreamProvider";
