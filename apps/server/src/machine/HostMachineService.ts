import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { MachineService, MachineServiceError, type MachineServiceShape } from "./MachineService.ts";

export const layer = Layer.effect(
  MachineService,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const exec: MachineServiceShape["exec"] = (input) =>
      spawner
        .spawn(
          ChildProcess.make(input.command, input.args, {
            ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
            ...(input.env !== undefined ? { env: input.env } : {}),
            ...(input.extendEnv !== undefined ? { extendEnv: input.extendEnv } : {}),
            ...(input.shell !== undefined ? { shell: input.shell } : {}),
            ...(input.detached !== undefined ? { detached: input.detached } : {}),
            ...(input.forceKillAfter !== undefined ? { forceKillAfter: input.forceKillAfter } : {}),
            ...(input.stdin !== undefined ? { stdin: input.stdin } : {}),
            ...(input.stdout !== undefined ? { stdout: input.stdout } : {}),
            ...(input.stderr !== undefined ? { stderr: input.stderr } : {}),
          }),
        )
        .pipe(
          Effect.mapError(
            (cause) =>
              new MachineServiceError({
                operation: "exec",
                detail: `Failed to spawn host process '${input.command}'.`,
                cause,
              }),
          ),
        );

    return MachineService.of({
      ensureWorkspace: () => Effect.succeed(Option.none()),
      createFromGolden: () => Effect.succeed(Option.none()),
      start: () => Effect.void,
      stop: () => Effect.void,
      exec,
      archive: () => Effect.void,
      destroy: () => Effect.void,
      hostToGuestPath: (_binding, hostPath) => Effect.succeed(hostPath),
      guestToHostPath: (_binding, guestPath) => Effect.succeed(guestPath),
      hostReachableUrl: (_binding, url) => Effect.succeed(url),
    });
  }),
);
