/**
 * events/ — barrel file (a.k.a. re-export hub).
 *
 * TEACH: A "barrel" is a small index.ts whose only job is to re-export the
 *        public surface of a folder. Consumers then write:
 *            import { EventCard } from "../components/events";
 *        instead of the longer:
 *            import { EventCard } from "../components/events/EventCard";
 *        This keeps import paths stable even if we rename internal files later.
 *
 * What lives in this folder:
 *   - EventCard        — public-facing card for a single detection event.
 *   - AdminEventCard   — compact admin variant shown on the Admin page.
 *   - FeedbackButtons  — "Correct" / "False alarm" buttons (POSTs /api/feedback).
 *
 * Consumers: see AdminPage and DashboardPage under frontend/src/pages/.
 */

// TEACH: `export { X } from "./X"` forwards a named export without importing
// it into this module's scope — pure re-export, zero runtime cost beyond the
// module load the consumer would have done anyway.
export { EventCard } from "./EventCard";
export { AdminEventCard } from "./AdminEventCard";
export { FeedbackButtons } from "./FeedbackButtons";
