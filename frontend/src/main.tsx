/**
 * main.tsx — Browser entry point for the React app.
 *
 * WHAT THIS FILE IS
 *   This is the very first piece of our JavaScript/TypeScript that runs in the
 *   user's browser. It mounts the entire React component tree into a single
 *   `<div id="root">` that lives in `frontend/index.html`.
 *
 *   Look at `frontend/index.html`:
 *     <div id="root"></div>
 *     <script type="module" src="/src/main.tsx"></script>
 *   The `<script type="module">` tag is how Vite (our dev server / bundler)
 *   loads this file. Everything you see in the browser below the top-bar is
 *   rendered by React starting from here.
 *
 * WHERE IT FITS
 *   index.html  ->  main.tsx  ->  <App />  ->  pages (Admin/Dashboard/Monitoring)
 *
 * REACT CONCEPTS INTRODUCED
 *   - `createRoot`   : the React 18+ API that "attaches" React to a real DOM node.
 *   - `<StrictMode>` : a development-only wrapper that double-invokes effects
 *                      and renders to surface subtle bugs (no effect in prod).
 *   - JSX            : the `<Tag>...</Tag>` syntax in TS/JS. It is NOT HTML; it
 *                      compiles to `React.createElement(...)` calls.
 *   - Context Provider: `<WatchdogProvider>` shares watchdog data with any
 *                       descendant component without passing props manually.
 *   - `<BrowserRouter>`: react-router's top-level provider that reads the URL
 *                        from the browser and lets child `<Route>`s match it.
 */

// --- Imports ---

// `StrictMode` comes from React core. It renders nothing visible; it just
// turns on extra runtime checks in development. In React 18+ it deliberately
// mounts each component twice so you notice missing cleanup in effects.
import { StrictMode } from "react";

// `createRoot` is the modern React 18 replacement for the old `ReactDOM.render`.
// It creates a "root" bound to a real DOM element and lets React manage
// everything inside that element.
import { createRoot } from "react-dom/client";

// `BrowserRouter` uses the HTML5 History API (pushState) so URLs like
// `/dashboard` work without a full page reload. Only ONE router should wrap
// the whole app — that is why it lives here at the entry point.
import { BrowserRouter } from "react-router-dom";

// React Context lets us "broadcast" data to deeply nested components. The
// WatchdogProvider polls `/api/watchdog/*` endpoints once and lets the TopBar
// badge AND the MonitoringPage read the same data without re-fetching.
// Defined in hooks/WatchdogContext.tsx.
import { WatchdogProvider } from "./hooks/WatchdogContext";
import { DialogProvider } from "./components/ui/Dialog";

// Our root component. It owns the route table. Defined in App.tsx.
import { App } from "./App";

// Global CSS — imported for side effects. Vite handles CSS bundling and
// injects it into the page. The file path resolves via Vite's module system.
import "./styles/global.css";

// --- Mount the React tree into the DOM ---

// 1. `document.getElementById("root")` returns the <div id="root"> from index.html.
//    The trailing `!` is a TypeScript "non-null assertion": it tells the compiler
//    "I know this is not null" (otherwise the return type would be HTMLElement|null).
// 2. `createRoot(...)` wraps that DOM node in a React root.
// 3. `.render(<tree>)` hands React the JSX tree to draw. After this call, React
//    owns the contents of #root and will re-render as state/props change.
createRoot(document.getElementById("root")!).render(
  // StrictMode wraps everything so React can run extra dev-time checks.
  <StrictMode>
    {/* BrowserRouter reads/writes the URL. All <Route> / <Link> usage below
        this component gets access to routing via React context. */}
    <BrowserRouter>
      {/* WatchdogProvider polls the watchdog status once and exposes it to any
          child via `useWatchdog()`. Placed above <App /> so every page sees it. */}
      <WatchdogProvider>
        {/* DialogProvider exposes themed alert/confirm dialogs to every
            component (via useDialog) and to non-component code paths
            (via the `dialog` singleton). Replaces window.alert/confirm. */}
        <DialogProvider>
          {/* <App /> is JSX shorthand for `React.createElement(App)`. React
              instantiates the App component here — this is the real start of
              the UI tree. */}
          <App />
        </DialogProvider>
      </WatchdogProvider>
    </BrowserRouter>
  </StrictMode>,
);
