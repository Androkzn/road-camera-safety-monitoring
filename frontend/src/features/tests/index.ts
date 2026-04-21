/**
 * tests feature — public surface (barrel file).
 *
 * Wraps the pytest runner status endpoint. The TopBar shows a small
 * badge summarising the latest run and opens a drawer with per-file
 * results. Everything outside this feature imports only through here.
 */

export { useTests } from "./hooks/useTests";
export { TestBadge } from "./components/TestBadge";
export { TestDrawer } from "./components/TestDrawer";
export { testsApi, testsQueryKeys } from "./api";
