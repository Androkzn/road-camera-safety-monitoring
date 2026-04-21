"""drift.py — model-quality monitor and active-learning sample collector.

What it does:
    Two jobs bundled together because they share the same "the model
    might be getting worse" signal.

    1. ``DriftMonitor`` — reads operator feedback (thumbs up / thumbs
       down on each alert) and the recent event log, then computes
       rolling precision: "of the last N alerts the operator judged,
       how many were actually real?". Slices that number by risk level
       and event type so you can tell whether degradation is global or
       confined to one category.

    2. ``ActiveLearningSampler`` — spots events the model was unsure
       about (confidence near the 0.5 decision boundary) and events the
       operator marked as false positives, then saves a copy for
       relabelling in Label Studio / CVAT. These are the highest-value
       examples for retraining.

Purpose:
    Detection models silently drift as cameras move, lighting changes, or
    new vehicle types appear. This module is how the system notices that
    early — falling precision triggers an alert, and the relabel queue
    feeds the next model update.

How it works:
    * ``@dataclass`` on ``DriftReport`` and ``ActiveLearningSample``
      generates typed records with an auto ``__init__``.
    * ``field(default_factory=...)`` gives each instance its own fresh
      list/dict instead of sharing one across instances.
    * ``_read_jsonl`` tolerates corrupt lines — this runs behind a
      dashboard endpoint, so ``compute()`` must never crash; on any
      failure it returns an empty report.
    * Precision buckets with fewer than 3 labels are reported as
      "insufficient" rather than a misleading 1/1 = 100%.
    * Trend compares the current window against the previous
      non-overlapping window using a +/- 0.05 band.
    * The sampler writes copies of the INTERNAL (unredacted) thumbnail
      — labelling needs full fidelity and the export is an internal
      artifact.
    * Tunables: ``PRECISION_ALERT_THRESHOLD`` (0.70),
      ``DECISION_BOUNDARY_LOW/HIGH`` (0.35–0.50),
      ``MIN_BUCKET_LABELS`` (3), ``TREND_DELTA`` (0.05).

Connects to:
    - Backend: ``road_safety/server.py`` constructs a ``DriftMonitor``
      and an ``ActiveLearningSampler``; exposes ``/api/drift`` and
      ``/api/active_learning/export``. ``drift_warning_message`` is
      used by Slack integration and by watchdog rule checks.
    - UI: ``frontend/src/lib/api.ts`` calls ``/api/drift`` via
      ``getDrift``; consumed by ``frontend/src/hooks/useDrift.ts`` and
      rendered in ``frontend/src/pages/DashboardPage.tsx`` and
      ``MonitoringPage.tsx``.
"""

from __future__ import annotations

import json
import random
import shutil
import tempfile
import zipfile
from collections import defaultdict
from dataclasses import asdict, dataclass, field
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable

PRECISION_ALERT_THRESHOLD = 0.70
DECISION_BOUNDARY_LOW = 0.35
DECISION_BOUNDARY_HIGH = 0.50
DECISION_BOUNDARY_SAMPLE_PROB = 0.5
MIN_BUCKET_LABELS = 3
TREND_DELTA = 0.05


# ---------------------------------------------------------------------------
# DriftMonitor
# ---------------------------------------------------------------------------

@dataclass
class DriftReport:
    window_size: int
    true_positives: int
    false_positives: int
    precision: float
    by_risk_level: dict
    by_event_type: dict
    window_start_ts: str
    window_end_ts: str
    alert_triggered: bool
    trend: str  # "improving" | "stable" | "degrading"
    # Feedback coverage: what fraction of recent events received any operator
    # verdict at all. Low coverage means the precision number above is from a
    # biased sample — operators label the alerts that bothered them and ignore
    # the rest. A precision of 0.9 from 10% coverage is not the same signal as
    # 0.9 from 60% coverage. Consumers should surface both numbers, not just
    # precision.
    feedback_coverage: float = 0.0
    labeled_events: int = 0
    total_events_in_window: int = 0

    def as_dict(self) -> dict:
        """FastAPI-friendly JSON-serialisable representation."""
        return {
            "window_size": self.window_size,
            "true_positives": self.true_positives,
            "false_positives": self.false_positives,
            "precision": self.precision,
            "by_risk_level": self.by_risk_level,
            "by_event_type": self.by_event_type,
            "window_start_ts": self.window_start_ts,
            "window_end_ts": self.window_end_ts,
            "alert_triggered": self.alert_triggered,
            "trend": self.trend,
            "feedback_coverage": self.feedback_coverage,
            "labeled_events": self.labeled_events,
            "total_events_in_window": self.total_events_in_window,
        }


