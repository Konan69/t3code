import { describe, expect, it } from "@effect/vitest";

import { normalizeHostLifecycleEndpoint } from "./HostLifecycle.ts";

describe("host lifecycle endpoint validation", () => {
  it("accepts only HTTPS Cloud Run origins", () => {
    expect(normalizeHostLifecycleEndpoint("https://cloudbox-wake-abc123.a.run.app/")).toBe(
      "https://cloudbox-wake-abc123.a.run.app",
    );
    expect(normalizeHostLifecycleEndpoint("http://cloudbox-wake-abc123.a.run.app")).toBeNull();
    expect(normalizeHostLifecycleEndpoint("https://localhost")).toBeNull();
    expect(normalizeHostLifecycleEndpoint("https://127.0.0.1")).toBeNull();
    expect(normalizeHostLifecycleEndpoint("https://example.com")).toBeNull();
    expect(
      normalizeHostLifecycleEndpoint("https://cloudbox-wake-abc123.a.run.app/status"),
    ).toBeNull();
  });
});
