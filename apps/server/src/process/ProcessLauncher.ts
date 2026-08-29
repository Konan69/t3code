import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import type { MachineServiceError } from "../machine/MachineService.ts";

export interface ProcessLaunchInput {
  readonly threadId?: ThreadId | undefined;
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly extendEnv?: boolean | undefined;
  readonly shell?: boolean | string | undefined;
  readonly detached?: boolean | undefined;
  readonly forceKillAfter?: Duration.Input | undefined;
}

export function processLaunchLogFields(input: ProcessLaunchInput) {
  return {
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    command: input.command,
    args: input.args,
    cwd: input.cwd,
    envKeys: Object.keys(input.env ?? {}).sort(),
  };
}

export interface ProcessLauncherShape {
  readonly resolveSdkExecutable: (input: {
    readonly threadId?: ThreadId | undefined;
    readonly command: string;
  }) => Effect.Effect<string, MachineServiceError>;
  readonly hostReachableUrl?:
    | ((input: {
        readonly threadId?: ThreadId | undefined;
        readonly url: string;
      }) => Effect.Effect<string, MachineServiceError>)
    | undefined;
  readonly launch: (
    input: ProcessLaunchInput,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError | MachineServiceError,
    Scope.Scope
  >;
}

export class ProcessLauncher extends Context.Service<ProcessLauncher, ProcessLauncherShape>()(
  "t3/process/ProcessLauncher",
) {}

export const makeHostProcessLauncher = (
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
): ProcessLauncherShape =>
  ProcessLauncher.of({
    resolveSdkExecutable: (input) => Effect.succeed(input.command),
    hostReachableUrl: (input) => Effect.succeed(input.url),
    launch: (input) =>
      Effect.logDebug("Launching provider child process.", processLaunchLogFields(input)).pipe(
        Effect.andThen(
          spawner.spawn(
            ChildProcess.make(input.command, input.args, {
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
        ),
      ),
  });

export const HostProcessLauncherLive = Layer.effect(
  ProcessLauncher,
  Effect.gen(function* () {
    return makeHostProcessLauncher(yield* ChildProcessSpawner.ChildProcessSpawner);
  }),
);
