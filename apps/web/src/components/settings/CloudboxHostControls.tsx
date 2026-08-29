import type { RelayWakePolicy, WakeStatusResult } from "@t3tools/client-runtime/connection";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId } from "@t3tools/contracts";
import { useCallback, useEffect, useRef, useState } from "react";

import { environmentCatalog } from "~/connection/catalog";
import type { EnvironmentPresentation } from "~/state/environments";
import { useAtomCommand } from "../../state/use-atom-command";
import { cn } from "~/lib/utils";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

/** How often the row re-reads host state while the page is visible. */
const HOST_STATUS_POLL_MS = 30_000;
/** After a wake is requested, poll faster until the host reports running. */
const HOST_STATUS_WAKING_POLL_MS = 5_000;
/** Give up on the "Waking…" affordance after this long without a running report. */
const WAKE_PENDING_LIMIT_MS = 90_000;

type HostTone = "asleep" | "waking" | "awake" | "stopped" | "unknown" | "error";

interface HostPresentation {
  readonly tone: HostTone;
  readonly label: string;
  readonly detail: string;
}

export function presentHostStatus(
  status: WakeStatusResult | null,
  wakePending: boolean,
): HostPresentation {
  if (status === null) {
    return wakePending
      ? {
          tone: "waking",
          label: "Waking…",
          detail: "Wake requested; the host resumes in about 20 seconds.",
        }
      : {
          tone: "unknown",
          label: "Checking host…",
          detail: "Reading the host state from the wake service.",
        };
  }
  switch (status._tag) {
    case "Status":
      switch (status.state) {
        case "running":
          return { tone: "awake", label: "Awake", detail: "The host is running." };
        case "resuming":
          return {
            tone: "waking",
            label: "Waking…",
            detail: `The host is resuming (${status.gceStatus}).`,
          };
        case "suspended":
          return wakePending
            ? {
                tone: "waking",
                label: "Waking…",
                detail: "Wake requested; waiting for the host to resume.",
              }
            : {
                tone: "asleep",
                label: "Asleep",
                detail: "The host is suspended. Connect wakes it; it sleeps again when idle.",
              };
        case "stopped":
          return wakePending
            ? {
                tone: "waking",
                label: "Starting…",
                detail: "Start requested; a stopped host takes about a minute.",
              }
            : {
                tone: "stopped",
                label: "Stopped",
                detail:
                  "The host is powered off. Wake starts it; that takes about a minute instead of seconds.",
              };
        case "other":
          return {
            tone: "unknown",
            label: `Host: ${status.gceStatus.toLowerCase()}`,
            detail: "The host is in a transitional state.",
          };
      }
      break;
    case "Unauthorized":
      return {
        tone: "error",
        label: "Wake secret rejected",
        detail: "The wake service refused the stored secret. Edit the wake policy.",
      };
    case "UnexpectedResponse":
      return {
        tone: "error",
        label: `Wake service error (${status.status})`,
        detail: "The wake service answered with an unexpected status.",
      };
    case "TimedOut":
    case "RequestFailed":
      return {
        tone: "unknown",
        label: "Host status unavailable",
        detail: "The wake service did not answer. The host may still be reachable.",
      };
  }
  return { tone: "unknown", label: "Host status unavailable", detail: "" };
}

function toneDotClassName(tone: HostTone): string {
  switch (tone) {
    case "awake":
      return "bg-success";
    case "waking":
      return "bg-warning";
    case "asleep":
      return "bg-muted-foreground/60";
    case "stopped":
    case "error":
      return "bg-destructive";
    case "unknown":
      return "bg-muted-foreground/30";
  }
}

function relayWakePolicy(environment: EnvironmentPresentation): RelayWakePolicy | null {
  const target = environment.entry.target;
  return target._tag === "RelayConnectionTarget" && target.wakePolicy !== undefined
    ? target.wakePolicy
    : null;
}

function isRelayEnvironment(environment: EnvironmentPresentation): boolean {
  return environment.entry.target._tag === "RelayConnectionTarget";
}

function normalizeEndpoint(value: string): string | null {
  const trimmed = value.trim().replace(/\/+$/, "");
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (url.pathname !== "/" && url.pathname !== "") return null;
    return trimmed;
  } catch {
    return null;
  }
}

/**
 * Host state + wake controls for a T3 Connect environment whose backend is a
 * Cloudbox host that suspends itself when idle. Reads state through the wake
 * service's read-only status endpoint; never wakes on its own — waking is
 * always an explicit click, which arms the one-shot wake intent and retries
 * the relay connection.
 */
