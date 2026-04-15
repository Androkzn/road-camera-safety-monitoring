"""LLM observability — token spend, latency, and quality tracking.

Every LLM call (narration, enrichment, chat) goes through ``record()`` which
captures input/output tokens, wall-clock latency, model, and call-type so the
operator can answer:

  * How much are we spending? (token budget burn rate)
  * Which call types dominate cost? (narration vs enrichment vs chat)
  * Are we hitting rate limits? (skip/error rate)
  * What's the P95 latency? (SLA compliance)

Storage: append-only in-memory ring buffer (capped at MAX_RECORDS). The
``/api/llm/stats`` endpoint exposes aggregated stats; ``/api/llm/recent``
exposes raw recent records for debugging.

Thread-safety: the ring buffer is guarded by a threading lock because
server.py's frame callback runs in a background thread and may trigger
narrate_event concurrently with chat calls on the asyncio loop.
"""

from __future__ import annotations

import statistics
import threading
import time
from collections import defaultdict
from dataclasses import dataclass, field
from typing import Any

MAX_RECORDS = 2000

COST_PER_1K_INPUT = {
    "claude-haiku-4-5-20251001": 0.001,
    "claude-sonnet-4-6": 0.003,
    "gpt-4o": 0.005,
    "default": 0.002,
}
COST_PER_1K_OUTPUT = {
    "claude-haiku-4-5-20251001": 0.005,
    "claude-sonnet-4-6": 0.015,
    "gpt-4o": 0.015,
    "default": 0.010,
}


@dataclass
class LLMRecord:
    call_type: str       # "narration" | "enrichment" | "chat" | "vision"
    model: str
    input_tokens: int
    output_tokens: int
    latency_ms: float
    success: bool
    error: str | None = None
    timestamp: float = field(default_factory=time.time)
    event_id: str | None = None
    skip_reason: str | None = None

    @property
    def estimated_cost_usd(self) -> float:
        in_rate = COST_PER_1K_INPUT.get(self.model, COST_PER_1K_INPUT["default"])
        out_rate = COST_PER_1K_OUTPUT.get(self.model, COST_PER_1K_OUTPUT["default"])
        return (self.input_tokens * in_rate + self.output_tokens * out_rate) / 1000.0


