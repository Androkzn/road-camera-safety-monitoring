/**
 * events/index.ts — barrel export for event-related components.
 *
 * Re-exports `EventCard` (Dashboard large card), `AdminEventCard` (Admin
 * compact row), and `FeedbackButtons` (the Correct/False alarm control).
 * Purely organizational.
 */
// EventCard — full-size card used in the Dashboard live-event column.
export { EventCard } from "./EventCard";
// AdminEventCard — compact row used in the Admin Events tab + History panel.
export { AdminEventCard } from "./AdminEventCard";
// FeedbackButtons — "Correct" / "False alarm" row used inside each EventCard.
export { FeedbackButtons } from "./FeedbackButtons";
