/**
 * cx — tiny className joiner (a stripped-down `classnames`/`clsx`).
 *
 * Accepts any mix of strings and falsy values (`false | null | undefined`)
 * and joins the truthy strings with spaces. Lets JSX stay readable when
 * class names are conditional:
 *
 *   <div className={cx(styles.card, active && styles.active, extra)} />
 *
 * The `Array<string | false | null | undefined>` union lets callers pass
 * short-circuited expressions like `isOpen && "open"` without a cast.
 */
/** Drop-in for the repeated `[foo, bar && "active"].filter(Boolean).join(" ")` pattern found at 41+ sites. */
export function cx(...args: Array<string | false | null | undefined>): string {
  return args.filter(Boolean).join(" ");
}
