const pad2 = (n: number): string => String(n).padStart(2, "0");

export function formatWallTime(ts?: string | number): string {
  const d = ts ? new Date(ts) : new Date();
  if (isNaN(d.getTime())) return "—";
  return `${pad2(d.getHours())}:${pad2(d.getMinutes())}:${pad2(d.getSeconds())}`;
}

export function humanEventType(t?: string): string {
  return (t || "event")
    .replace(/_/g, " ")
    .replace(/^\w/, (c) => c.toUpperCase());
}

export function formatUptime(secs?: number | null): string {
  if (secs == null || secs < 0) return "—";
  const h = Math.floor(secs / 3600);
  const m = Math.floor((secs % 3600) / 60);
  const s = Math.floor(secs % 60);
  return h > 0 ? `${h}h ${pad2(m)}m` : `${pad2(m)}:${pad2(s)}`;
}

export function formatConfidence(c?: number | null): string {
  return c != null ? `${Math.round(c * 100)}%` : "—";
}

export function normalizeThumbnail(thumb?: string): string {
  if (!thumb) return "";
  if (/^https?:/.test(thumb) || thumb.startsWith("/")) return thumb;
  return "/" + thumb;
}
