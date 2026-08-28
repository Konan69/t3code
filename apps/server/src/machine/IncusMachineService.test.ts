import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import * as IncusMachineService from "./IncusMachineService.ts";
import { MachineService, type ThreadMachineBinding } from "./MachineService.ts";

function makeHandle(input: {
  readonly code?: number;
  readonly stdout?: string;
  readonly stderr?: string;
}) {
  const bytes = (value: string) => Stream.make(new TextEncoder().encode(value));
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(input.code ?? 0)),
    isRunning: Effect.succeed(false),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: bytes(input.stdout ?? ""),
    stderr: bytes(input.stderr ?? ""),
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

const provideIncus = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  IncusMachineService.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(NodeServices.layer),
  );

describe("IncusMachineService", () => {
  it.effect(
    "creates from golden idempotently, mounts the dataset, starts, and waits for the agent",
    () => {
      const commands: Array<{ command: string; args: ReadonlyArray<string>; stdin?: unknown }> = [];
      let datasetExists = false;
      let machineExists = false;
      let deviceExists = false;
      let running = false;
      let agentAttempts = 0;
      const spawner = ChildProcessSpawner.make((input) => {
        const command = input as unknown as {
          command: string;
          args: ReadonlyArray<string>;
          options: { stdin?: unknown };
        };
        commands.push({
          command: command.command,
          args: command.args,
          stdin: command.options.stdin,
        });
        const args = command.args;
        if (command.command === "zfs" && args[0] === "list") {
          return Effect.succeed(makeHandle({ code: datasetExists ? 0 : 1 }));
        }
        if (command.command === "zfs" && args[0] === "create") {
          datasetExists = true;
          return Effect.succeed(makeHandle({}));
        }
        if (args[0] === "list") {
          return Effect.succeed(
            makeHandle({
              stdout: machineExists
                ? `[{"name":"thread-thread-1","status":"${running ? "Running" : "Stopped"}"}]`
                : "[]",
            }),
          );
        }
        if (args[0] === "copy") {
          machineExists = true;
          return Effect.succeed(makeHandle({}));
        }
        if (args.slice(0, 3).join(" ") === "config device get") {
          return Effect.succeed(makeHandle({ code: deviceExists ? 0 : 1 }));
        }
        if (args.slice(0, 3).join(" ") === "config device add") {
          deviceExists = true;
          return Effect.succeed(makeHandle({}));
        }
        if (args[0] === "start") {
          running = true;
          return Effect.succeed(makeHandle({}));
        }
        if (args[0] === "exec") {
          agentAttempts += 1;
          return Effect.succeed(makeHandle({ code: agentAttempts === 1 ? 1 : 0 }));
        }
        return Effect.succeed(makeHandle({}));
      });

      return Effect.gen(function* () {
        const machines = yield* MachineService;
        const first = yield* machines.createFromGolden(ThreadId.make("thread-1"));
        const second = yield* machines.createFromGolden(ThreadId.make("thread-1"));

        expect(Option.getOrThrow(first)).toEqual({
          machineId: "thread-thread-1",
          machineName: "thread-thread-1",
          state: "running",
          hostWorkspaceRoot: "/tank/threads/thread-1/ws",
          guestWorkspaceRoot: "/home/kixey/ws",
        });
        expect(Option.getOrThrow(second)).toEqual(Option.getOrThrow(first));
        expect(commands.filter((entry) => entry.args[0] === "copy")).toHaveLength(1);
        expect(commands.filter((entry) => entry.args[0] === "start")).toHaveLength(1);
        expect(
          commands.filter((entry) => entry.args.slice(0, 3).join(" ") === "config device add"),
        ).toHaveLength(1);
        expect(commands).toContainEqual({
          command: "incus",
          args: [
            "config",
            "device",
            "add",
            "thread-thread-1",
            "workspace",
            "disk",
            "source=/tank/threads/thread-1/ws",
            "path=/home/kixey/ws",
            "shift=true",
          ],
          stdin: "ignore",
        });
        expect(
          commands
            .filter((entry) => entry.command === "incus")
            .every((entry) => entry.stdin === "ignore"),
        ).toBe(true);
        expect(commands.filter((entry) => entry.args[0] === "exec")).toHaveLength(3);
      }).pipe(Effect.provide(provideIncus(spawner)), TestClock.withLive);
    },
  );

  it.effect("maps cwd and preserves argv while forcing non-piped incus stdin to null", () => {
    let captured: unknown;
    const spawner = ChildProcessSpawner.make((input) => {
      captured = input;
      return Effect.succeed(makeHandle({}));
    });
    const binding = {
      machineId: "thread-thread-1",
      machineName: "thread-thread-1",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/thread-1/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      yield* machines.exec({
        binding,
        command: "codex",
        args: ["app-server", "--flag=value"],
        cwd: "/tank/threads/thread-1/ws/packages/app",
        env: { TOKEN: "secret" },
      });
      expect(captured).toMatchObject({
        command: "incus",
        args: [
          "exec",
          "thread-thread-1",
          "--user",
          "kixey",
          "--cwd",
          "/home/kixey/ws/packages/app",
          "--env",
          "TOKEN=secret",
          "--",
          "codex",
          "app-server",
          "--flag=value",
        ],
        options: { stdin: "ignore" },
      });

      const escaped = yield* machines
        .hostToGuestPath(binding, "/tank/threads/other/ws")
        .pipe(Effect.exit);
      expect(escaped._tag).toBe("Failure");
    }).pipe(Effect.provide(provideIncus(spawner)), Effect.scoped);
  });
});
