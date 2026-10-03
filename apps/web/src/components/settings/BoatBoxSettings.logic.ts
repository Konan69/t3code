import type { DesktopBoatBox, DesktopBoatBoxState, DesktopBoatStatus } from "@t3tools/contracts";

/** Slow refresh while the box is steady; the settings page is visible. */
export const BOAT_POLL_SETTLED_MS = 30_000;
/** Fast refresh only while the box is moving between states. */
export const BOAT_POLL_TRANSITIONAL_MS = 4_000;

export type BoatAction = "start" | "stop" | "lifetime" | "refresh";

/** What the section currently knows, independent of any in-flight request. */
export type BoatView =
  | { readonly kind: "loading" }
  | { readonly kind: "notConfigured"; readonly missing: ReadonlyArray<string> }
  | { readonly kind: "notFound"; readonly name: string }
  | { readonly kind: "box"; readonly box: DesktopBoatBox }
  | { readonly kind: "unreachable" };

export interface BoatModel {
  readonly view: BoatView;
  /** Last request failure message; cleared by the next successful result. */
  readonly error: string | null;
  /** The user-initiated action currently awaiting a result, if any. */
  readonly pending: BoatAction | null;
}

export const INITIAL_BOAT_MODEL: BoatModel = {
  view: { kind: "loading" },
  error: null,
  pending: null,
};

/**
 * Fold a bridge result into the model. A `RequestFailed` keeps whatever box was
 * already on screen (so an action failure never blanks the section) and only
 * records the message; every other result replaces the view.
 */
export function applyBoatStatus(model: BoatModel, status: DesktopBoatStatus): BoatModel {
  switch (status._tag) {
    case "Box":
      return { view: { kind: "box", box: status.box }, error: null, pending: model.pending };
    case "NotConfigured":
      return {
        view: { kind: "notConfigured", missing: status.missing },
        error: null,
        pending: model.pending,
      };
    case "NotFound":
      return { view: { kind: "notFound", name: status.name }, error: null, pending: model.pending };
    case "RequestFailed":
      return {
        view: model.view.kind === "loading" ? { kind: "unreachable" } : model.view,
        error: status.message,
        pending: model.pending,
      };
  }
}

export type BoatTone = "success" | "warning" | "error" | "neutral";

export function boatStateTone(state: DesktopBoatBoxState): { label: string; tone: BoatTone } {
  switch (state) {
    case "running":
      return { label: "Running", tone: "success" };
    case "starting":
      return { label: "Starting", tone: "warning" };
    case "stopping":
      return { label: "Stopping", tone: "warning" };
    case "stopped":
      return { label: "Stopped", tone: "neutral" };
    case "error":
      return { label: "Error", tone: "error" };
  }
}

export function isTransitional(state: DesktopBoatBoxState): boolean {
  return state === "starting" || state === "stopping";
}

export interface BoatActionAvailability {
  readonly canStart: boolean;
  readonly canStop: boolean;
  readonly canSetLifetime: boolean;
  readonly canRefresh: boolean;
}

/**
 * Which controls are live. While any request is in flight everything else is
 * disabled; a transitional box accepts nothing but a refresh.
 */
export function boatActionAvailability(
  state: DesktopBoatBoxState,
  pending: BoatAction | null,
): BoatActionAvailability {
  const idle = pending === null;
  return {
    canStart: idle && (state === "stopped" || state === "error"),
    canStop: idle && state === "running",
    canSetLifetime: idle && state === "running",
    canRefresh: idle,
  };
}

/** Poll cadence for the current view; `null` means nothing to poll. */
export function boatPollIntervalMs(view: BoatView): number | null {
  switch (view.kind) {
    case "box":
      return isTransitional(view.box.state) ? BOAT_POLL_TRANSITIONAL_MS : BOAT_POLL_SETTLED_MS;
    case "loading":
    case "notConfigured":
    case "notFound":
    case "unreachable":
      return BOAT_POLL_SETTLED_MS;
  }
}

/**
 * Relative auto-stop text. Minute precision above one minute, so a
 * minute-quantized clock keeps it current without per-second renders.
 */
export function formatStopsIn(stopsAt: string | null, nowMs: number): string {
  if (stopsAt === null) return "No auto-stop";
  const stopsAtMs = Date.parse(stopsAt);
  if (Number.isNaN(stopsAtMs)) return "Stop time unknown";
  const remainingMs = stopsAtMs - nowMs;
  if (remainingMs <= 0) return "Stopping now";
  const totalMinutes = Math.floor(remainingMs / 60_000);
  if (totalMinutes < 1) return "Stops in under a minute";
  const days = Math.floor(totalMinutes / 1_440);
  const hours = Math.floor((totalMinutes % 1_440) / 60);
  const minutes = totalMinutes % 60;
  if (days > 0) return `Stops in ${days}d ${hours}h`;
  if (hours > 0) return `Stops in ${hours}h ${minutes}m`;
  return `Stops in ${minutes}m`;
}

export interface LifetimeOption {
  readonly label: string;
  /** Seconds to keep the box on; null removes the auto-stop. */
  readonly ttlSeconds: number | null;
}

export const LIFETIME_OPTIONS: ReadonlyArray<LifetimeOption> = [
  { label: "1 hour", ttlSeconds: 3_600 },
  { label: "2 hours", ttlSeconds: 7_200 },
  { label: "4 hours", ttlSeconds: 14_400 },
  { label: "8 hours", ttlSeconds: 28_800 },
  { label: "No auto-stop", ttlSeconds: null },
];

/** "4 vCPU · 8 GB · standard-4", skipping whatever the box did not report. */
export function formatMachineSize(box: DesktopBoatBox): string | null {
  const parts = [
    box.vcpu === null ? null : `${box.vcpu} vCPU`,
    box.memoryGB === null ? null : `${box.memoryGB} GB`,
    box.machineType,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? null : parts.join(" · ");
}

export function formatCredit(hours: number | null): string | null {
  if (hours === null) return null;
  const rounded = Math.round(hours * 10) / 10;
  return `${rounded} ${rounded === 1 ? "hour" : "hours"} of credit left`;
}
