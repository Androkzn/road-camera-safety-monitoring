/**
 * Input — themed text-style <input>. Forwards every native attribute,
 * adds `invalid` and size variants, and works for `type="text" | "password" |
 * "number" | "email" | …`. For sliders / checkboxes use raw <input> with
 * its own styles since the visual model is different.
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). Most heavily used by
 *   SettingsPage forms; also used in AdminPage source editors and any
 *   in-page search/filter input.
 * UI element: themed text input field with three size variants and an
 *   "invalid" red-outline state for validation errors.
 */
import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "../lib/cx";
import styles from "./Input.module.css";

// Three density variants. `md` is the default used by most forms;
// `sm` tightens up in-table inputs, `lg` is reserved for prominent
// single-field forms (e.g. settings wizard step).
export type InputSize = "sm" | "md" | "lg";

// Extends the native attribute set but drops `size` (a native
// <input> numeric attr) so our own `inputSize` name doesn't clash.
// `invalid` toggles the red-outline CSS state AND the aria-invalid attr.
export interface InputProps extends Omit<InputHTMLAttributes<HTMLInputElement>, "size"> {
  invalid?: boolean;
  inputSize?: InputSize;
}

// Lookup table from our `InputSize` enum to CSS module class names.
// The `?? ""` guards noUncheckedIndexedAccess — if a size class is
// missing from the CSS module we degrade silently rather than emit
// "undefined" as a className.
const sizeClass: Record<InputSize, string> = {
  sm: styles.sizeSm ?? "",
  md: styles.sizeMd ?? "",
  lg: styles.sizeLg ?? "",
};

/**
 * Themed text input. forwardRef'd so form libraries and focus helpers
 * can grab the underlying <input>. Every native attribute
 * (placeholder, type, value, onChange, disabled, …) is forwarded via
 * {...rest}. Props:
 *   - invalid?: red outline + aria-invalid=true
 *   - inputSize?: "sm" | "md" | "lg", default "md"
 *   - className?: merged after the built-in classes so callers can override
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, inputSize = "md", className, ...rest },
  ref,
) {
  // cx() filters out falsy entries, so `invalid && styles.invalid`
  // contributes the error class only when invalid is truthy.
  const cls = cx(styles.input, sizeClass[inputSize], invalid && styles.invalid, className);
  // aria-invalid is set to true when invalid, otherwise undefined so
  // React omits the attribute entirely (cleaner than aria-invalid="false").
  return <input ref={ref} className={cls} aria-invalid={invalid || undefined} {...rest} />;
});
