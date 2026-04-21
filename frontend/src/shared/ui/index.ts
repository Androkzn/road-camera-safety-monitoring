/**
 * shared/ui — barrel for all shared UI primitives.
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

export { Button } from "./Button";
export type { ButtonProps, ButtonVariant, ButtonSize } from "./Button";

export { Input } from "./Input";
export type { InputProps, InputSize } from "./Input";

export { Card } from "./Card";

export { Section } from "./Section";

export { Tabs } from "./Tabs";
export type { TabSpec } from "./Tabs";

export { Skeleton } from "./Skeleton";

export { EmptyState } from "./EmptyState";

export { ErrorList } from "./ErrorList";
export type { ErrorListItem } from "./ErrorList";

export { Spinner } from "./Spinner";

export { ErrorBoundary } from "./ErrorBoundary";

export { DialogProvider, useDialog, dialog } from "./Dialog";
export type { DialogApi, AlertOptions, ConfirmOptions, DialogVariant } from "./Dialog";

export { Pill } from "./Pill";
export { Dot } from "./Dot";
export { Tag } from "./Tag";
export { RiskBadge } from "./RiskBadge";

export { EventFilterBar } from "./EventFilterBar";
