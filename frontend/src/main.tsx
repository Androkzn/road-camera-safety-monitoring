/**
 * main.tsx — the browser entry point that boots the React app into the page.
 *
 * What it does:
 *   This file mounts the whole frontend onto the <div id="root"> element in
 *   index.html. It wraps the app in three "providers" that the rest of the
 *   code depends on: StrictMode (extra dev-time checks), BrowserRouter
 *   (client-side URL routing), and WatchdogProvider (shared watchdog data).
 *
 * Purpose:
 *   Every React app needs one file that calls createRoot(...).render(...) to
 *   kick things off. This is that file. If this fails, nothing else renders.
 *
 * How it works:
 *   - createRoot(element).render(jsx) tells React to take control of that DOM
 *     node and paint the given JSX tree into it.
 *   - StrictMode: a dev-only wrapper from React that double-invokes certain
 *     functions to surface bugs early. It has no effect in production builds.
 *   - BrowserRouter: from react-router-dom; enables URL-based page switching
 *     (the <Routes> inside App.tsx read from it).
 *   - WatchdogProvider: a custom "context provider" hook — a React pattern
 *     where one component holds shared state and every descendant can read it
 *     via useWatchdogCtx(). See hooks/WatchdogContext.tsx.
 *   - The "!" after getElementById is TypeScript's "non-null assertion" —
 *     it tells the compiler "trust me, this element exists".
 *
 * Connects to:
 *   - Backend: none — pure client-side bootstrap.
 *   - UI: loads <App/> (frontend/src/App.tsx) and the global stylesheet
 *     (frontend/src/styles/global.css). This file is itself loaded by
 *     frontend/index.html via a <script type="module"> tag.
 */
// React core + DOM renderer. StrictMode is a dev-only wrapper that double-runs
// some functions to flush out bugs; createRoot attaches React to a DOM node.
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
// BrowserRouter enables URL-based page switching; required by <Routes> in App.
import { BrowserRouter } from "react-router-dom";
// App-wide shared store for watchdog incidents (see hooks/WatchdogContext.tsx).
import { WatchdogProvider } from "./hooks/WatchdogContext";
import { App } from "./App";
// Global CSS reset + design tokens — imported for its side-effect only.
import "./styles/global.css";

// Boot the whole app: grab the <div id="root"> from index.html (the "!" tells
// TypeScript "trust me, it exists") and render the provider stack into it.
// Providers wrap the app so every descendant can read their shared values:
//   StrictMode → BrowserRouter (router state) → WatchdogProvider (findings) → App.
createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <BrowserRouter>
      <WatchdogProvider>
        <App />
      </WatchdogProvider>
    </BrowserRouter>
  </StrictMode>,
);
