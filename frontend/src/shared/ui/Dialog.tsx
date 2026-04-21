/**
 * Dialog — themed alert / confirm dialogs that replace the native
 * `window.alert` / `window.confirm` browser modals.
 *
 * Usage:
 * 1. Mount `<DialogProvider>` once near the root (already wired into
 *    `app/providers.tsx`).
 *
 * 2. From a component:
 *      const dialog = useDialog();
 *      const ok = await dialog.confirm({
 *        title: "Delete template?",
 *        message: `This will soft-delete "${name}".`,
 *        variant: "danger",
 *      });
 *
 * 3. From a non-component (helper function, error handler):
 *      import { dialog } from "@/shared/ui";
 *      await dialog.alert({ message: "Token rejected." });
 *
 * Both APIs return promises so callers can `await` the operator's
 * choice. Built on the native <dialog> element for focus management,
 * Esc-to-cancel, and a11y baked in.
 *
 * --- UI mapping ---
 * Used on: All pages (global layout) — the provider is mounted once near
 *   the app root, and any feature on AdminPage, DashboardPage,
 *   MonitoringPage, SettingsPage or ValidationPage can call useDialog().
 * UI element: themed modal dialog overlay with a title, message body and
 *   one or two action buttons; replaces the native window.alert /
 *   window.confirm boxes.
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

// Module-local reference to the currently mounted provider's API.
// Lets non-component callers (helpers, interceptors) go through `dialog`
// without needing access to React context / hooks.
let _dialogApi: DialogApi | null = null;

/**
 * Module-level singleton — works from anywhere (including outside React).
 * Falls back to native `window.alert`/`confirm` if no provider is mounted,
 * so helper code never crashes just because the tree isn't ready.
 */
export const dialog: DialogApi = {
  alert: (opts) => {
    if (!_dialogApi) {
      window.alert(typeof opts.message === "string" ? opts.message : (opts.title ?? ""));
      return Promise.resolve();
    }
    return _dialogApi.alert(opts);
  },
  confirm: (opts) => {
    if (!_dialogApi) {
      const ok = window.confirm(
        typeof opts.message === "string" ? opts.message : (opts.title ?? ""),
      );
      return Promise.resolve(ok);
    }
    return _dialogApi.confirm(opts);
  },
};

const DialogContext = createContext<DialogApi | null>(null);

/**
 * Hook for components — returns the provider's API if one is mounted,
 * otherwise falls back to the module singleton (which itself falls back
 * to native browser dialogs).
 */
export function useDialog(): DialogApi {
  const ctx = useContext(DialogContext);
  if (ctx) return ctx;
  return dialog;
}

interface QueueEntry {
  id: number;
  kind: "alert" | "confirm";
  opts: ConfirmOptions;
  resolve: (value: boolean) => void;
}

let _entryCounter = 0;

/**
 * DialogProvider — mount once near the app root. Owns the queue of
 * pending alerts/confirms and renders the single native <dialog> element
 * that shows the top-of-queue entry.
 */
export function DialogProvider({ children }: { children: ReactNode }) {
  // Queue of pending dialogs — we show them one at a time in FIFO order.
  const [queue, setQueue] = useState<QueueEntry[]>([]);
  // `useRef` gives us a mutable pointer to the DOM <dialog> element
  // without triggering re-renders when it's assigned.
  const dialogRef = useRef<HTMLDialogElement | null>(null);

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
          setQueue((q) => [...q, { id: ++_entryCounter, kind: "confirm", opts, resolve }]);
        }),
    }),
    [],
  );

  useEffect(() => {
    _dialogApi = api;
    return () => {
      if (_dialogApi === api) _dialogApi = null;
    };
  }, [api]);

  const current = queue[0];

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
            {current.opts.title && <h2 className={styles.title}>{current.opts.title}</h2>}
            <div className={styles.body}>
              {typeof current.opts.message === "string" ? (
                <p>{current.opts.message}</p>
              ) : (
                current.opts.message
              )}
            </div>
            <div className={styles.actions}>
              {current.kind === "confirm" && (
                <button type="button" className={styles.btnGhost} onClick={() => dismiss(false)}>
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
