import { useState, useEffect, useCallback, useRef } from "react";
import { api } from "../lib/api";
import type { TestStatus } from "../types";

export function useTests() {
  const [status, setStatus] = useState<TestStatus | null>(null);
  const lastStatusRef = useRef<string>("idle");

  const poll = useCallback(async () => {
    try {
      const data = await api.getTestStatus();
      setStatus(data);
      lastStatusRef.current = data.status;
    } catch {
      /* silent */
    }
  }, []);

  useEffect(() => {
    poll();
    const intervalMs = lastStatusRef.current === "running" ? 1500 : 10000;
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [poll]);

  useEffect(() => {
    if (!status) return;
    const intervalMs = status.status === "running" ? 1500 : 10000;
    const id = setInterval(poll, intervalMs);
    return () => clearInterval(id);
  }, [status?.status, poll]);

  const rerun = useCallback(async () => {
    await api.runTests();
    poll();
  }, [poll]);

  return { status, rerun, refetch: poll };
}
