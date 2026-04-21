/**
 * settings — public surface of the settings feature.
 *
 * Only SettingsPage is exposed; the Tunable primitives, column layout,
 * and step-computation util stay feature-private. App shell imports from
 * here to mount the `/settings` route.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: indirect; the app router lazy-loads SettingsPage via
 *              this barrel to mount the settings route.
 */
export { SettingsPage } from "./SettingsPage";
