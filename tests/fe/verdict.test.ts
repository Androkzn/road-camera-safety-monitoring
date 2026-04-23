import { describe, expect, it } from "vitest";

import type {
  SafetyEvent,
  WatchdogFinding,
} from "../../frontend/src/shared/types/common";
import {
  buildDisputesByEventId,
  classifyEvent,
  formatConfidencePct,
  formatObjects,
  parseDispute,
  verdictLabel,
} from "../../frontend/src/features/validation/utils/verdict";

function makeEvent(partial: Partial<SafetyEvent> = {}): SafetyEvent {
  return {
    event_id: "evt-1",
    event_type: "hard_braking",
    risk_level: "high",
    wall_time: "2026-04-20T12:00:00.000Z",
    ...partial,
  };
}

function makeFinding(partial: Partial<WatchdogFinding> = {}): WatchdogFinding {
  return {
    severity: "warning",
    category: "validator",
    title: "validator disagreement",
    detail: "secondary disagreed",
    suggestion: "review clip",
    ts: "2026-04-20T12:00:01.000Z",
    snapshot_id: "snap-1",
    ...partial,
  };
}

describe("verdict utilities", () => {
  it("builds dispute map from primary_event_id evidence", () => {
    const finding = makeFinding({
      evidence: [{ label: "primary_event_id", value: "evt-1" }],
    });
    const map = buildDisputesByEventId([finding]);
    expect(map.get("evt-1")).toBe(finding);
  });

  it("classifies disputed events when a finding exists", () => {
    const event = makeEvent();
    const finding = makeFinding({
      fingerprint: "validator-classification-mismatch",
      evidence: [
        { label: "primary_event_id", value: "evt-1" },
        { label: "primary_label", value: "vehicle_close_interaction" },
        { label: "secondary_label", value: "pedestrian_proximity" },
      ],
    });
    const map = buildDisputesByEventId([finding]);
    const out = classifyEvent(event, map, true, Date.now());
    expect(out.verdict).toBe("disputed");
    expect(out.dispute?.kind).toBe("Class mismatch");
  });

  it("classifies old non-disputed events as verified when validator enabled", () => {
    const event = makeEvent({ wall_time: "2026-04-20T12:00:00.000Z" });
    const now = Date.parse("2026-04-20T12:00:10.000Z");
    const out = classifyEvent(event, new Map(), true, now);
    expect(out.verdict).toBe("verified");
  });

  it("classifies fresh events as pending", () => {
    const event = makeEvent({ wall_time: "2026-04-20T12:00:00.000Z" });
    const now = Date.parse("2026-04-20T12:00:01.000Z");
    const out = classifyEvent(event, new Map(), true, now);
    expect(out.verdict).toBe("pending");
  });

  it("classifies all events as pending when validator disabled", () => {
    const event = makeEvent({ wall_time: "2026-04-20T12:00:00.000Z" });
    const now = Date.parse("2026-04-20T12:00:10.000Z");
    const out = classifyEvent(event, new Map(), false, now);
    expect(out.verdict).toBe("pending");
  });

  it("parses fingerprint kinds and labels consistently", () => {
    const info = parseDispute(
      makeFinding({
        fingerprint: "validator-false-positive",
      }),
    );
    expect(info.kind).toBe("False positive");
    expect(verdictLabel("verified")).toBe("\u2713 Verified");
    expect(verdictLabel("disputed")).toBe("\u26a0 Disputed");
    expect(verdictLabel("pending")).toBe("Pending");
  });

  it("formats object and confidence helpers", () => {
    expect(formatObjects(["car", "pedestrian"])).toBe("car · pedestrian");
    expect(formatConfidencePct(0.736)).toBe("74%");
    expect(formatConfidencePct(undefined)).toBe("—");
  });
});
