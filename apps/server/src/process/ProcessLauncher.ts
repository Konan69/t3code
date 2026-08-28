import type { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type * as PlatformError from "effect/PlatformError";
import type * as Scope from "effect/Scope";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

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

export interface ProcessLauncherShape {
  readonly launch: (
    input: ProcessLaunchInput,
  ) => Effect.Effect<
    ChildProcessSpawner.ChildProcessHandle,
    PlatformError.PlatformError,
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
    launch: (input) =>
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
  });

export const HostProcessLauncherLive = Layer.effect(
  ProcessLauncher,
  Effect.gen(function* () {
    return makeHostProcessLauncher(yield* ChildProcessSpawner.ChildProcessSpawner);
  }),
);
