import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PlatformError from "effect/PlatformError";
import { ChildProcessSpawner } from "effect/process";

import { MachineService } from "../machine/MachineService.ts";
import { ProjectionStoreV2 } from "../orchestration-v2/ProjectionStore.ts";
import {
  ProcessLauncher,
  makeHostProcessLauncher,
  processLaunchLogFields,
  type ProcessLauncherShape,
} from "./ProcessLauncher.ts";

export const makeMachineProcessLauncher = (
  host: ProcessLauncherShape,
  machines: Pick<MachineService["Service"], "exec" | "hostReachableUrl">,
  snapshots: Pick<ProjectionStoreV2["Service"], "getThread">,
): ProcessLauncherShape => {
  const processError = (error: unknown, method: string) =>
    PlatformError.systemError({
      _tag: "Unknown",
      module: "Process",
      method,
      cause: error,
    });
  const resolveBinding = (threadId: Parameters<ProcessLauncherShape["launch"]>[0]["threadId"]) =>
    threadId === undefined
      ? Effect.succeed(undefined)
      : snapshots.getThread(threadId).pipe(
          Effect.map((thread) => thread.machine ?? undefined),
          Effect.mapError((cause) => processError(cause, "resolveBinding")),
        );

  return ProcessLauncher.of({
    hostReachableUrl: ({ threadId, url }) =>
      resolveBinding(threadId).pipe(
        Effect.flatMap((binding) =>
          binding === undefined
            ? Effect.succeed(url)
            : machines
                .hostReachableUrl(binding, url)
                .pipe(Effect.mapError((error) => processError(error, "hostReachableUrl"))),
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
              machines
                .exec({
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
                  ...(input.stdin === undefined ? {} : { stdin: input.stdin }),
                  ...(input.stdout === undefined ? {} : { stdout: input.stdout }),
                  ...(input.stderr === undefined ? {} : { stderr: input.stderr }),
                })
                .pipe(Effect.mapError((error) => processError(error, "launch"))),
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
    const snapshots = yield* ProjectionStoreV2;
    return makeMachineProcessLauncher(makeHostProcessLauncher(spawner), machines, snapshots);
  }),
);
