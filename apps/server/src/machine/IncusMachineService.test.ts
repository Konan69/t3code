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
  Layer.effect(MachineService, IncusMachineService.make(1000)).pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
    Layer.provide(NodeServices.layer),
  );

describe("IncusMachineService", () => {
  it("builds explicit root and non-root ZFS command specifications", () => {
    expect(IncusMachineService.zfsCommand(["list", "tank/threads"], 0)).toEqual({
      command: "zfs",
      args: ["list", "tank/threads"],
    });
    expect(IncusMachineService.zfsCommand(["list", "tank/threads"], 1000)).toEqual({
      command: "sudo",
      args: ["-n", "zfs", "list", "tank/threads"],
    });
  });

  it.effect("surfaces sudo failures without retrying plain zfs", () => {
    const commands: Array<{ command: string; args: ReadonlyArray<string> }> = [];
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as { command: string; args: ReadonlyArray<string> };
      commands.push({ command: command.command, args: command.args });
      return Effect.succeed(makeHandle({ code: 1, stderr: "sudo: a password is required" }));
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.ensureWorkspace(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("dataset.inspect");
      expect(error.detail).toContain("sudo -n zfs list");
      expect(commands).toEqual([
        {
          command: "sudo",
          args: ["-n", "zfs", "list", "-H", "-o", "name", "tank/threads/thread-1/ws"],
        },
      ]);
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect("rejects a dataset mounted somewhere other than its workspace path", () => {
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as { args: ReadonlyArray<string> };
      const zfsArgs = command.args.slice(2);
      return Effect.succeed(
        zfsArgs[0] === "get" ? makeHandle({ stdout: "/wrong/path\n" }) : makeHandle({}),
      );
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const error = yield* machines.ensureWorkspace(ThreadId.make("thread-1")).pipe(Effect.flip);

      expect(error.operation).toBe("dataset.mountpoint");
      expect(error.detail).toContain("expected '/tank/threads/thread-1/ws'");
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

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
        const zfsArgs =
          command.command === "sudo" && args[0] === "-n" && args[1] === "zfs"
            ? args.slice(2)
            : undefined;
        if (zfsArgs?.[0] === "list") {
          return Effect.succeed(
            makeHandle({
              code: datasetExists ? 0 : 1,
              stderr: datasetExists ? "" : "cannot open dataset: dataset does not exist",
            }),
          );
        }
        if (zfsArgs?.[0] === "create") {
          datasetExists = true;
          return Effect.succeed(makeHandle({}));
        }
        if (zfsArgs?.[0] === "get") {
          return Effect.succeed(makeHandle({ stdout: "/tank/threads/thread-1/ws\n" }));
        }
        if (args.slice(0, 2).join(" ") === "image list") {
          return Effect.succeed(makeHandle({ stdout: '[{"type":"container"}]' }));
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
        if (args[0] === "init") {
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
        yield* machines.ensureWorkspace(ThreadId.make("thread-1"));
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
        expect(commands.filter((entry) => entry.args[0] === "copy")).toHaveLength(0);
        expect(commands.filter((entry) => entry.args[0] === "init")).toHaveLength(1);
        expect(commands).toContainEqual({
          command: "incus",
          args: ["init", "golden", "thread-thread-1", "-c", "security.nesting=true"],
          stdin: "ignore",
        });
        expect(commands.filter((entry) => entry.args[0] === "start")).toHaveLength(1);
        expect(commands).toContainEqual({
          command: "sudo",
          args: [
            "-n",
            "zfs",
            "create",
            "-p",
            "-o",
            "mountpoint=/tank/threads/thread-1/ws",
            "tank/threads/thread-1/ws",
          ],
          stdin: "ignore",
        });
        expect(commands).toContainEqual({
          command: "sudo",
          args: ["-n", "zfs", "get", "-H", "-o", "value", "mountpoint", "tank/threads/thread-1/ws"],
          stdin: "ignore",
        });
        expect(commands).toContainEqual({
          command: "sudo",
          args: ["-n", "chown", "1000:1000", "/tank/threads/thread-1/ws"],
          stdin: "ignore",
        });
        expect(commands.some((entry) => entry.command === "zfs")).toBe(false);
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

  it.effect("initializes VM images with --vm and destroys the instance before its dataset", () => {
    const commands: Array<{ command: string; args: ReadonlyArray<string>; stdin?: unknown }> = [];
    let machineExists = false;
    let running = false;
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as {
        command: string;
        args: ReadonlyArray<string>;
        options: { stdin?: unknown };
      };
      commands.push({ command: command.command, args: command.args, stdin: command.options.stdin });
      const args = command.args;
      const zfsArgs =
        command.command === "sudo" && args[0] === "-n" && args[1] === "zfs"
          ? args.slice(2)
          : undefined;
      if (zfsArgs?.[0] === "list" || zfsArgs?.[0] === "destroy") {
        return Effect.succeed(makeHandle({}));
      }
      if (zfsArgs?.[0] === "get") {
        return Effect.succeed(makeHandle({ stdout: "/tank/threads/thread-1/ws\n" }));
      }
      if (args.slice(0, 2).join(" ") === "image list") {
        return Effect.succeed(makeHandle({ stdout: '[{"type":"virtual-machine"}]' }));
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
      if (args[0] === "init") {
        machineExists = true;
        return Effect.succeed(makeHandle({}));
      }
      if (args.slice(0, 3).join(" ") === "config device get") {
        return Effect.succeed(makeHandle({ code: 1 }));
      }
      if (args[0] === "start") {
        running = true;
      }
      if (args[0] === "delete") {
        machineExists = false;
      }
      return Effect.succeed(makeHandle({}));
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const created = Option.getOrThrow(
        yield* machines.createFromGolden(ThreadId.make("thread-1")),
      );
      yield* machines.destroy(created);

      expect(commands).toContainEqual({
        command: "incus",
        args: ["init", "golden", "thread-thread-1", "--vm"],
        stdin: "ignore",
      });
      expect(commands.some((entry) => entry.args.includes("security.nesting=true"))).toBe(false);
      const deleteIndex = commands.findIndex((entry) => entry.args[0] === "delete");
      const datasetDestroyIndex = commands.findIndex(
        (entry) =>
          entry.command === "sudo" && entry.args.slice(0, 3).join(" ") === "-n zfs destroy",
      );
      expect(deleteIndex).toBeGreaterThanOrEqual(0);
      expect(datasetDestroyIndex).toBeGreaterThan(deleteIndex);
      expect(
        commands
          .filter((entry) => entry.command === "incus")
          .every((entry) => entry.stdin === "ignore"),
      ).toBe(true);
    }).pipe(Effect.provide(provideIncus(spawner)));
  });

  it.effect("maps cwd and preserves argv while forcing non-piped incus stdin to null", () => {
    let captured: unknown;
    const spawner = ChildProcessSpawner.make((input) => {
      const command = input as unknown as { args: ReadonlyArray<string> };
      if (command.args[0] === "list") {
        return Effect.succeed(
          makeHandle({ stdout: '[{"name":"thread-thread-1","status":"Running"}]' }),
        );
      }
      if (command.args.includes("codex")) {
        captured = input;
      }
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
