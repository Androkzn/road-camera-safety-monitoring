/**
 * format.ts — pure display-formatting helpers.
 *
 * Every function here is **pure**: same input → same output, no I/O, no
 * state, no side effects. They exist to keep components focused on layout
 * and not on string-massaging. If you find yourself writing the same
 * `new Date(ts).toLocaleTimeString(...)` snippet in two components, add
 * a helper here and import it instead.
 *
 * Exports:
 *   - `formatWallTime(ts?)`   → "HH:MM:SS" or "—" if the timestamp is bad.
 *   - `humanEventType(t?)`    → "lane_change" → "Lane change".
 *   - `formatUptime(secs?)`   → "2h 07m" or "04:22".
 *   - `formatConfidence(c?)`  → 0.873 → "87%".
 *   - `normalizeThumbnail(s)` → ensures a thumbnail URL has a leading "/"
 *                               (so relative paths resolve against the
 *                               current origin instead of the current
 *                               page path).
 *
 * Consumers: grep `from "../lib/format"` or `from "./lib/format"` across
 * the frontend.
 *
 * TEACH: This file has no React imports — it's plain TypeScript. That's
 * typical for `lib/` folders: reusable logic with no UI coupling.
 */

// --- Internal helper ---

// TEACH: `const pad2 = (n: number): string => ...` is an **arrow function**
// assigned to a const. Equivalent to `function pad2(n: number): string { return ... }`
// with two differences: arrow functions don't have their own `this`, and the
// implicit-return form (no braces) lets you skip `return`. The `: string`
// before `=>` is the return type annotation — TS will error if the body
// returns something else.
// `String(n)` coerces the number to a string. `.padStart(2, "0")` is a
// built-in that left-pads so "7" → "07" (length 2).
const pad2 = (n: number): string => String(n).padStart(2, "0");

// --- Exported helpers ---

// TEACH: `ts?: string | number` — the `?` makes the parameter optional;
// the caller may omit it entirely. The **union type** `string | number`
// accepts ISO date strings ("2026-04-18T12:34:56Z") or epoch numbers.
// `: string` promises the function always returns a string (never
// undefined), which makes JSX templating safe.
export function formatWallTime(ts?: string | number): string {
  // TEACH: If `ts` was omitted (undefined), use `new Date()` for "now".
  // Otherwise construct a Date from whatever the caller passed.
  const d = ts ? new Date(ts) : new Date();
  // TEACH: `Date#getTime()` returns NaN when the input couldn't be parsed
  // (e.g. a malformed string). `isNaN` is the JS standard check for that.
  // Returning "—" (em-dash) is our UI convention for "no value".
  if (isNaN(d.getTime())) return "—";
  // TEACH: **Template literal** — backticks let you embed `${expr}` so
  // you can build strings without + concatenation. Each part is padded
  // to 2 digits via the helper above.
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

// TEACH: Converts backend enum-like strings into display strings:
// "lane_change" → "Lane change", "ttc_conflict" → "Ttc conflict".
// If `t` is missing/empty, we fall back to the generic word "event".
export function humanEventType(t?: string): string {
  return (t || "event")
    // TEACH: `.replace(/_/g, " ")` — the `/g` flag means "all matches"
    // (global), so every underscore becomes a space, not just the first.
    .replace(/_/g, " ")
    // TEACH: `.replace(/^\w/, (c) => c.toUpperCase())` — the regex `^\w`
    // matches the first word character. When the 2nd argument is a
    // function, it receives the match and returns the replacement. Net
    // effect: capitalize only the first letter.
    .replace(/^\w/, (c) => c.toUpperCase());
}

// TEACH: `secs?: number | null` — accepts undefined OR null OR number.
// The backend often sends `null` for missing values, and `undefined`
// shows up in partial state; handling both avoids a crash on page load.
export function formatUptime(secs?: number | null): string {
  // TEACH: `secs == null` (double-equals on purpose) is a short idiom
  // that is true for both `null` AND `undefined`, but nothing else.
  // Most of the codebase prefers `===`, but `== null` is the widely
  // accepted exception because it's so much shorter.
  if (secs == null || secs < 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  // TEACH: Inline ternary selects the more appropriate display: for
  // long uptimes we show hours+minutes, for short ones minutes:seconds.
  return h > 0 ? `${h}h ${pad2(m)}m` : `${pad2(m)}:${pad2(s)}`;
}

// TEACH: Confidence arrives as a 0..1 float from the perception stack.
// We render it as a percent integer. Missing → em-dash (UI convention).
export function formatConfidence(c?: number | null): string {
  return c != null ? `${Math.round(c * 100)}%` : "—";
}

// TEACH: Defensive URL normalization. Backend sometimes sends a thumbnail
// path like "thumbs/abc.jpg" (no leading slash). In a browser, a relative
// path resolves against the *current URL path*, not the origin — so on
// page `/monitoring` it would incorrectly request `/monitoring/thumbs/abc.jpg`.
// Prepending "/" makes it absolute against the origin.
// We skip rewriting if:
//   - the string is already absolute with `http:` / `https:`
//   - the string already starts with `/`
export function normalizeThumbnail(thumb?: string): string {
  if (!thumb) return "";
  // TEACH: `/^https?:/.test(thumb)` — a regex tests for "http" or "https"
  // at the start (`^`), with the `s` made optional (`s?`).
  if (/^https?:/.test(thumb) || thumb.startsWith("/")) return thumb;
  return "/" + thumb;
}
