import { describe, expect, it } from "vitest";

import { classifyApplyError } from "../../frontend/src/features/settings/hooks/useSettingsApply";

describe("classifyApplyError", () => {
  it("classifies 422 payloads as validation errors", () => {
    const exc = {
      status: 422,
      body: {
        errors: [{ key: "ROAD_FPS", reason: "must be positive" }],
      },
    };
    expect(classifyApplyError(exc)).toBe("validation");
  });

  it("classifies privacy-confirm payloads", () => {
    const exc = {
      status: 400,
      body: { error: "privacy_confirm_required" },
    };
    expect(classifyApplyError(exc)).toBe("privacy_confirm");
  });

  it("classifies revision conflicts", () => {
    expect(classifyApplyError({ status: 409, body: {} })).toBe(
      "revision_conflict",
    );
  });

  it("classifies rate limits", () => {
    expect(classifyApplyError({ status: 429, body: {} })).toBe("rate_limited");
  });

  it("falls back to unknown for unrecognized errors", () => {
    expect(classifyApplyError(new Error("boom"))).toBe("unknown");
  });
});
