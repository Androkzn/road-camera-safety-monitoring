import { Link, useLocation } from "react-router-dom";
import { Pill, Dot } from "../ui";
import type { ReactNode } from "react";
import { useWatchdogCtx } from "../../hooks/WatchdogContext";
import styles from "./TopBar.module.css";

interface TopBarProps {
  sourceName?: string;
  connected?: boolean;
  children?: ReactNode;
}

export function TopBar({ sourceName = "—", connected, children }: TopBarProps) {
  const { pathname } = useLocation();
  const { status: wdStatus } = useWatchdogCtx();

  const errorCount = wdStatus?.by_severity?.error ?? 0;

  const statusVariant = connected === true ? "ok" : connected === false ? "bad" : "wait";
  const statusLabel =
    connected === true
      ? `${sourceName} • live`
      : connected === false
        ? `${sourceName} • disconnected`
        : `${sourceName} • connecting…`;

  return (
    <header className={styles.topbar}>
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
          {errorCount > 0 && (
            <span className={styles.errorBubble}>{errorCount}</span>
          )}
        </Link>
      </nav>
      <span className={styles.spacer} />
      <Pill>
        <Dot variant={statusVariant} />
        <span>{statusLabel}</span>
      </Pill>
      {children}
    </header>
  );
}
