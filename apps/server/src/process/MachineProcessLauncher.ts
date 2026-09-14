import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcessSpawner } from "effect/unstable/process";

import { MachineService, MachineServiceError } from "../machine/MachineService.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  ProcessLauncher,
  makeHostProcessLauncher,
  processLaunchLogFields,
  type ProcessLauncherShape,
} from "./ProcessLauncher.ts";

export const makeMachineProcessLauncher = (
  host: ProcessLauncherShape,
  machines: Pick<MachineService["Service"], "exec" | "hostReachableUrl">,
  snapshots: Pick<ProjectionSnapshotQuery["Service"], "getThreadDetailById">,
): ProcessLauncherShape => {
  const resolveBinding = (threadId: Parameters<ProcessLauncherShape["launch"]>[0]["threadId"]) =>
    threadId === undefined
      ? Effect.succeed(undefined)
      : snapshots.getThreadDetailById(threadId).pipe(
          Effect.map((thread) => Option.getOrUndefined(thread)?.machine ?? undefined),
          Effect.mapError(
            (cause) =>
              new MachineServiceError({
                operation: "resolve-provider-machine",
                detail: `Failed to resolve machine binding for thread '${threadId}'.`,
                cause,
              }),
          ),
        );

  return ProcessLauncher.of({
    hostReachableUrl: ({ threadId, url }) =>
      resolveBinding(threadId).pipe(
        Effect.flatMap((binding) =>
          binding === undefined ? Effect.succeed(url) : machines.hostReachableUrl(binding, url),
        ),
      ),
    launch: (input) =>
      resolveBinding(input.threadId).pipe(
        Effect.flatMap((binding) => {
          if (binding === undefined) {
            return host.launch(input);
          }
          return Effect.logDebug("Launching provider child inside thread machine.", {
            ...processLaunchLogFields(input),
            machineName: binding.machineName,
          }).pipe(
            Effect.andThen(
              machines.exec({
                binding,
                command: input.command,
                args: input.args,
                ...(Object.hasOwn(input, "cwd") ? { cwd: input.cwd } : {}),
                ...(Object.hasOwn(input, "env") ? { env: input.env } : {}),
                ...(Object.hasOwn(input, "extendEnv") ? { extendEnv: input.extendEnv } : {}),
                ...(Object.hasOwn(input, "shell") ? { shell: input.shell } : {}),
                ...(Object.hasOwn(input, "detached") ? { detached: input.detached } : {}),
                ...(Object.hasOwn(input, "forceKillAfter")
                  ? { forceKillAfter: input.forceKillAfter }
                  : {}),
              }),
            ),
          );
        }),
      ),
  });
};

export const layer = Layer.effect(
  ProcessLauncher,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const machines = yield* MachineService;
    const snapshots = yield* ProjectionSnapshotQuery;
    return makeMachineProcessLauncher(makeHostProcessLauncher(spawner), machines, snapshots);
  }),
);
