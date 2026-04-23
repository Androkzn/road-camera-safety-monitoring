/**
 * App — root React component. Just delegates to the lazy router.
 * The route table lives in `app/router.tsx`.
 *
 * --- UI mapping ---
 * Scope: app-wide (affects every page)
 * UI element: the top-level app component — renders the router
 */
import { AppRouter } from "./app/router";

export function App() {
  return <AppRouter />;
}