export function CloudboxHostControls({
  environment,
}: {
  readonly environment: EnvironmentPresentation;
}) {
  const environmentId = environment.environmentId;
  const policy = relayWakePolicy(environment);
  const [dialogOpen, setDialogOpen] = useState(false);

  if (!isRelayEnvironment(environment)) {
    return null;
  }

  return (
    <div className="flex min-h-5 flex-wrap items-center gap-x-3 gap-y-1">
      {policy !== null ? (
        <HostStatusLine
          environmentId={environmentId}
          policyKey={`${policy.endpoint}|${policy.name}`}
        />
      ) : null}
      <button
        type="button"
        className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
        onClick={() => setDialogOpen(true)}
      >
        {policy === null ? "Set up wake-on-connect…" : "Edit wake policy"}
      </button>
      <WakePolicyDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        environmentId={environmentId}
        environmentLabel={environment.label}
        policy={policy}
      />
    </div>
  );
}

function HostStatusLine({
  environmentId,
  policyKey,
}: {
  readonly environmentId: EnvironmentId;
  readonly policyKey: string;
}) {
  const readStatus = useAtomCommand(environmentCatalog.wakeStatus, { reportFailure: false });
  const armWake = useAtomCommand(environmentCatalog.armWake, { reportFailure: false });
  const [status, setStatus] = useState<WakeStatusResult | null>(null);
  const [wakeRequestedAt, setWakeRequestedAt] = useState<number | null>(null);
  const [isRequestingWake, setIsRequestingWake] = useState(false);
  const inFlight = useRef(false);

  const wakePending =
    wakeRequestedAt !== null && Date.now() - wakeRequestedAt < WAKE_PENDING_LIMIT_MS;

  const refresh = useCallback(async () => {
    if (inFlight.current) return;
    inFlight.current = true;
    try {
      const result = await readStatus(environmentId);
      if (result._tag === "Success") {
        const next = result.value as WakeStatusResult | { readonly _tag: "NoPolicy" };
        if (next._tag !== "NoPolicy") {
          setStatus(next);
          if (next._tag === "Status" && next.state === "running") {
            setWakeRequestedAt(null);
          }
        }
      }
    } finally {
      inFlight.current = false;
    }
  }, [environmentId, readStatus]);

  // Poll while visible; faster while a wake is pending. Re-arms when the policy changes.
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const tick = async () => {
      if (cancelled) return;
      if (document.visibilityState === "visible") {
        await refresh();
      }
      if (cancelled) return;
      const pending =
        wakeRequestedAt !== null && Date.now() - wakeRequestedAt < WAKE_PENDING_LIMIT_MS;
      timer = setTimeout(
        () => void tick(),
        pending ? HOST_STATUS_WAKING_POLL_MS : HOST_STATUS_POLL_MS,
      );
    };
    void tick();
    const onVisible = () => {
      if (document.visibilityState === "visible") void refresh();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [refresh, policyKey, wakeRequestedAt]);

  const presentation = presentHostStatus(status, wakePending);
  const canWake =
    !isRequestingWake &&
    !wakePending &&
    (status === null ||
      (status._tag === "Status" &&
        (status.state === "suspended" || status.state === "stopped" || status.state === "other")) ||
      status._tag === "TimedOut" ||
      status._tag === "RequestFailed");

  const requestWake = async () => {
    setIsRequestingWake(true);
    const result = await armWake(environmentId);
    setIsRequestingWake(false);
    if (result._tag === "Success") {
      setWakeRequestedAt(Date.now());
      toastManager.add({
        type: "success",
        title: "Waking host",
        description: "The connection retries as soon as the host is back.",
      });
      window.setTimeout(() => void refresh(), 3_000);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not request wake",
      description: cause instanceof Error ? cause.message : "The wake request was not sent.",
    });
  };

  return (
    <>
      <Tooltip>
        <TooltipTrigger
          render={
            <span className="inline-flex cursor-default items-center gap-1.5 text-xs text-muted-foreground">
              <span
                aria-hidden="true"
                className={cn(
                  "relative inline-flex size-1.5 rounded-full",
                  toneDotClassName(presentation.tone),
                )}
              >
                {presentation.tone === "waking" ? (
                  <span className="absolute inset-0 animate-ping rounded-full bg-warning/60 duration-2000" />
                ) : null}
              </span>
              <span>{presentation.label}</span>
            </span>
          }
        />
        <TooltipPopup side="top" className="max-w-72 whitespace-pre-wrap leading-tight">
          {presentation.detail}
        </TooltipPopup>
      </Tooltip>
      {presentation.tone === "awake" ? null : (
        <Button size="xs" variant="outline" disabled={!canWake} onClick={() => void requestWake()}>
          {isRequestingWake ? "Requesting…" : wakePending ? "Waking…" : "Wake"}
        </Button>
      )}
    </>
  );
}