def _empty_report() -> DriftReport:
    return DriftReport(
        window_size=0,
        true_positives=0,
        false_positives=0,
        precision=0.0,
        by_risk_level={},
        by_event_type={},
        window_start_ts="",
        window_end_ts="",
        alert_triggered=False,
        trend="stable",
    )


def _read_jsonl(path: Path) -> list[dict]:
    if not path.exists():
        return []
    out: list[dict] = []
    try:
        with path.open("r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    out.append(json.loads(line))
                except json.JSONDecodeError:
                    # Corrupt line — skip rather than fail the whole report.
                    continue
    except OSError:
        return []
    return out


def _read_events_json(path: Path) -> list[dict]:
    if not path.exists():
        return []
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return []
    if isinstance(data, list):
        return [e for e in data if isinstance(e, dict)]
    if isinstance(data, dict) and isinstance(data.get("events"), list):
        return [e for e in data["events"] if isinstance(e, dict)]
    return []


def _precision(tp: int, fp: int) -> float:
    total = tp + fp
    if total == 0:
        return 0.0
    return round(tp / total, 4)


def _bucket_stats(
    labels: Iterable[tuple[str, str]],
) -> dict[str, dict[str, Any]]:
    """labels: iterable of (bucket_key, verdict)."""
    counts: dict[str, dict[str, int]] = defaultdict(lambda: {"tp": 0, "fp": 0})
    for key, verdict in labels:
        if not key:
            continue
        if verdict == "tp":
            counts[key]["tp"] += 1
        elif verdict == "fp":
            counts[key]["fp"] += 1
    out: dict[str, dict[str, Any]] = {}
    for key, c in counts.items():
        total = c["tp"] + c["fp"]
        if total < MIN_BUCKET_LABELS:
            out[key] = {"tp": c["tp"], "fp": c["fp"], "precision": None, "status": "insufficient"}
        else:
            out[key] = {
                "tp": c["tp"],
                "fp": c["fp"],
                "precision": _precision(c["tp"], c["fp"]),
                "status": "ok",
            }
    return out


class DriftMonitor:
    def __init__(
        self,
        feedback_path: Path = Path("data/feedback.jsonl"),
        events_path: Path = Path("data/events.json"),
        window_size: int = 50,
        alert_threshold: float = PRECISION_ALERT_THRESHOLD,
    ):
        self.feedback_path = Path(feedback_path)
        self.events_path = Path(events_path)
        self.window_size = int(window_size)
        self.alert_threshold = float(alert_threshold)
        self._event_source: Callable[[], list[dict]] | None = None

    def set_event_source(self, events_getter: Callable[[], list[dict]]) -> None:
        """Register a callable returning recent in-memory events.

        Preferred over re-reading events.json on every compute() call — the
        server keeps a deque of recent events that is cheaper and fresher
        than the on-disk copy.
        """
        self._event_source = events_getter

    # -- internal ----------------------------------------------------------

    def _load_events_index(self) -> dict[str, dict]:
        """Merge in-memory + on-disk events into a single {event_id: event} map.

        In-memory takes precedence — it's the fresher copy.
        """
        index: dict[str, dict] = {}
        for evt in _read_events_json(self.events_path):
            eid = evt.get("event_id")
            if eid:
                index[eid] = evt
        if self._event_source is not None:
            try:
                live = self._event_source() or []
            except Exception:
                live = []
            for evt in live:
                if isinstance(evt, dict):
                    eid = evt.get("event_id")
                    if eid:
                        index[eid] = evt
        return index

    def _window(self, feedback: list[dict], offset: int = 0) -> list[dict]:
        """Return `window_size` labels ending `offset` positions from the end."""
        if not feedback:
            return []
        end = len(feedback) - offset
        start = max(0, end - self.window_size)
        if end <= 0 or start >= end:
            return []
        return feedback[start:end]

    def _precision_of(self, feedback_window: list[dict]) -> float:
        tp = sum(1 for f in feedback_window if f.get("verdict") == "tp")
        fp = sum(1 for f in feedback_window if f.get("verdict") == "fp")
        return _precision(tp, fp)

    def _trend(self, current_precision: float, feedback: list[dict]) -> str:
        prior = self._window(feedback, offset=self.window_size)
        if len(prior) < MIN_BUCKET_LABELS:
            return "stable"
        prior_precision = self._precision_of(prior)
        delta = current_precision - prior_precision
        if delta >= TREND_DELTA:
            return "improving"
        if delta <= -TREND_DELTA:
            return "degrading"
        return "stable"

    # -- public ------------------------------------------------------------

    def compute(self) -> DriftReport:
        try:
            feedback = _read_jsonl(self.feedback_path)
            if not feedback:
                return _empty_report()

            window = self._window(feedback)
            if not window:
                return _empty_report()

            events_index = self._load_events_index()

            tp = 0
            fp = 0
            risk_labels: list[tuple[str, str]] = []
            type_labels: list[tuple[str, str]] = []

            for fb in window:
                verdict = fb.get("verdict")
                if verdict not in ("tp", "fp"):
                    continue
                if verdict == "tp":
                    tp += 1
                else:
                    fp += 1
                evt = events_index.get(fb.get("event_id"), {})
                risk = evt.get("risk_level") or "unknown"
                etype = evt.get("event_type") or "unknown"
                risk_labels.append((risk, verdict))
                type_labels.append((etype, verdict))

            precision = _precision(tp, fp)
            by_risk = _bucket_stats(risk_labels)
            by_type = _bucket_stats(type_labels)

            # Window timestamps — first/last operator_ts we actually saw.
            timestamps = [fb.get("operator_ts") for fb in window if fb.get("operator_ts")]
            window_start = timestamps[0] if timestamps else ""
            window_end = timestamps[-1] if timestamps else ""

            alert = (tp + fp) >= MIN_BUCKET_LABELS and precision < self.alert_threshold
            trend = self._trend(precision, feedback)

            # Feedback coverage: compare labeled events against total events
            # in the same window. Guards against the "high precision from
            # biased sample" trap — if operators only label 5% of events,
            # the 95% they ignore could be silently drifting and precision
            # wouldn't move.
            labeled_ids = {fb.get("event_id") for fb in window if fb.get("event_id")}
            all_events = list(events_index.values())
            total_in_window = len(all_events)
            if total_in_window > 0:
                labeled_in_window = sum(
                    1 for e in all_events if e.get("event_id") in labeled_ids
                )
                coverage = round(labeled_in_window / total_in_window, 4)
            else:
                labeled_in_window = 0
                coverage = 0.0

            return DriftReport(
                window_size=tp + fp,
                true_positives=tp,
                false_positives=fp,
                precision=precision,
                by_risk_level=by_risk,
                by_event_type=by_type,
                window_start_ts=window_start,
                window_end_ts=window_end,
                alert_triggered=alert,
                trend=trend,
                feedback_coverage=coverage,
                labeled_events=labeled_in_window,
                total_events_in_window=total_in_window,
            )
        except Exception:
            # Hard belt-and-braces: this runs behind a dashboard endpoint.
            return _empty_report()


def drift_warning_message(report: DriftReport) -> str | None:
    """Slack-ready warning string, or None if no alert.

    Identifies the worst event_type bucket (lowest precision with enough
    labels) so the on-call engineer knows where to look first.
    """
    if not report.alert_triggered:
        return None

    worst_type = None
    worst_precision = None
    for etype, stats in (report.by_event_type or {}).items():
        p = stats.get("precision")
        if p is None:
            continue
        if worst_precision is None or p < worst_precision:
            worst_precision = p
            worst_type = etype

    base = (
        f"Precision dropped to {report.precision:.2f} over last "
        f"{report.window_size} labels (threshold "
        f"{PRECISION_ALERT_THRESHOLD:.2f})."
    )
    if worst_type is not None and worst_precision is not None:
        base += (
            f" Event type '{worst_type}' driving the degradation "
            f"({worst_precision:.2f})."
        )
    return base


# ---------------------------------------------------------------------------
# ActiveLearningSampler
# ---------------------------------------------------------------------------

@dataclass
class ActiveLearningSample:
    event_id: str
    reason: str  # "decision_boundary" | "disputed"
    confidence: float
    risk_level: str
    thumbnail_internal: str
    event_json: dict


class ActiveLearningSampler:
    """Collects ambiguous + disputed events for re-labeling.

    Samples are held on disk in ``out_dir/pending/<event_id>.json`` plus a
    copy of the internal thumbnail. ``export_batch()`` zips the pending dir
    into a single artifact ready for upload to Label Studio / CVAT and
    clears the pending queue.
    """

    def __init__(self, out_dir: Path = Path("data/active_learning")):
        self.out_dir = Path(out_dir)
        self.pending_dir = self.out_dir / "pending"
        self.thumbs_dir = Path("data/thumbnails")
        self._rng = random.Random()
        try:
            self.pending_dir.mkdir(parents=True, exist_ok=True)
        except OSError:
            # Non-fatal — maybe_sample / sample_disputed will retry.
            pass

    # -- internal ----------------------------------------------------------

    def _internal_thumb_path(self, event_id: str) -> Path:
        return self.thumbs_dir / f"{event_id}.jpg"

    def _persist(self, sample: ActiveLearningSample) -> None:
        try:
            self.pending_dir.mkdir(parents=True, exist_ok=True)
            record = {
                "event_id": sample.event_id,
                "reason": sample.reason,
                "confidence": sample.confidence,
                "risk_level": sample.risk_level,
                "thumbnail_internal": sample.thumbnail_internal,
                "event_json": sample.event_json,
                "sampled_at": datetime.now(timezone.utc)
                .isoformat(timespec="seconds")
                .replace("+00:00", "Z"),
            }
            (self.pending_dir / f"{sample.event_id}.json").write_text(
                json.dumps(record, indent=2), encoding="utf-8"
            )
        except OSError:
            # Disk full / permissions — skip silently, this is a side channel.
            pass

    def _build_sample(
        self, event: dict, reason: str, note: str | None = None
    ) -> ActiveLearningSample:
        event_id = event.get("event_id", "")
        confidence = float(event.get("confidence", 0.0) or 0.0)
        risk_level = event.get("risk_level", "unknown") or "unknown"
        thumb_path = self._internal_thumb_path(event_id)
        event_copy = dict(event)
        if note:
            event_copy["_feedback_note"] = note
        return ActiveLearningSample(
            event_id=event_id,
            reason=reason,
            confidence=confidence,
            risk_level=risk_level,
            thumbnail_internal=str(thumb_path),
            event_json=event_copy,
        )

    # -- public ------------------------------------------------------------

    def maybe_sample(self, event: dict) -> ActiveLearningSample | None:
        """Decision-boundary sampling at event emission time."""
        try:
            conf = float(event.get("confidence", 0.0) or 0.0)
        except (TypeError, ValueError):
            return None
        if not (DECISION_BOUNDARY_LOW <= conf <= DECISION_BOUNDARY_HIGH):
            return None
        if self._rng.random() >= DECISION_BOUNDARY_SAMPLE_PROB:
            return None
        sample = self._build_sample(event, reason="decision_boundary")
        self._persist(sample)
        return sample

    def sample_disputed(
        self, event: dict, note: str | None = None
    ) -> ActiveLearningSample:
        """Always-sample path, called when an operator marks verdict=fp."""
        sample = self._build_sample(event, reason="disputed", note=note)
        self._persist(sample)
        return sample

    def export_batch(self) -> Path | None:
        """Zip the pending directory for handoff to a labeling tool.

        Returns the zip path, or None if there is nothing to export.
        The pending directory is cleared on successful export.
        """
        try:
            if not self.pending_dir.exists():
                return None
            records = sorted(self.pending_dir.glob("*.json"))
            if not records:
                return None

            ts = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
            out_path = self.out_dir / f"active_learning_{ts}.zip"
            out_path.parent.mkdir(parents=True, exist_ok=True)

            manifest: list[dict] = []
            with tempfile.TemporaryDirectory() as staging:
                staging_path = Path(staging)
                for rec_path in records:
                    try:
                        rec = json.loads(rec_path.read_text(encoding="utf-8"))
                    except (OSError, json.JSONDecodeError):
                        continue
                    event_id = rec.get("event_id", rec_path.stem)
                    thumb_src = Path(rec.get("thumbnail_internal", ""))
                    thumb_arcname = f"thumbnails/{event_id}.jpg"
                    thumb_ok = False
                    if thumb_src.exists() and thumb_src.is_file():
                        try:
                            shutil.copy2(thumb_src, staging_path / f"{event_id}.jpg")
                            thumb_ok = True
                        except OSError:
                            thumb_ok = False
                    manifest.append({
                        "event_id": event_id,
                        "reason": rec.get("reason"),
                        "confidence": rec.get("confidence"),
                        "risk_level": rec.get("risk_level"),
                        "sampled_at": rec.get("sampled_at"),
                        "thumbnail": thumb_arcname if thumb_ok else None,
                        "event_json": rec.get("event_json", {}),
                    })

                manifest_path = staging_path / "manifest.json"
                manifest_path.write_text(
                    json.dumps({"count": len(manifest), "items": manifest}, indent=2),
                    encoding="utf-8",
                )

                with zipfile.ZipFile(out_path, "w", zipfile.ZIP_DEFLATED) as zf:
                    zf.write(manifest_path, "manifest.json")
                    for item in manifest:
                        if item["thumbnail"] is None:
                            continue
                        src = staging_path / f"{item['event_id']}.jpg"
                        if src.exists():
                            zf.write(src, item["thumbnail"])

            # Clear pending on success.
            for rec_path in records:
                try:
                    rec_path.unlink()
                except OSError:
                    pass
            return out_path
        except Exception:
            return None
