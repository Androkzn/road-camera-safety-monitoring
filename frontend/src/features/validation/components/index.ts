/**
 * validation/components — barrel for shadow-validator UI subcomponents.
 *
 * Exposes EventRow, EventsPanel, and ValidatorControl so ValidationPage
 * can import them from one location (`./components`) instead of
 * reaching into individual files.
 *
 * --- UI mapping ---
 * Page: ValidationPage ([file](frontend/src/features/validation/ValidationPage.tsx))
 * UI element: indirect; ValidationPage imports the re-exported
 *              components from this barrel to compose the page.
 */
export { ValidatorControl } from "./ValidatorControl";
export { EventsPanel } from "./EventsPanel";
