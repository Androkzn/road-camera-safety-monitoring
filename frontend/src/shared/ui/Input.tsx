/**
 * Input — themed text-style <input>. Forwards every native attribute,
 * adds `invalid` and size variants, and works for `type="text" | "password" |
 * "number" | "email" | …`. For sliders / checkboxes use raw <input> with
 * its own styles since the visual model is different.
 */
import { forwardRef, type InputHTMLAttributes } from "react";

import { cx } from "../lib/cx";
import styles from "./Input.module.css";

export type InputSize = "sm" | "md" | "lg";

export interface InputProps extends Omit<
  InputHTMLAttributes<HTMLInputElement>,
  "size"
> {
  invalid?: boolean;
  inputSize?: InputSize;
}

const sizeClass: Record<InputSize, string> = {
  sm: styles.sizeSm ?? "",
  md: styles.sizeMd ?? "",
  lg: styles.sizeLg ?? "",
};

export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(
  { invalid, inputSize = "md", className, ...rest },
  ref,
) {
  const cls = cx(
    styles.input,
    sizeClass[inputSize],
    invalid && styles.invalid,
    className,
  );
  return (
    <input
      ref={ref}
      className={cls}
      aria-invalid={invalid || undefined}
      {...rest}
    />
  );
});
