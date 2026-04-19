/**
 * Dialog — themed alert / confirm dialogs that replace the native
 * ``window.alert`` / ``window.confirm`` browser modals.
 *
 * Usage
 * -----
 * 1. Mount ``<DialogProvider>`` once near the root of the React tree
 *    (already wired into ``main.tsx`` alongside ``WatchdogProvider``).
 *
 * 2. From a component:
 *      ```ts
 *      const dialog = useDialog();
 *      const ok = await dialog.confirm({
 *        title: "Delete template?",
 *        message: `This will soft-delete "${name}".`,
 *        variant: "danger",
 *      });
 *      ```
 *
 * 3. From a non-component (helper function, error handler):
 *      ```ts
 *      import { dialog } from "../components/ui/Dialog";
 *      await dialog.alert({ message: "Token rejected." });
 *      ```
 *
 * Both APIs return promises so callers can ``await`` the operator's
 * choice — same ergonomics as the native dialogs they replace, but with
 * the app's dark theme, focus management, Esc-to-close, and keyboard
 * accessibility from the underlying ``<dialog>`` element.
 */

import {
  type ReactNode,
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

import styles from "./Dialog.module.css";

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------
export type DialogVariant = "info" | "warning" | "danger";

export interface AlertOptions {
  title?: string;
  message: ReactNode;
  okLabel?: string;
  variant?: DialogVariant;
}

export interface ConfirmOptions extends AlertOptions {
  cancelLabel?: string;
}

export interface DialogApi {
  alert: (opts: AlertOptions) => Promise<void>;
  confirm: (opts: ConfirmOptions) => Promise<boolean>;
}

// ---------------------------------------------------------------------------
// Imperative singleton — set by the provider on mount so non-component
// callers (e.g. error handlers) can still raise a themed dialog.
// ---------------------------------------------------------------------------
let _dialogApi: DialogApi | null = null;

export const dialog: DialogApi = {
  alert: (opts) => {
    if (!_dialogApi) {
      // Fallback for the rare case the provider isn't mounted yet — keeps
      // the app responsive and matches the legacy behaviour during boot.
      // eslint-disable-next-line no-alert
      window.alert(typeof opts.message === "string" ? opts.message : opts.title ?? "");
      return Promise.resolve();
    }
    return _dialogApi.alert(opts);
  },
  confirm: (opts) => {
    if (!_dialogApi) {
      // eslint-disable-next-line no-alert
      const ok = window.confirm(
        typeof opts.message === "string" ? opts.message : opts.title ?? "",
      );
      return Promise.resolve(ok);
    }
    return _dialogApi.confirm(opts);
  },
};

// ---------------------------------------------------------------------------
// React context + hook
// ---------------------------------------------------------------------------
const DialogContext = createContext<DialogApi | null>(null);

/** Hook accessor for components that prefer the React idiom. */
export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (ctx) return ctx;
  // Falling back to the singleton lets a component still call ``useDialog``
  // even if the provider hasn't been mounted in tests / storybook.
  return dialog;
}

// ---------------------------------------------------------------------------
// Internal queue model
// ---------------------------------------------------------------------------
interface QueueEntry {
  id: number;
  kind: "alert" | "confirm";
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let _entryCounter = 0;

// ---------------------------------------------------------------------------
// Provider
// ---------------------------------------------------------------------------
export function DialogProvider({ children }: { children: ReactNode }) {
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  const dialogRef = useRef<HTMLDialogElement | null>(null);

  // Stable API exposed via context + the imperative singleton.
  const api = useMemo<DialogApi>(
    () => ({
      alert: (opts) =>
        new Promise<void>((resolve) => {
          setQueue((q) => [
            ...q,
            {
              id: ++_entryCounter,
              kind: "alert",
              opts,
              resolve: () => resolve(),
            },
          ]);
        }),
      confirm: (opts) =>
        new Promise<boolean>((resolve) => {
          setQueue((q) => [
            ...q,
            {
              id: ++_entryCounter,
              kind: "confirm",
              opts,
              resolve,
            },
          ]);
        }),
    }),
    [],
  );

  // Wire the singleton on mount, clear on unmount so HMR doesn't leak it.
  useEffect(() => {
    _dialogApi = api;
    return () => {
      if (_dialogApi === api) _dialogApi = null;
    };
  }, [api]);

  const current = queue[0];

  // Drive the native ``<dialog>`` open/close lifecycle imperatively so the
  // browser handles focus trapping, Esc-to-cancel, and accessible roles.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    if (current && !el.open) el.showModal();
    if (!current && el.open) el.close();
  }, [current]);

  const dismiss = useCallback(
    (value: boolean) => {
      const entry = queue[0];
      if (!entry) return;
      entry.resolve(entry.kind === "alert" ? true : value);
      setQueue((q) => q.slice(1));
    },
    [queue],
  );

  // Esc native cancel — translated to a ``false`` for confirm dialogs.
  useEffect(() => {
    const el = dialogRef.current;
    if (!el) return;
    const onCancel = (e: Event) => {
      e.preventDefault();
      dismiss(false);
    };
    el.addEventListener("cancel", onCancel);
    return () => el.removeEventListener("cancel", onCancel);
  }, [dismiss]);

  const variant = current?.opts.variant ?? "info";
  const variantClass =
    variant === "danger"
      ? styles.variantDanger
      : variant === "warning"
        ? styles.variantWarning
        : styles.variantInfo;

  return (
    <DialogContext.Provider value={api}>
      {children}
      <dialog ref={dialogRef} className={`${styles.dialog} ${variantClass}`}>
        {current && (
          <form method="dialog" onSubmit={(e) => e.preventDefault()}>
            {current.opts.title && (
              <h2 className={styles.title}>{current.opts.title}</h2>
            )}
            <div className={styles.body}>
              {typeof current.opts.message === "string" ? (
                <p>{current.opts.message}</p>
              ) : (
                current.opts.message
              )}
            </div>
            <div className={styles.actions}>
              {current.kind === "confirm" && (
                <button
                  type="button"
                  className={styles.btnGhost}
                  onClick={() => dismiss(false)}
                >
                  {current.opts.cancelLabel ?? "Cancel"}
                </button>
              )}
              <button
                type="button"
                autoFocus
                className={
                  variant === "danger"
                    ? styles.btnDanger
                    : variant === "warning"
                      ? styles.btnWarning
                      : styles.btnPrimary
                }
                onClick={() => dismiss(true)}
              >
                {current.opts.okLabel ?? (current.kind === "confirm" ? "OK" : "Got it")}
              </button>
            </div>
          </form>
        )}
      </dialog>
    </DialogContext.Provider>
  );
}