class LLMObserver:
    def __init__(self, max_records: int = MAX_RECORDS):
        self._lock = threading.Lock()
        self._records: list[LLMRecord] = []
        self._max = max_records
        self._total_calls = 0
        self._total_errors = 0
        self._total_skips = 0

    def record(
        self,
        call_type: str,
        model: str,
        input_tokens: int = 0,
        output_tokens: int = 0,
        latency_ms: float = 0.0,
        success: bool = True,
        error: str | None = None,
        event_id: str | None = None,
        skip_reason: str | None = None,
    ) -> LLMRecord:
        rec = LLMRecord(
            call_type=call_type,
            model=model,
            input_tokens=input_tokens,
            output_tokens=output_tokens,
            latency_ms=latency_ms,
            success=success,
            error=error,
            event_id=event_id,
            skip_reason=skip_reason,
        )
        with self._lock:
            self._records.append(rec)
            if len(self._records) > self._max:
                self._records = self._records[-self._max:]
            self._total_calls += 1
            if not success:
                self._total_errors += 1
            if skip_reason:
                self._total_skips += 1
        return rec

    def record_skip(
        self,
        call_type: str,
        model: str,
        reason: str,
        event_id: str | None = None,
    ) -> LLMRecord:
        return self.record(
            call_type=call_type,
            model=model,
            success=True,
            skip_reason=reason,
            event_id=event_id,
        )

    def stats(self, window_sec: float | None = None) -> dict[str, Any]:
        with self._lock:
            records = list(self._records)
            total_calls = self._total_calls
            total_errors = self._total_errors
            total_skips = self._total_skips

        now = time.time()
        if window_sec is not None:
            cutoff = now - window_sec
            records = [r for r in records if r.timestamp >= cutoff]

        if not records:
            return {
                "window_sec": window_sec,
                "total_calls_all_time": total_calls,
                "total_errors_all_time": total_errors,
                "total_skips_all_time": total_skips,
                "window_calls": 0,
                "by_type": {},
                "by_model": {},
                "cost_usd": 0.0,
                "latency_p50_ms": 0.0,
                "latency_p95_ms": 0.0,
                "error_rate": 0.0,
                "skip_rate": 0.0,
            }

        successful = [r for r in records if r.success and not r.skip_reason]
        latencies = [r.latency_ms for r in successful if r.latency_ms > 0]

        by_type: dict[str, dict] = defaultdict(lambda: {
            "calls": 0, "errors": 0, "skips": 0,
            "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
            "latencies_ms": [],
        })
        by_model: dict[str, dict] = defaultdict(lambda: {
            "calls": 0, "input_tokens": 0, "output_tokens": 0, "cost_usd": 0.0,
        })

        total_cost = 0.0
        for r in records:
            ct = by_type[r.call_type]
            ct["calls"] += 1
            if not r.success:
                ct["errors"] += 1
            if r.skip_reason:
                ct["skips"] += 1
            ct["input_tokens"] += r.input_tokens
            ct["output_tokens"] += r.output_tokens
            cost = r.estimated_cost_usd
            ct["cost_usd"] += cost
            if r.success and not r.skip_reason and r.latency_ms > 0:
                ct["latencies_ms"].append(r.latency_ms)

            bm = by_model[r.model]
            bm["calls"] += 1
            bm["input_tokens"] += r.input_tokens
            bm["output_tokens"] += r.output_tokens
            bm["cost_usd"] += cost
            total_cost += cost

        by_type_out = {}
        for k, v in by_type.items():
            lats = v.pop("latencies_ms")
            v["cost_usd"] = round(v["cost_usd"], 6)
            if lats:
                v["latency_p50_ms"] = round(statistics.median(lats), 1)
                v["latency_p95_ms"] = round(
                    sorted(lats)[int(len(lats) * 0.95)], 1
                ) if len(lats) >= 2 else round(lats[0], 1)
            by_type_out[k] = v

        for v in by_model.values():
            v["cost_usd"] = round(v["cost_usd"], 6)

        errors_in_window = sum(1 for r in records if not r.success)
        skips_in_window = sum(1 for r in records if r.skip_reason)

        return {
            "window_sec": window_sec,
            "total_calls_all_time": total_calls,
            "total_errors_all_time": total_errors,
            "total_skips_all_time": total_skips,
            "window_calls": len(records),
            "by_type": by_type_out,
            "by_model": dict(by_model),
            "cost_usd": round(total_cost, 6),
            "latency_p50_ms": round(statistics.median(latencies), 1) if latencies else 0.0,
            "latency_p95_ms": (
                round(sorted(latencies)[int(len(latencies) * 0.95)], 1)
                if len(latencies) >= 2
                else round(latencies[0], 1) if latencies else 0.0
            ),
            "error_rate": round(errors_in_window / len(records), 4) if records else 0.0,
            "skip_rate": round(skips_in_window / len(records), 4) if records else 0.0,
        }

    def recent(self, n: int = 50) -> list[dict]:
        with self._lock:
            tail = self._records[-n:]
        return [
            {
                "call_type": r.call_type,
                "model": r.model,
                "input_tokens": r.input_tokens,
                "output_tokens": r.output_tokens,
                "latency_ms": round(r.latency_ms, 1),
                "success": r.success,
                "error": r.error,
                "event_id": r.event_id,
                "skip_reason": r.skip_reason,
                "cost_usd": round(r.estimated_cost_usd, 6),
                "timestamp": r.timestamp,
            }
            for r in tail
        ]


observer = LLMObserver()
