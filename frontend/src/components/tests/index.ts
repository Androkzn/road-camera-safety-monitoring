/**
 * tests/index.ts — barrel export for test-suite UI components.
 *
 * Re-exports `TestBadge` (compact chip in the top bar) and `TestDrawer`
 * (slide-out panel with full results) so importing sites can grab both in
 * one line. Purely organizational.
 */
export { TestBadge } from "./TestBadge";
export { TestDrawer } from "./TestDrawer";
