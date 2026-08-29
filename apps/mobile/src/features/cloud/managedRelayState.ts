import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  wakeManagedRelayEnvironmentHost,
} from "@t3tools/client-runtime/relay";
import type {
  RelayClientEnvironmentRecord,
  RelayEnvironmentStatusResponse,
  RelayEnvironmentHostStatusResponse,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { runtimeContextLayer } from "../../lib/runtime";
import { appAtomRegistry } from "../../state/atom-registry";
import { cloudDebugLog } from "./cloudDebugLog";

const managedRelayAtomRuntime = Atom.runtime(runtimeContextLayer);

export const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime, {
  onQueryEvent: (event) =>
    cloudDebugLog(`query:${event.operation}:${event.stage}:${event.phase}`, { ...event }),
});

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environments:null"));

const EMPTY_ENVIRONMENT_STATUS_ATOM = Atom.make(
  AsyncResult.initial<RelayEnvironmentStatusResponse, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environment-status:null"));

const EMPTY_ENVIRONMENT_HOST_STATUS_ATOM = Atom.make(
  AsyncResult.initial<RelayEnvironmentHostStatusResponse, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:mobile:environment-host-status:null"));

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const wakeManagedRelayEnvironmentHostCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "mobile:managed-relay:wake-host",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: { readonly accountId: string; readonly environmentId: EnvironmentId }) =>
        input.environmentId,
    },
    execute: (
      input: { readonly accountId: string; readonly environmentId: EnvironmentId },
      registry,
    ) => wakeManagedRelayEnvironmentHost(registry, input),
  },
);

export function useManagedRelayEnvironments() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentsAtom(accountId)
    : EMPTY_ENVIRONMENTS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay environment listing failed", {
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironments(appAtomRegistry, accountId);
    }
  }, [accountId]);

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

export function useManagedRelayEnvironmentStatus(environment: RelayClientEnvironmentRecord) {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId
    ? managedRelayQueryManager.environmentStatusAtom({ accountId, environment })
    : EMPTY_ENVIRONMENT_STATUS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay environment status failed", {
        environmentId: environment.environmentId,
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [environment.environmentId, snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshEnvironmentStatus(appAtomRegistry, {
        accountId,
        environment,
      });
    }
  }, [accountId, environment]);

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

export function useManagedRelayEnvironmentHostStatus(environment: RelayClientEnvironmentRecord) {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom =
    accountId && environment.hostLifecycle
      ? managedRelayQueryManager.environmentHostStatusAtom({
          accountId,
          environmentId: environment.environmentId,
        })
      : EMPTY_ENVIRONMENT_HOST_STATUS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  const refresh = useCallback(() => {
    if (accountId && environment.hostLifecycle) {
      managedRelayQueryManager.refreshEnvironmentHostStatus(appAtomRegistry, {
        accountId,
        environmentId: environment.environmentId,
      });
    }
  }, [accountId, environment.environmentId, environment.hostLifecycle]);
  return { ...snapshot, accountId, refresh };
}

export function refreshManagedRelayEnvironments(): void {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (session) {
    managedRelayQueryManager.refreshEnvironments(appAtomRegistry, session.accountId);
  }
}
