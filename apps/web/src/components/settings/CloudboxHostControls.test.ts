import { describe, expect, it } from "@effect/vitest";

import { presentHostStatus } from "./CloudboxHostControls";

describe("presentHostStatus", () => {
  it("shows a checking state before the first read and a waking state while a wake is pending", () => {
    expect(presentHostStatus(null, false)).toMatchObject({
      tone: "unknown",
      label: "Checking host…",
    });
    expect(presentHostStatus(null, true)).toMatchObject({ tone: "waking", label: "Waking…" });
  });

  it("maps host states to tones", () => {
    expect(
      presentHostStatus({ _tag: "Status", state: "running", gceStatus: "RUNNING" }, false),
    ).toMatchObject({ tone: "awake", label: "Awake" });
    expect(
      presentHostStatus({ _tag: "Status", state: "suspended", gceStatus: "SUSPENDED" }, false),
    ).toMatchObject({ tone: "asleep", label: "Asleep" });
    expect(
      presentHostStatus({ _tag: "Status", state: "suspended", gceStatus: "SUSPENDED" }, true),
    ).toMatchObject({ tone: "waking" });
    expect(
      presentHostStatus({ _tag: "Status", state: "resuming", gceStatus: "RESUMING" }, false),
    ).toMatchObject({ tone: "waking", label: "Waking…" });
    expect(
      presentHostStatus({ _tag: "Status", state: "stopped", gceStatus: "TERMINATED" }, false),
    ).toMatchObject({ tone: "stopped", label: "Stopped" });
    expect(
      presentHostStatus({ _tag: "Status", state: "stopped", gceStatus: "TERMINATED" }, true),
    ).toMatchObject({ tone: "waking", label: "Starting…" });
    expect(
      presentHostStatus({ _tag: "Status", state: "other", gceStatus: "SUSPENDING" }, false),
    ).toMatchObject({ tone: "unknown", label: "Host: suspending" });
  });

  it("distinguishes a rejected secret from an unreachable service", () => {
    expect(presentHostStatus({ _tag: "Unauthorized" }, false)).toMatchObject({
      tone: "error",
      label: "Wake secret rejected",
    });
    expect(presentHostStatus({ _tag: "UnexpectedResponse", status: 503 }, false)).toMatchObject({
      tone: "error",
      label: "Wake service error (503)",
    });
    expect(presentHostStatus({ _tag: "TimedOut" }, false)).toMatchObject({ tone: "unknown" });
    expect(presentHostStatus({ _tag: "RequestFailed" }, true)).toMatchObject({ tone: "unknown" });
  });
});
