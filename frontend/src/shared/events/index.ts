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
 */

export { EventCard } from "./EventCard";
export { EventDialog } from "./EventDialog";
export { FeedbackButtons } from "./FeedbackButtons";
export {
  EventStreamProvider,
  useEventStreamCtx,
  useEventStreamConnection,
  useEventStreamData,
  useEventStreamActions,
} from "./EventStreamProvider";
export type { EventStreamCtx } from "./EventStreamProvider";
