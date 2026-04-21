/**
 * shared/events — cross-feature event UI primitives.
 *
 * Exposes `EventCard`, `EventDialog`, `FeedbackButtons`, and the
 * `EventStreamProvider` family of hooks. Both Dashboard (public
 * timeline) and Admin (history list) consume `EventCard`, and
 * `FeedbackButtons` is embedded inside it. SSE ownership lives here so
 * there's only one `EventSource` per app.
 *
 * --- UI mapping ---
 * Page: ALL pages (EventStreamProvider is mounted in app/providers.tsx).
 * UI element: indirect; feature pages import EventCard / EventDialog /
 *              FeedbackButtons from this barrel to render event rows.
 *
 * --- Backend endpoints touched by this module ---
 *  - SSE  `/api/events/stream` (+ internal `/stream/events`) — live feed.
 *  - GET  `/api/events/history`                               — backfill.
 *  - GET  `/api/events/{id}/clip`                             — EventDialog.
 *  - POST `/api/events/{id}/feedback` (via `/api/feedback`)   — FeedbackButtons.
 *
 * Privacy: every thumbnail shown here is the redacted `_public` variant;
 * raw plate text is stripped at ingest in enrich_event() and never
 * appears on the wire.
 */

// Event row card — used by DashboardPage and MonitoringPage.
export { EventCard } from "./EventCard";
// Full-screen details modal with ±3s clip — used by all event surfaces.
export { EventDialog } from "./EventDialog";
// Thumbs-up/down verdict submitter embedded inside EventCard.
export { FeedbackButtons } from "./FeedbackButtons";
// App-wide single SSE connection provider + split consumer hooks.
// `useEventStreamCtx` is the back-compat aggregate; prefer the split
// hooks (`useEventStreamData`, `useEventStreamConnection`,
// `useEventStreamActions`) in new code so consumers re-render only on
// the slice they actually read.
export {
  EventStreamProvider,
  useEventStreamCtx,
  useEventStreamConnection,
  useEventStreamData,
  useEventStreamActions,
} from "./EventStreamProvider";
export type { EventStreamCtx } from "./EventStreamProvider";
