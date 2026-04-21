/**
 * Tunable — compound component for one tunable row.
 *
 * The original SettingsPage shipped a single ~200-line `TunableControl`
 * that hard-coded the slider+number+label+validation+help+reset combo.
 * Splitting it into compound parts gives callers a "use only what you
 * need" composition surface and makes each part independently testable.
 *
 * Default usage (matches the legacy layout):
 *
 *   <Tunable spec={spec} draft={draft} effective={eff} onChange={…} errorReason={…}>
 *     <Tunable.Label />
 *     <Tunable.Control />
 *     <Tunable.Meta />
 *   </Tunable>
 *
 * Each part reads context — the parent supplies it once via
 * <Tunable …> and the children read it via React context. This is the
 * "compound component" pattern.
 *
 * --- UI mapping ---
 * Page: SettingsPage ([file](frontend/src/features/settings/SettingsPage.tsx))
 * UI element: each tunable row in the left column (label + slider /
 *   number input + small reset/help meta line below it).
 *
 * Backend: no direct calls. Edits update a local draft map on the parent
 *   page; the draft is POSTed to /api/settings/apply when the operator
 *   hits Apply. The spec metadata (min/max/step/default/description)
 *   originates from GET /api/settings.
 */

import {
  Fragment,
  createContext,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";

import { TUNABLE_HELP } from "../constants";
import type { DraftValue, SettingSpec } from "../types";
import { humanize } from "../utils/formatting";
import { stepFor } from "../utils/steps";

import styles from "../SettingsPage.module.css";

/** Context value shared by every Tunable.* child. */
interface TunableContextValue {
  spec: SettingSpec;
  effective: DraftValue;
  draft: DraftValue;
  errorReason: string | null;
  onChange: (v: DraftValue) => void;
}

// React context: a way to pass data deep into a subtree without prop-drilling.
// `| null` lets us default to null and throw a clear error if a child is
// mounted outside the provider by accident (see useTunable below).
const TunableContext = createContext<TunableContextValue | null>(null);

/** Internal hook — every Tunable.* part uses it to read the parent context. */
function useTunable(): TunableContextValue {
  const ctx = useContext(TunableContext);
  if (!ctx) {
    throw new Error("Tunable.* parts must be rendered inside <Tunable>");
  }
  return ctx;
}

// `extends` pulls every field from TunableContextValue into the new interface,
// then we add `children`. Saves us from duplicating field lists.
interface TunableRootProps extends TunableContextValue {
  children?: ReactNode;
}

/**
 * Tunable root — compound-component provider.
 *
 * Parent: TunablesColumn (one <Tunable> per spec).
 * Children: Tunable.Label / Tunable.Control / Tunable.Meta (default set
 *   if no explicit children are passed).
 * BE: none directly; edits propagate to the parent draft map.
 *
 * Provides context to Tunable.Label / .Control / .Meta, and if no
 * children are passed renders the default three-part layout. Also
 * toggles "dirty" / "error" CSS classes based on current state.
 */
export function Tunable(props: TunableRootProps) {
  // Rest destructuring: `children` goes one place, everything else
  // becomes the context value. `...ctx` collects remaining props.
  const { children, ...ctx } = props;
  // "Dirty" = the operator has changed the value but not saved yet.
  const dirty = ctx.draft !== ctx.effective;
  const cls = [styles.tunable, dirty ? styles.dirty : "", ctx.errorReason ? styles.error : ""]
    .filter(Boolean)
    .join(" ");
  return (
    // `<Context.Provider value={…}>` publishes `value` to every descendant
    // that calls `useContext(Context)`. Children decide what to render
    // with it — here, `Label` / `Control` / `Meta` by default.
    <TunableContext.Provider value={ctx}>
      <div className={cls}>
        {children ?? (
          <Fragment>
            <Label />
            <Control />
            <Meta />
          </Fragment>
        )}
      </div>
    </TunableContext.Provider>
  );
}

// ---------------------------------------------------------------------------
// Label + integrated help popover
// ---------------------------------------------------------------------------

/**
 * Label part — renders the key name, description, validation error, and
 * an optional "i" info button that opens a position-pinned popover.
 */
function Label() {
  const { spec, errorReason } = useTunable();
  const help = TUNABLE_HELP[spec.key];

  const [helpOpen, setHelpOpen] = useState(false);
  // useRef creates a mutable box that survives re-renders. `.current`
  // holds the latest DOM node once React assigns it via the `ref=` prop.
  // Unlike state, writing to `.current` does NOT cause a re-render.
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [popoverPos, setPopoverPos] = useState<{
    top: number;
    left: number;
  } | null>(null);

  // Outside-click + Escape to dismiss. The effect runs whenever `helpOpen`
  // flips; if closed we early-return so we don't install listeners.
  useEffect(() => {
    if (!helpOpen) return;
    const onDown = (e: MouseEvent) => {
      const tgt = e.target as Node | null;
      if (tgt && !popoverRef.current?.contains(tgt) && !triggerRef.current?.contains(tgt)) {
        setHelpOpen(false);
      }
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setHelpOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [helpOpen]);

  // useLayoutEffect runs synchronously AFTER DOM mutations but BEFORE the
  // browser paints — ideal for measuring layout and setting position
  // without a visible flicker.
  useLayoutEffect(() => {
    if (!helpOpen) {
      setPopoverPos(null);
      return;
    }
    const POPOVER_W = 340;
    const POPOVER_H_EST = 220;
    const update = () => {
      const trigger = triggerRef.current;
      if (!trigger) return;
      const r = trigger.getBoundingClientRect();
      const vw = window.innerWidth;
      const vh = window.innerHeight;
      let top = r.bottom + 10;
      let left = r.left - 10;
      if (left + POPOVER_W > vw - 8) left = Math.max(8, vw - POPOVER_W - 8);
      if (top + POPOVER_H_EST > vh - 8) top = Math.max(8, r.top - POPOVER_H_EST - 10);
      setPopoverPos({ top, left });
    };
    update();
    window.addEventListener("scroll", update, true);
    window.addEventListener("resize", update);
    return () => {
      window.removeEventListener("scroll", update, true);
      window.removeEventListener("resize", update);
    };
  }, [helpOpen]);

  return (
    <div className={styles.keyCol}>
      <span className={styles.keyLabel} title={spec.key}>
        {humanize(spec.key)}
        {help && (
          <span className={styles.helpAnchor}>
            <button
              ref={triggerRef}
              type="button"
              className={styles.infoBtn}
              aria-label={`More info about ${humanize(spec.key)}`}
              aria-expanded={helpOpen}
              onClick={() => setHelpOpen((o) => !o)}
            >
              i
            </button>
            {helpOpen && popoverPos && (
              <div
                ref={popoverRef}
                className={styles.helpPopover}
                role="dialog"
                style={{ top: popoverPos.top, left: popoverPos.left }}
              >
                <button
                  type="button"
                  className={styles.helpClose}
                  aria-label="Close"
                  onClick={() => setHelpOpen(false)}
                >
                  ×
                </button>
                <h4 className={styles.helpTitle}>{humanize(spec.key)}</h4>
                <p>
                  <strong>What it is.</strong> {help.what}
                </p>
                <p>
                  <strong>Affects.</strong> {help.affects}
                </p>
                {help.increase && (
                  <p>
                    <strong>↑ Increasing.</strong> {help.increase}
                  </p>
                )}
                {help.decrease && (
                  <p>
                    <strong>↓ Decreasing.</strong> {help.decrease}
                  </p>
                )}
                {help.options && (
                  <ul className={styles.helpOptions}>
                    {Object.entries(help.options).map(([opt, txt]) => (
                      <li key={opt}>
                        <code>{opt}</code> — {txt}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </span>
        )}
      </span>
      <span className={styles.keyDesc}>{spec.description}</span>
      {errorReason && <span className={styles.keyError}>{errorReason}</span>}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Control — picks slider+number / select / checkbox / text based on spec.type
// ---------------------------------------------------------------------------

/**
 * Control part — picks a widget based on `spec.type`:
 * enum → <select>, bool → checkbox, int/float → slider+number pair,
 * everything else → text input.
 */
function Control() {
  const { spec, draft, onChange } = useTunable();

  if (spec.type === "enum" && spec.enum) {
    return (
      <div className={styles.controlCol}>
        <select value={String(draft)} onChange={(e) => onChange(e.target.value)}>
          {spec.enum.map((v) => (
            <option key={v} value={v}>
              {humanize(v)}
            </option>
          ))}
        </select>
      </div>
    );
  }
  if (spec.type === "bool") {
    return (
      <div className={styles.controlCol}>
        <input type="checkbox" checked={!!draft} onChange={(e) => onChange(e.target.checked)} />
      </div>
    );
  }
  if (spec.type === "int" || spec.type === "float") {
    const min = spec.min ?? 0;
    const max = spec.max ?? 100;
    const step = stepFor(spec, min, max);
    // Snap entered values to the slider's step grid. Without this the
    // number input can produce values like 0.123456 that the slider
    // would visually round to 0.12 — bad UX and bad for the backend.
    const parse = (s: string) => {
      const n = spec.type === "int" ? parseInt(s, 10) : parseFloat(s);
      if (!Number.isFinite(n)) return spec.type === "int" ? 0 : 0;
      const snapped = Math.round((n - min) / step) * step + min;
      const digits = step >= 1 ? 0 : Math.min(6, Math.max(0, -Math.floor(Math.log10(step))));
      return Number(snapped.toFixed(digits));
    };
    return (
      <div className={styles.controlCol}>
        <input
          type="range"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) => onChange(parse(e.target.value))}
        />
        <input
          type="number"
          min={min}
          max={max}
          step={step}
          value={Number(draft)}
          onChange={(e) => onChange(parse(e.target.value))}
        />
      </div>
    );
  }
  return (
    <div className={styles.controlCol}>
      <input type="text" value={String(draft)} onChange={(e) => onChange(e.target.value)} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Meta — reset button + mutability badges
// ---------------------------------------------------------------------------

/**
 * Meta part — the "Reset to default" button plus any mutability badges
 * (e.g. a read-only indicator for settings the operator can see but not change).
 */
function Meta() {
  const { spec, draft, onChange } = useTunable();
  return (
    <div className={styles.metaCol}>
      <button
        type="button"
        className={styles.resetBtn}
        disabled={draft === spec.default}
        onClick={() => onChange(spec.default as DraftValue)}
        title={`Reset to spec default (${String(spec.default)})`}
      >
        Reset to {String(spec.default)}
      </button>
      {spec.mutability === "read_only" && (
        <span className={`${styles.badge} ${styles.badgeReadonly}`}>read-only</span>
      )}
    </div>
  );
}

// Attach the parts as static properties of the root. Lets callers use
// `<Tunable.Label />` syntax instead of importing each one separately.
// `Label` / `Control` / `Meta` are all consumers of TunableContext so
// they must be rendered inside <Tunable> (enforced by useTunable).
Tunable.Label = Label;
Tunable.Control = Control;
Tunable.Meta = Meta;
