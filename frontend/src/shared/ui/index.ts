/**
 * shared/ui — barrel for all shared UI primitives.
 *
 * Purpose: single entry point so feature folders can pull primitives with
 *   one import path, keeping the "features never reach into each other"
 *   rule clean (see .claude/rules/frontend.md).
 * Role: re-exports only; this file never contains component code.
 *
 * Exposes Button, Card, Dialog, Input, Pill, Dot, Tag, RiskBadge, Tabs,
 * Section, Skeleton, Spinner, EmptyState, ErrorBoundary, ErrorList, and
 * EventFilterBar. Consumed by every page. Adding a new primitive? Re-
 * export it here so consumers can write one import:
 *   `import { Button, Card, EmptyState } from "../../shared/ui";`
 *
 * --- UI mapping ---
 * Page: ALL pages.
 * UI element: indirect; every feature page composes its layout from
 *              the primitives re-exported by this barrel.
 */

// Primary action element + its public types (variant/size are part of the
// contract that feature code relies on when building toolbars).
export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

// Text / form input primitive with size variants.
export { Input } from "./Input";
export type { InputProps, InputSize } from "./Input";

// Card — bordered panel container used for dashboard tiles and list rows.
export { Card } from "./Card";

// Section — titled grouping wrapper inside a page or card.
export { Section } from "./Section";

// Tabs — in-page tab strip. TabSpec is re-exported so consumers can type
// their tab arrays without reaching into the component path directly.
export { Tabs } from "./Tabs";
export type { TabSpec } from "./Tabs";

// Skeleton — shimmering placeholder used during async loads.
export { Skeleton } from "./Skeleton";

// EmptyState — "no data yet" illustration + copy + optional CTA.
export { EmptyState } from "./EmptyState";

// ErrorList — renders a bulleted list of validation/runtime errors.
export { ErrorList } from "./ErrorList";
export type { ErrorListItem } from "./ErrorList";

// Spinner — small CSS-only loading indicator.
export { Spinner } from "./Spinner";

// ErrorBoundary — React error boundary used by <RouteShell> so a thrown
// error in one route does not crash the whole app.
export { ErrorBoundary } from "./ErrorBoundary";

// Dialog — imperative alert/confirm API. `DialogProvider` is mounted once
// in app/providers.tsx; `useDialog` / `dialog` let any component open one
// without passing state around.
export { DialogProvider, useDialog, dialog } from "./Dialog";
export type { DialogApi, AlertOptions, ConfirmOptions, DialogVariant } from "./Dialog";

// Small inline markers used in event rows and status strips.
//   Pill     — rounded status chip with a coloured background.
//   Dot      — 8 px status dot (good/warn/bad).
//   Tag      — rectangular mono-font label for hashes, track ids, kin, etc.
//   RiskBadge — severity indicator driven by the backend risk tier.
export { Pill } from "./Pill";
export { Dot } from "./Dot";
export { Tag } from "./Tag";
export { RiskBadge } from "./RiskBadge";

// EventFilterBar — shared filter controls used by Admin and Dashboard
// event lists. Lives in shared/ui because both features rely on it.
export { EventFilterBar } from "./EventFilterBar";
