/**
 * AdminPage — live detection feed for operators.
 *
 * Route binding:
 *   Rendered by <Route path="/admin" element={<AdminPage/>} /> in
 *   frontend/src/App.tsx. React Router picks this component when the URL
 *   path is "/admin"; `AdminPage` is a plain function component, React Router
 *   does not know anything special about it.
 *
 * What the user sees (plain English):
 *   - A top bar showing the video source name, connection status, and a live
 *     uptime pill that ticks once per second.
 *   - A coloured "health strip" summarising edge-node health (cpu, mem, fps).
 *   - A main area split into two columns:
 *       Left  : a `VideoFeed` that renders the live stream with bounding boxes.
 *       Right : a sidebar with three tabs — Detections (current frame boxes),
 *               Events (every SSE event as it arrives) and History (recent
 *               events pulled from the HTTP history endpoint).
 *
 * Hooks called:
 *   - useAdminHealth()  → { data: health }         — see hooks/useAdminHealth.ts.
 *     Polls /api/admin/health on an interval and returns the latest snapshot
 *     (server.started_at, server.source, cpu, mem, fps, …).
 *   - useDetections()   → { frames, stats }        — see hooks/useDetections.ts.
 *     Subscribes to per-frame detection boxes over SSE; `frames` is the rolling
 *     window of frames, `stats` is the aggregated counters.
 *   - useEventStream()  → { events, connected }    — see hooks/useEventStream.ts.
 *     Listens to /api/live/stream (SSE) for high-level conflict events produced
 *     by the backend pipeline (road_safety/server.py::_emit_event). `connected`
 *     drives the reconnection UX in the TopBar; `events` is the trimmed buffer.
 *   - useState<number | null>(null)                — local clock state for uptime.
 *   - useEffect(...)                                — runs the 1s setInterval tick.
 *
 * Child components composed here:
 *   - components/layout/TopBar.tsx          — page chrome + nav + status dot.
 *   - components/ui/Pill.tsx                — small rounded label element.
 *   - components/admin/HealthStrip.tsx      — edge-node health bar.
 *   - components/admin/VideoFeed.tsx       — canvas showing the live frames.
 *   - components/admin/DetectionsPanel.tsx  — detections tab content.
 *   - components/admin/HistoryPanel.tsx     — history tab content.
 *   - components/admin/TabBar.tsx           — tab picker (defaultTab, tabs[]).
 *   - components/events/AdminEventCard.tsx — one event row in the Events tab.
 *
 * React concepts demonstrated:
 *   - JSX and component composition (a page is just a function returning JSX).
 *   - Prop drilling (e.g. `health` is pulled here and handed to HealthStrip).
 *   - useState + useEffect with a cleanup function (the setInterval timer).
 *   - Conditional rendering with `? :` and `&&` inside the `tabs` array.
 *   - List rendering via `.map()` with `key={ev.event_id}` on AdminEventCard.
 *   - CSS Modules import: `styles` is an object whose keys are class names;
 *     Vite hashes them so `styles.main` becomes something like `AdminPage_main__ab12`
 *     at build time, which gives us scoped, collision-free CSS.
 *
 * Page-specific mechanics:
 *   - SSE reconnection UX: the `connected` boolean from useEventStream flows
 *     into <TopBar connected={...}/>, which shows a red/green dot. The hook
 *     itself owns the EventSource and auto-reconnects with backoff.
 *   - Event buffer trimming: useEventStream caps `liveEvents` to a fixed
 *     length so the Events tab can render via `.map()` without ever becoming
 *     unbounded — important on long-running operator shifts.
 *   - The Events tab body is a scrolling list (`styles.evtList` is the
 *     overflow container in AdminPage.module.css).
 */

// TEACH: Imports from "react" pull named hooks. `useState` holds local component
// state, `useEffect` schedules side effects after render. Both MUST be called at
// the top level of the function component, in the same order, every render —
// this is the "Rules of Hooks" — React tracks them by call index, not name.
import { useState, useEffect } from "react";
import { TopBar } from "../components/layout/TopBar";
import { Pill } from "../components/ui";
import { HealthStrip, VideoFeed, DetectionsPanel, HistoryPanel, TabBar } from "../components/admin";
import { AdminEventCard } from "../components/events";
import { useAdminHealth } from "../hooks/useAdminHealth";
import { useDetections } from "../hooks/useDetections";
import { useEventStream } from "../hooks/useEventStream";
import { formatUptime } from "../lib/format";
// TEACH: CSS Modules — `import styles from './X.module.css'` gives a plain
// object mapping source class names to generated hashed names. Using
// `className={styles.main}` makes CSS scoped to this component: two files can
// both define `.main` with no collision. See AdminPage.module.css (sibling).
import styles from "./AdminPage.module.css";

