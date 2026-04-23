/**
 * dashboard — public surface of the dashboard feature.
 *
 * Re-exports DashboardPage (and any dashboard types/hooks intended for
 * external use). The app router and any cross-feature consumers import
 * from here rather than reaching into internal files.
 *
 * --- UI mapping ---
 * Page: DashboardPage ([file](frontend/src/features/dashboard/DashboardPage.tsx))
 * UI element: indirect; the app router lazy-loads DashboardPage via
 *              this barrel to mount the dashboard route.
 */
export { DashboardPage } from "./DashboardPage";
