/**
 * admin — public surface of the admin feature.
 *
 * Re-exports AdminPage (and any admin types/hooks intended for external
 * use). Other features or the app shell that need admin types or hooks
 * import from here rather than reaching into internal files.
 *
 * --- UI mapping ---
 * Page: AdminPage ([file](frontend/src/features/admin/AdminPage.tsx))
 * UI element: indirect; the app router lazy-loads AdminPage via this
 *              barrel to mount the `/admin` route.
 */
export { AdminPage } from "./AdminPage";