// TEACH: Component function. A component is just a function whose name is
// capitalised and which returns JSX. React calls this function whenever its
// props change or any `useState` value it owns is updated, and diffs the
// returned JSX against the previous one to decide what real DOM to mutate.
export function AdminPage() {
  // --- Hooks ---
  // TEACH: Custom hooks (any function starting with `use`) can themselves call
  // built-in hooks. Destructuring with a rename (`data: health`) is a plain JS
  // idiom — it's "take the `data` key out of the returned object and call the
  // local binding `health`".
  const { data: health } = useAdminHealth();
  const { frames, stats } = useDetections();
  const { events: liveEvents, connected } = useEventStream();

  // --- Derived state ---
  // TEACH: Nullish coalescing `??` returns the right operand when the left is
  // `null` or `undefined` (not "falsy" — `0` and `""` pass through unchanged).
  // The optional chain `health?.server.started_at` short-circuits to undefined
  // if `health` has not arrived from the network yet.
  const startedAt = health?.server.started_at ?? null;

  // TEACH: useState returns a tuple [value, setter]. Calling `setUptimeSec(x)`
  // queues a re-render of this component with the new value. `<number | null>`
  // is a TypeScript generic telling TS what values this state can hold.
  const [uptimeSec, setUptimeSec] = useState<number | null>(null);

  // TEACH: useEffect runs AFTER the browser paints. The dependency array
  // `[startedAt]` controls re-runs: the effect re-fires only when `startedAt`
  // changes. The returned function is the CLEANUP — React calls it before the
  // next run and on unmount, so `clearInterval(id)` prevents a timer leak if
  // the server ever reports a new start time (or if we navigate away).
  useEffect(() => {
    if (!startedAt) return;
    const tick = () => setUptimeSec(Date.now() / 1000 - startedAt);
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, [startedAt]);

  const evtCount = liveEvents.length;

  // --- Render ---
  return (
    // TEACH: `<>…</>` is a React Fragment — a group with no wrapping DOM node.
    // Use it when you want to return multiple siblings from a component without
    // adding an extra <div> to the HTML.
    <>
      {/* Top application bar — source name, connection dot, uptime pill. */}
      <TopBar
        sourceName={health?.server.source ?? "—"}
        connected={connected}
      >
        {/* TEACH: Anything between <TopBar>…</TopBar> becomes TopBar's
            `children` prop. Here we pass a <Pill> that TopBar renders on the
            right side. This is how React does "slot" composition. */}
        <Pill style={{ marginLeft: 8 }}>
          uptime <strong style={{ marginLeft: 4 }}>{formatUptime(uptimeSec)}</strong>
        </Pill>
      </TopBar>

      {/* Edge-node health summary (cpu/mem/fps bars). */}
      <HealthStrip health={health} />

      {/* Main split layout: video on the left, tabbed sidebar on the right. */}
      <div className={styles.main}>
        <VideoFeed stats={stats} />

        <div className={styles.sidebar}>
          {/* TEACH: `tabs` is a plain array of objects passed as a prop.
              Notice each tab's `content` is JSX — JSX values are first-class
              and can be stored in variables, arrays, or passed as props. */}
          <TabBar
            defaultTab="detections"
            tabs={[
              {
                id: "detections",
                label: "Detections",
                content: <DetectionsPanel frames={frames} />,
              },
              {
                id: "events",
                label: (
                  // Label is itself a fragment so we can show a count pill.
                  <>
                    Events{" "}
                    {/* TEACH: `{cond && <X/>}` — short-circuit AND. If `cond`
                        is falsy React renders nothing; if truthy React renders
                        the right side. Avoid numeric `cond` (0) here because
                        0 is falsy but still renders as the string "0". */}
                    {evtCount > 0 && (
                      <span style={{ fontSize: "10px", color: "var(--muted)" }}>
                        ({evtCount})
                      </span>
                    )}
                  </>
                ),
                content: (
                  // The scrolling event list. CSS in AdminPage.module.css
                  // gives this container `overflow-y: auto`.
                  <div className={styles.evtList}>
                    {/* TEACH: Ternary for either/or conditional rendering —
                        empty-state message when there are no events, otherwise
                        a mapped list of cards. */}
                    {liveEvents.length === 0 ? (
                      <div className={styles.empty}>
                        No events yet — they appear here in real time
                      </div>
                    ) : (
                      // TEACH: List rendering. `.map(ev => <X key=…/>)` is the
                      // canonical pattern. `key` must be unique & stable per
                      // sibling so React can reuse DOM nodes across renders
                      // when the list reorders. `event_id` comes from the
                      // backend and is guaranteed unique per emitted event.
                      liveEvents.map((ev) => (
                        <AdminEventCard key={ev.event_id} event={ev} />
                      ))
                    )}
                  </div>
                ),
              },
              {
                id: "history",
                label: "History",
                content: <HistoryPanel />,
              },
            ]}
          />
        </div>
      </div>
    </>
  );
}
