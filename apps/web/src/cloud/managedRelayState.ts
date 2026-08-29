import { useAtomValue } from "@effect/atom-react";
import {
  createManagedRelayQueryManager,
  configureManagedRelayHostLifecycle,
  deregisterManagedRelayEnvironment,
  ManagedRelay,
  managedRelaySessionAtom,
  readManagedRelaySnapshotState,
  removeManagedRelayHostLifecycle,
  wakeManagedRelayEnvironmentHost,
} from "@t3tools/client-runtime/relay";
import {
  createAtomCommandScheduler,
  createRuntimeCommand,
} from "@t3tools/client-runtime/state/runtime";
import type {
  RelayClientDeviceRecord,
  RelayClientEnvironmentRecord,
  RelayEnvironmentHostStatusResponse,
  RelayEnvironmentHostLifecycleConfigRequest,
} from "@t3tools/contracts/relay";
import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { AsyncResult, Atom } from "effect/unstable/reactivity";
import { useCallback, useEffect } from "react";

import { runtime } from "../lib/runtime";
import { appAtomRegistry } from "../rpc/atomRegistry";

const managedRelayAtomRuntime = Atom.runtime(
  Layer.effect(
    ManagedRelay.ManagedRelayClient,
    runtime.contextEffect.pipe(
      Effect.map((context) => Context.get(context, ManagedRelay.ManagedRelayClient)),
    ),
  ),
);

export const managedRelayQueryManager = createManagedRelayQueryManager(managedRelayAtomRuntime);

const managedRelayMutationScheduler = createAtomCommandScheduler();

export const deregisterManagedRelayEnvironmentCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:deregister-environment",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: { readonly accountId: string; readonly environmentId: EnvironmentId }) =>
        input.accountId,
    },
    execute: (input, registry) => deregisterManagedRelayEnvironment(registry, input),
  },
);

type HostLifecycleMutationInput = {
  readonly accountId: string;
  readonly environmentId: EnvironmentId;
};

export const configureManagedRelayHostLifecycleCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:configure-host-lifecycle",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: HostLifecycleMutationInput) => input.accountId,
    },
    execute: (
      input: HostLifecycleMutationInput & {
        readonly config: RelayEnvironmentHostLifecycleConfigRequest;
      },
      registry,
    ) => configureManagedRelayHostLifecycle(registry, input),
  },
);

export const removeManagedRelayHostLifecycleCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:remove-host-lifecycle",
    scheduler: managedRelayMutationScheduler,
    concurrency: { mode: "serial", key: (input: HostLifecycleMutationInput) => input.accountId },
    execute: (input: HostLifecycleMutationInput, registry) =>
      removeManagedRelayHostLifecycle(registry, input),
  },
);

export const wakeManagedRelayEnvironmentHostCommand = createRuntimeCommand(
  managedRelayAtomRuntime,
  {
    label: "web:managed-relay:wake-host",
    scheduler: managedRelayMutationScheduler,
    concurrency: {
      mode: "serial",
      key: (input: HostLifecycleMutationInput) => input.environmentId,
    },
    execute: (input: HostLifecycleMutationInput, registry) =>
      wakeManagedRelayEnvironmentHost(registry, input),
  },
);

const EMPTY_ENVIRONMENTS_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientEnvironmentRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:environments:null"));

const EMPTY_DEVICES_ATOM = Atom.make(
  AsyncResult.success<ReadonlyArray<RelayClientDeviceRecord>>([]),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:devices:null"));

const EMPTY_HOST_STATUS_ATOM = Atom.make(
  AsyncResult.initial<RelayEnvironmentHostStatusResponse, never>(false),
).pipe(Atom.keepAlive, Atom.withLabel("managed-relay:web:host-status:null"));

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

export function useManagedRelayDevices() {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom = accountId ? managedRelayQueryManager.devicesAtom(accountId) : EMPTY_DEVICES_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  useEffect(() => {
    if (snapshot.error) {
      console.error("[t3-cloud] Relay device listing failed", {
        message: snapshot.error,
        traceId: snapshot.errorTraceId,
      });
    }
  }, [snapshot.error, snapshot.errorTraceId]);
  const refresh = useCallback(() => {
    if (accountId) {
      managedRelayQueryManager.refreshDevices(appAtomRegistry, accountId);
    }
  }, [accountId]);

  return {
    ...snapshot,
    accountId,
    refresh,
  };
}

export function useManagedRelayEnvironmentHostStatus(
  environmentId: EnvironmentId,
  enabled: boolean,
) {
  const session = useAtomValue(managedRelaySessionAtom);
  const accountId = session?.accountId ?? null;
  const atom =
    accountId && enabled
      ? managedRelayQueryManager.environmentHostStatusAtom({ accountId, environmentId })
      : EMPTY_HOST_STATUS_ATOM;
  const result = useAtomValue(atom);
  const snapshot = readManagedRelaySnapshotState(result);
  const refresh = useCallback(() => {
    if (accountId && enabled) {
      managedRelayQueryManager.refreshEnvironmentHostStatus(appAtomRegistry, {
        accountId,
        environmentId,
      });
    }
  }, [accountId, enabled, environmentId]);
  return { ...snapshot, accountId, refresh };
}

export function refreshManagedRelayEnvironments(): void {
  const session = appAtomRegistry.get(managedRelaySessionAtom);
  if (session) {
    managedRelayQueryManager.refreshEnvironments(appAtomRegistry, session.accountId);
  }
}
