import { useSyncExternalStore } from "react";

import {
  applyBoatStatus,
  boatPollIntervalMs,
  INITIAL_BOAT_MODEL,
  type BoatAction,
  type BoatModel,
} from "./BoatBoxSettings.logic";
import type { DesktopBoatStatus } from "@t3tools/contracts";

/**
 * Module-level store for the Boat box status. Polling is owned by the
 * subscription (the same shape as `useNowMinute`): the timer exists only while
 * a component is subscribed and the document is visible, so there is no
 * fetch-in-effect in the component and nothing runs once Settings is closed.
 */

let model: BoatModel = INITIAL_BOAT_MODEL;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setTimeout> | null = null;
/** Bumped by every user action; a poll that started before one is stale and dropped. */
let generation = 0;
let backgroundRefreshInFlight = false;

function setModel(next: BoatModel): void {
  model = next;
  for (const listener of listeners) listener();
}

function failure(cause: unknown): DesktopBoatStatus {
  return {
    _tag: "RequestFailed",
    message: cause instanceof Error ? cause.message : "The request to Boat did not complete.",
  };
}

/** Re-arm the next background poll from the current view; no-op when nobody listens or the page is hidden. */
function schedule(): void {
  if (timer !== null) clearTimeout(timer);
  timer = null;
  if (listeners.size === 0 || document.visibilityState !== "visible") return;
  const delay = boatPollIntervalMs(model.view);
  if (delay === null) return;
  timer = setTimeout(() => void refresh("background"), delay);
}

/**
 * Read the status. `manual` shows progress on the Refresh control; `background`
 * is silent and is skipped while another request is already outstanding.
 */
async function refresh(mode: "manual" | "background"): Promise<void> {
  if (window.desktopBridge?.getBoatStatus === undefined) return;
  if (model.pending !== null || backgroundRefreshInFlight) {
    schedule();
    return;
  }
  const startedAt = generation;
  if (mode === "manual") setModel({ ...model, pending: "refresh" });
  else backgroundRefreshInFlight = true;
  // Called on the bridge object so `this` is preserved.
  const result = await window.desktopBridge.getBoatStatus().catch(failure);
  backgroundRefreshInFlight = false;
  if (startedAt === generation) {
    setModel({ ...applyBoatStatus(model, result), pending: null });
  } else if (mode === "manual" && model.pending === "refresh") {
    setModel({ ...model, pending: null });
  }
  schedule();
}

/** Run a start/stop/lifetime call; the result is the fresh status. */
async function act(action: BoatAction, call: () => Promise<DesktopBoatStatus> | undefined) {
  if (model.pending !== null) return;
  const started = call();
  if (started === undefined) return;
  generation += 1;
  setModel({ ...model, pending: action });
  const result = await started.catch(failure);
  generation += 1;
  setModel({ ...applyBoatStatus(model, result), pending: null });
  schedule();
}

export const boatBoxActions = {
  refresh: () => void refresh("manual"),
  start: () => void act("start", () => window.desktopBridge?.resumeBoatBox?.()),
  stop: () => void act("stop", () => window.desktopBridge?.stopBoatBox?.()),
  setLifetime: (ttlSeconds: number | null) =>
    void act("lifetime", () => window.desktopBridge?.setBoatBoxLifetime?.({ ttlSeconds })),
};

function onVisibilityChange(): void {
  if (document.visibilityState === "visible") void refresh("background");
  else schedule();
}

function subscribe(listener: () => void): () => void {
  if (listeners.size === 0) {
    document.addEventListener("visibilitychange", onVisibilityChange);
    // Refresh on mount; a warm module keeps the last model on screen meanwhile.
    void refresh("background");
  }
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
    if (listeners.size === 0) {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      if (timer !== null) clearTimeout(timer);
      timer = null;
    }
  };
}

function getSnapshot(): BoatModel {
  return model;
}

export function useBoatBox(): BoatModel {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
