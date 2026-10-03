import { describe, expect, it } from "vite-plus/test";

import {
  applyBoatStatus,
  BOAT_POLL_SETTLED_MS,
  BOAT_POLL_TRANSITIONAL_MS,
  boatActionAvailability,
  boatPollIntervalMs,
  formatMachineSize,
  formatStopsIn,
  INITIAL_BOAT_MODEL,
  LIFETIME_OPTIONS,
} from "./BoatBoxSettings.logic";
import type { DesktopBoatBox, DesktopBoatBoxState } from "@t3tools/contracts";

const NOW = Date.parse("2026-10-03T12:00:00Z");
const at = (offsetMs: number) => new Date(NOW + offsetMs).toISOString();

function box(state: DesktopBoatBoxState, overrides: Partial<DesktopBoatBox> = {}): DesktopBoatBox {
  return {
    id: "b1",
    name: "cloudbox-konan",
    state,
    rawState: state,
    machineType: null,
    vcpu: null,
    memoryGB: null,
    stopsAt: null,
    creditBalanceHours: null,
    ...overrides,
  };
}

describe("boatActionAvailability", () => {
  it("offers Stop and lifetime only while running", () => {
    expect(boatActionAvailability("running", null)).toMatchObject({
      canStart: false,
      canStop: true,
      canSetLifetime: true,
    });
  });

  it("offers Start when stopped or errored", () => {
    for (const state of ["stopped", "error"] as const) {
      expect(boatActionAvailability(state, null)).toMatchObject({
        canStart: true,
        canStop: false,
        canSetLifetime: false,
      });
    }
  });

  it("offers nothing but refresh while starting or stopping", () => {
    for (const state of ["starting", "stopping"] as const) {
      expect(boatActionAvailability(state, null)).toEqual({
        canStart: false,
        canStop: false,
        canSetLifetime: false,
        canRefresh: true,
      });
    }
  });

  it("disables every control while a request is in flight", () => {
    expect(boatActionAvailability("running", "stop")).toEqual({
      canStart: false,
      canStop: false,
      canSetLifetime: false,
      canRefresh: false,
    });
  });
});

describe("formatStopsIn", () => {
  it("reports no auto-stop for null", () => {
    expect(formatStopsIn(null, NOW)).toBe("No auto-stop");
  });

  it("treats now and the past as already stopping", () => {
    expect(formatStopsIn(at(0), NOW)).toBe(formatStopsIn(at(-60_000), NOW));
    expect(formatStopsIn(at(0), NOW)).not.toMatch(/\d/);
  });

  it("collapses under a minute", () => {
    expect(formatStopsIn(at(45_000), NOW)).toBe(formatStopsIn(at(1_000), NOW));
    expect(formatStopsIn(at(45_000), NOW)).not.toMatch(/\d/);
  });

  it("switches from minutes to hours and minutes at the hour boundary", () => {
    expect(formatStopsIn(at(59 * 60_000), NOW)).toContain("59m");
    expect(formatStopsIn(at(59 * 60_000), NOW)).not.toContain("h");
    expect(formatStopsIn(at(60 * 60_000), NOW)).toContain("1h 0m");
    expect(formatStopsIn(at((60 + 42) * 60_000 + 30_000), NOW)).toContain("1h 42m");
  });

  it("includes days past 24 hours", () => {
    expect(formatStopsIn(at(26 * 60 * 60_000), NOW)).toContain("1d 2h");
  });

  it("does not throw on an unparseable timestamp", () => {
    expect(formatStopsIn("not-a-date", NOW)).not.toMatch(/NaN/);
  });
});

describe("boatPollIntervalMs", () => {
  it("polls fast only while the box is moving", () => {
    expect(boatPollIntervalMs({ kind: "box", box: box("starting") })).toBe(
      BOAT_POLL_TRANSITIONAL_MS,
    );
    expect(boatPollIntervalMs({ kind: "box", box: box("stopping") })).toBe(
      BOAT_POLL_TRANSITIONAL_MS,
    );
    for (const state of ["running", "stopped", "error"] as const) {
      expect(boatPollIntervalMs({ kind: "box", box: box(state) })).toBe(BOAT_POLL_SETTLED_MS);
    }
    expect(boatPollIntervalMs({ kind: "loading" })).toBe(BOAT_POLL_SETTLED_MS);
  });
});

describe("applyBoatStatus", () => {
  it("keeps the previous box visible when a request fails", () => {
    const shown = applyBoatStatus(INITIAL_BOAT_MODEL, { _tag: "Box", box: box("running") });
    const failed = applyBoatStatus(shown, { _tag: "RequestFailed", message: "boom" });
    expect(failed.view).toEqual(shown.view);
    expect(failed.error).toBe("boom");
  });

  it("clears the error on the next good result", () => {
    const failed = applyBoatStatus(INITIAL_BOAT_MODEL, { _tag: "RequestFailed", message: "boom" });
    expect(failed.view.kind).toBe("unreachable");
    const ok = applyBoatStatus(failed, { _tag: "Box", box: box("stopped") });
    expect(ok.error).toBeNull();
    expect(ok.view.kind).toBe("box");
  });

  it("replaces the box when the account no longer has it", () => {
    const shown = applyBoatStatus(INITIAL_BOAT_MODEL, { _tag: "Box", box: box("running") });
    expect(applyBoatStatus(shown, { _tag: "NotFound", name: "x" }).view.kind).toBe("notFound");
  });
});

describe("lifetime options and machine size", () => {
  it("offers increasing finite lifetimes then no auto-stop", () => {
    const finite = LIFETIME_OPTIONS.flatMap((option) =>
      option.ttlSeconds === null ? [] : [option.ttlSeconds],
    );
    expect(finite).toEqual([...finite].sort((a, b) => a - b));
    expect(LIFETIME_OPTIONS.at(-1)?.ttlSeconds).toBeNull();
  });

  it("omits what the box did not report", () => {
    expect(formatMachineSize(box("running"))).toBeNull();
    expect(formatMachineSize(box("running", { vcpu: 4 }))).toContain("4");
    expect(formatMachineSize(box("running", { vcpu: 4, memoryGB: 8, machineType: "m" }))).toContain(
      "8",
    );
  });
});
