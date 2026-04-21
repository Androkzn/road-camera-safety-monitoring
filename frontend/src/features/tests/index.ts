/**
 * tests — public surface of the runtime test-harness feature.
 *
 * Wraps the pytest runner status endpoint: `TestBadge` lives in the
 * TopBar showing the latest run summary, and clicking it opens
 * `TestDrawer` with per-file results. Everything outside this feature
 * imports only through here.
 *
 * --- UI mapping ---
 * Page: ALL pages (TopBar is mounted in the app shell).
 * UI element: TestBadge in TopBar; TestDrawer opens on click.
 */

export { useTests } from "./hooks/useTests";
export { TestBadge } from "./components/TestBadge";
export { TestDrawer } from "./components/TestDrawer";
export { testsApi, testsQueryKeys } from "./api";
