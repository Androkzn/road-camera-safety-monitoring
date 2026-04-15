"""
Optional evaluation: compare detected events against hand-labeled ground truth.

Ground truth format (data/labels.json):
[
  {"timestamp_sec": 12.5, "event_type": "pedestrian_proximity", "tolerance_sec": 1.5},
  ...
]

A detection counts as a true positive if it matches an unclaimed label of the
same event_type within tolerance_sec.

Run after analyze.py:
    python eval.py
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

DATA_DIR = Path(__file__).parent / "data"
DEFAULT_TOLERANCE_SEC = 1.5


def main() -> None:
    events_path = DATA_DIR / "events.json"
    labels_path = DATA_DIR / "labels.json"
    if not events_path.exists():
        sys.exit("Run analyze.py first — events.json missing.")
    if not labels_path.exists():
        sys.exit("Create data/labels.json with ground-truth events to evaluate.")

    events = json.loads(events_path.read_text())
    labels = json.loads(labels_path.read_text())

    matched_labels: set[int] = set()
    tp = 0
    fp = 0

    for ev in events:
        hit = None
        for i, lbl in enumerate(labels):
            if i in matched_labels:
                continue
            if lbl["event_type"] != ev["event_type"]:
                continue
            tol = lbl.get("tolerance_sec", DEFAULT_TOLERANCE_SEC)
            if abs(lbl["timestamp_sec"] - ev["timestamp_sec"]) <= tol:
                hit = i
                break
        if hit is None:
            fp += 1
        else:
            tp += 1
            matched_labels.add(hit)

    fn = len(labels) - len(matched_labels)
    precision = tp / (tp + fp) if (tp + fp) else 0.0
    recall = tp / (tp + fn) if (tp + fn) else 0.0
    f1 = 2 * precision * recall / (precision + recall) if (precision + recall) else 0.0

    report = {
        "true_positives": tp,
        "false_positives": fp,
        "false_negatives": fn,
        "precision": round(precision, 3),
        "recall": round(recall, 3),
        "f1": round(f1, 3),
    }
    (DATA_DIR / "eval.json").write_text(json.dumps(report, indent=2))
    print(json.dumps(report, indent=2))


if __name__ == "__main__":
    main()
