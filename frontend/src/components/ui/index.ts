/**
 * UI-primitives barrel file.
 *
 * A **barrel** is a module that re-exports symbols from sibling files so
 * consumers can write one short import:
 *
 *     import { Pill, Dot, Tag, RiskBadge } from "../components/ui";
 *
 * instead of four long paths:
 *
 *     import { Pill }      from "../components/ui/Pill";
 *     import { Dot }       from "../components/ui/Dot";
 *     import { Tag }       from "../components/ui/Tag";
 *     import { RiskBadge } from "../components/ui/RiskBadge";
 *
 * When you add a new UI primitive file in this folder, remember to add a
 * matching `export { X } from "./X";` line below or it won't be reachable
 * via the barrel.
 *
 * TEACH: `export { Foo } from "./Foo"` re-exports a *named* export. You
 * could also write `export * from "./Foo"` to re-export everything, but
 * the explicit form makes the public surface of this folder obvious at a
 * glance. Barrel files have no runtime effect beyond the re-export —
 * they're purely an ergonomics tool for import paths.
 */

export { Pill } from "./Pill";
export { Dot } from "./Dot";
export { Tag } from "./Tag";
export { RiskBadge } from "./RiskBadge";
