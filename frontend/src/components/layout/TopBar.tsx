import { Link, useLocation } from "react-router-dom";
import { Pill, Dot } from "../ui";
import type { ReactNode } from "react";
import styles from "./TopBar.module.css";

interface TopBarProps {
  sourceName?: string;
  connected?: boolean;
  children?: ReactNode;
}

export function TopBar({ sourceName = "—", connected, children }: TopBarProps) {
  const { pathname } = useLocation();

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
          Dashboard
        </Link>
        <Link to="/admin" className={pathname === "/admin" ? styles.active : ""}>
          Admin
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
