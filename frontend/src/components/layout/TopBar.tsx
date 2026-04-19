/**
 * TopBar — the persistent header strip at the top of every page.
 *
 * Rendered by: App.tsx, above `<Routes>` so it stays mounted as the user
 * navigates. This is the canonical "app-chrome" pattern in react-router.
 *
 * Props:
 *   - sourceName: display name of the current feed (e.g. "cam-01"). Optional.
 *   - connected:  tri-state SSE connection flag — true / false / undefined
 *                 (undefined = still connecting).
 *   - children:   optional extra slots a page can inject into the header,
 *                 e.g. AdminPage mounts the TestBadge here.
 *
 * React concepts first-taught in this file:
 *   - react-router `<Link>` and `useLocation` for SPA navigation without a
 *     full-page reload — only the matched <Route> re-renders.
 *   - Consuming React Context via a custom hook (`useWatchdogCtx`). Context
 *     lets deeply-nested components read shared state without prop drilling.
 *   - The `children` prop and `ReactNode` type — generic "any renderable".
 *   - Default parameter values on destructured props (`sourceName = "—"`).
 *   - Conditional rendering via the `&&` short-circuit (`cond && <jsx/>`).
 *   - Ternary expressions inside JSX for choosing a className.
 *   - Composing existing UI primitives (Pill, Dot) rather than reinventing.
 */

// --- Imports ---
// TEACH: `Link` renders an <a> but intercepts clicks, calling the router's
// history API instead of a real navigation. `useLocation` is a hook that
// returns the current URL info; we use `pathname` to highlight the active
// nav link.
import { Link, useLocation } from "react-router-dom";
// TEACH: Local UI primitives — barrel-imported from components/ui.
import { Pill, Dot } from "../ui";
// TEACH: `ReactNode` is the broadest renderable type: string, number, JSX,
// array, null, boolean. Perfect for `children`.
import type { ReactNode } from "react";
// TEACH: Custom hook that reads from a React Context (WatchdogContext).
// Under the hood it calls `useContext(WatchdogContext)`. Wrapping useContext
// in a custom hook is an idiomatic way to add a "must be used inside
// provider" runtime check and a cleaner import.
import { useWatchdogCtx } from "../../hooks/WatchdogContext";
import styles from "./TopBar.module.css";

// --- Types ---
interface TopBarProps {
  // Kept for backwards compat with callers but no longer rendered in the
  // header pill — with multi-source perception there's no single "source"
  // worth singling out. Per-stream status lives on the Admin grid tiles.
  sourceName?: string;
  connected?: boolean;
  // TEACH: `children?: ReactNode` means the component can be used as
  // <TopBar>...</TopBar> and whatever goes between the tags shows up here.
  children?: ReactNode;
}

// --- Render ---
export function TopBar({ connected, children }: TopBarProps) {
  // --- State / context ---
  // TEACH: `useLocation()` returns the router's current location. We pull
  // `pathname` via destructuring (`"/"`, `"/dashboard"`, etc.) and use it
  // below to apply an "active" style to the current nav link.
  const { pathname } = useLocation();
  // TEACH: Custom hook call. This reads the shared watchdog status that
  // was put into Context higher up the tree. Any component under the
  // provider can read it without it being passed down as a prop.
  const { status: wdStatus } = useWatchdogCtx();

  // TEACH: Safely pluck `error` count with optional chaining + nullish
  // coalescing so we never blow up if the shape is partial.
  const errorCount = wdStatus?.by_severity?.error ?? 0;

  // TEACH: Tri-state derivation. `connected` is a boolean | undefined, so
  // we map three cases to a "variant" string the Dot component understands.
  const statusVariant = connected === true ? "ok" : connected === false ? "bad" : "wait";
  const statusLabel =
    connected === true ? "live" : connected === false ? "disconnected" : "connecting…";

  return (
    <header className={styles.topbar}>
      {/* TEACH: Brand link back to home. `<Link to="/">` renders an <a> but
          navigates via history.push — no full-page reload. */}
      <Link to="/" className={styles.brand}>
        <svg
          width="18"
          height="18"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <circle cx="12" cy="12" r="10" />
          <path d="M12 8v4l2 2" />
        </svg>
        Road Safety
      </Link>
      {/* TEACH: Nav — each <Link> targets a route. The `className` gets the
          `styles.active` string when `pathname` matches, so CSS can bold
          the current tab. An alternative is react-router's `<NavLink>` which
          accepts an `activeClassName` / function for className — same idea,
          slightly less boilerplate. */}
      <nav className={styles.nav}>
        <Link to="/" className={pathname === "/" ? styles.active : ""}>
          Admin
        </Link>
        <Link to="/dashboard" className={pathname === "/dashboard" ? styles.active : ""}>
          Dashboard
        </Link>
        <Link
          to="/monitoring"
          className={`${styles.monLink} ${pathname === "/monitoring" ? styles.active : ""}`}
        >
          Monitoring
          {/* TEACH: Short-circuit conditional render: `cond && <JSX/>`.
              When cond is falsy (0 here) React renders *nothing*. When
              truthy, the JSX renders. Be careful with numeric zero — `0 &&
              <x/>` renders "0" as text, which is why we check `> 0`. */}
          {errorCount > 0 && (
            <span className={styles.errorBubble}>{errorCount}</span>
          )}
        </Link>
        {/* Settings Console — admin-tier tuning + templates + baseline impact. */}
        <Link
          to="/settings"
          className={pathname === "/settings" ? styles.active : ""}
        >
          Settings
        </Link>
      </nav>
      {/* TEACH: Flex spacer — pushes the status pill + children to the
          right. Pure layout, lives in CSS. */}
      <span className={styles.spacer} />
      {/* TEACH: Composed UI primitive. `<Pill>` is a styled shell, `<Dot>`
          is a colored status dot. Composition beats one-mega-component. */}
      <Pill>
        <Dot variant={statusVariant} />
        <span>{statusLabel}</span>
      </Pill>
      {/* TEACH: `{children}` renders whatever the parent passed between
          <TopBar>...</TopBar>. App.tsx / AdminPage uses this to inject the
          TestBadge into the header on specific pages. */}
      {children}
    </header>
  );
}
