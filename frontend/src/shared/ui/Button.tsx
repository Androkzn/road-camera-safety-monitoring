/**
 * Button — the one button primitive used everywhere.
 *
 * Variants: default | primary | danger | warning | ghost | subtle.
 * Sizes:    sm | md | lg.
 * Special:  iconOnly for square icon buttons.
 *
 * Forwards every other native <button> attribute (type, onClick,
 * disabled, aria-*, …) so callers don't lose any HTML semantics.
 *
 * --- UI mapping ---
 * Used on: All pages (shared UI primitive). The single button element
 *   used everywhere — toolbar actions, dialog confirms, card headers,
 *   form submits across every page.
 * UI element: themed button (default / primary / danger / warning / ghost
 *   / subtle), three sizes, optional left/right icon slots, and an
 *   icon-only square variant.
 */
import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from "react";

import { cx } from "../lib/cx";
import styles from "./Button.module.css";

export type ButtonVariant = "default" | "primary" | "danger" | "warning" | "ghost" | "subtle";

export type ButtonSize = "sm" | "md" | "lg";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  iconOnly?: boolean;
  leftIcon?: ReactNode;
  rightIcon?: ReactNode;
}

// Lookup tables keyed by variant/size. `?? ""` guards against CSS-module
// hashing failures so a missing class never injects `undefined` into
// className (which would break the output string).
const variantClass: Record<ButtonVariant, string> = {
  default: "",
  primary: styles.primary ?? "",
  danger: styles.danger ?? "",
  warning: styles.warning ?? "",
  ghost: styles.ghost ?? "",
  subtle: styles.subtle ?? "",
};

const sizeClass: Record<ButtonSize, string> = {
  sm: styles.sizeSm ?? "",
  md: styles.sizeMd ?? "",
  lg: styles.sizeLg ?? "",
};

// `forwardRef` lets parent code attach a ref to the underlying <button>
// (useful for focus management / measuring). The generic `<HTMLButtonElement,
// ButtonProps>` types the ref target and props.
export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  {
    variant = "default",
    size = "md",
    iconOnly,
    leftIcon,
    rightIcon,
    className,
    children,
    // Default to type="button" — HTML's default "submit" inside a <form>
    // is a classic source of accidental submissions.
    type = "button",
    // Rest-spread: everything else native (onClick, disabled, aria-*) flows
    // through to the DOM node.
    ...rest
  },
  ref,
) {
  const cls = cx(
    styles.btn,
    variantClass[variant],
    sizeClass[size],
    iconOnly && styles.iconOnly,
    className,
  );
  return (
    <button ref={ref} type={type === "submit" ? "submit" : "button"} className={cls} {...rest}>
      {leftIcon}
      {children}
      {rightIcon}
    </button>
  );
});