function WakePolicyDialog({
  open,
  onOpenChange,
  environmentId,
  environmentLabel,
  policy,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly policy: RelayWakePolicy | null;
}) {
  const setWakePolicy = useAtomCommand(environmentCatalog.setWakePolicy, {
    reportFailure: false,
  });
  const [endpoint, setEndpoint] = useState(policy?.endpoint ?? "");
  const [name, setName] = useState(policy?.name ?? "");
  const [secret, setSecret] = useState(policy?.secret ?? "");
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (open) {
      setEndpoint(policy?.endpoint ?? "");
      setName(policy?.name ?? "");
      setSecret(policy?.secret ?? "");
    }
  }, [open, policy]);

  const normalizedEndpoint = normalizeEndpoint(endpoint);
  const endpointInvalid = endpoint.trim().length > 0 && normalizedEndpoint === null;
  const canSave =
    !isSaving && normalizedEndpoint !== null && name.trim().length > 0 && secret.length > 0;

  const finish = (result: Awaited<ReturnType<typeof setWakePolicy>>, savedTitle: string) => {
    if (result._tag === "Success") {
      toastManager.add({ type: "success", title: savedTitle });
      onOpenChange(false);
      return;
    }
    if (isAtomCommandInterrupted(result)) return;
    const cause = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not update wake policy",
      description: cause instanceof Error ? cause.message : "The wake policy was not saved.",
    });
  };

  const save = async () => {
    if (normalizedEndpoint === null) return;
    setIsSaving(true);
    const result = await setWakePolicy({
      environmentId,
      policy: {
        endpoint: normalizedEndpoint,
        name: name.trim(),
        secret,
        mode: "explicit-intent",
      },
    });
    setIsSaving(false);
    finish(result, "Wake policy saved");
  };

  const remove = async () => {
    setIsSaving(true);
    const result = await setWakePolicy({ environmentId, policy: null });
    setIsSaving(false);
    finish(result, "Wake policy removed");
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-md">
        <DialogHeader>
          <DialogTitle>Wake-on-connect for {environmentLabel}</DialogTitle>
          <DialogDescription>
            When this host is asleep, connecting to it sends one wake request to your Cloudbox wake
            service before the relay connection is retried. Background reconnects never wake it.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel className="space-y-4">
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">
              Wake service URL
            </span>
            <Input
              value={endpoint}
              onChange={(event) => setEndpoint(event.target.value)}
              placeholder="https://cloudbox-…-wake.a.run.app"
              disabled={isSaving}
              autoFocus
              spellCheck={false}
              autoComplete="off"
              aria-invalid={endpointInvalid || undefined}
            />
            {endpointInvalid ? (
              <span className="mt-1 block text-xs text-destructive">
                Enter the service origin only — https, no path.
              </span>
            ) : null}
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Cloudbox name</span>
            <Input
              value={name}
              onChange={(event) => setName(event.target.value)}
              placeholder="e.g. test"
              disabled={isSaving}
              spellCheck={false}
              autoComplete="off"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              The <code className="font-mono">name</code> from your cloudbox.json — the wake service
              only answers for that name.
            </span>
          </label>
          <label className="block">
            <span className="mb-1.5 block text-xs font-medium text-foreground">Wake secret</span>
            <Input
              type="password"
              value={secret}
              onChange={(event) => setSecret(event.target.value)}
              placeholder="wakeSecret from the deploy output"
              disabled={isSaving}
              autoComplete="off"
            />
            <span className="mt-1 block text-xs text-muted-foreground">
              Stored only on this device.
            </span>
          </label>
        </DialogPanel>
        <DialogFooter variant="bare">
          {policy !== null ? (
            <Button
              variant="ghost"
              className="mr-auto text-destructive"
              disabled={isSaving}
              onClick={() => void remove()}
            >
              Remove
            </Button>
          ) : null}
          <Button variant="outline" disabled={isSaving} onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button disabled={!canSave} onClick={() => void save()}>
            {isSaving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
