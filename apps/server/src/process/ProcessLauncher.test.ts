import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { describe, expect } from "vite-plus/test";

import { makeHostProcessLauncher } from "./ProcessLauncher.ts";

function makeHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

type StandardCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
};

const commandShape = (command: unknown): StandardCommand => {
  const standard = command as StandardCommand;
  return {
    command: standard.command,
    args: standard.args,
    options: standard.options,
  };
};

describe("HostProcessLauncher", () => {
  it.effect("forwards launch options and returns the original host handle", () =>
    Effect.gen(function* () {
      const handle = makeHandle();
      const captured: unknown[] = [];
      const launcher = makeHostProcessLauncher(
        ChildProcessSpawner.make((command) => {
          captured.push(command);
          return Effect.succeed(handle);
        }),
      );
      const input = {
        threadId: ThreadId.make("thread-one"),
        command: "provider",
        args: ["rpc"],
        cwd: "/repo",
        env: { PATH: "/opt/bin" },
        extendEnv: false,
        shell: false,
        forceKillAfter: "2 seconds" as const,
      };
      expect(yield* launcher.launch(input)).toBe(handle);
      expect(captured.map(commandShape)).toEqual([
        commandShape(
          ChildProcess.make("provider", ["rpc"], {
            cwd: "/repo",
            env: { PATH: "/opt/bin" },
            extendEnv: false,
            shell: false,
            forceKillAfter: "2 seconds",
          }),
        ),
      ]);
      expect(captured[0]).not.toHaveProperty("threadId");
    }).pipe(Effect.scoped),
  );
});
