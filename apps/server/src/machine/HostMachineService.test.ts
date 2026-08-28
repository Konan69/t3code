import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import * as HostMachineService from "./HostMachineService.ts";
import {
  GOLDEN_IMAGE_ALIAS,
  MACHINE_GUEST_USER,
  MACHINE_GUEST_WORKSPACE_ROOT,
  MachineService,
  hostWorkspaceRootForThread,
  machineNameForThread,
  type ThreadMachineBinding,
} from "./MachineService.ts";

const binding = {
  machineId: "machine-thread-1",
  machineName: "thread-thread-1",
  state: "stopped",
  hostWorkspaceRoot: "/tank/threads/thread-1/ws",
  guestWorkspaceRoot: "/home/kixey/ws",
} satisfies ThreadMachineBinding;

function makeHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(1),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(false),
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

const provideHostMachineService = (spawner: ChildProcessSpawner.ChildProcessSpawner["Service"]) =>
  HostMachineService.layer.pipe(
    Layer.provide(Layer.succeed(ChildProcessSpawner.ChildProcessSpawner, spawner)),
  );

describe("HostMachineService", () => {
  it("keeps the settled machine naming and path conventions", () => {
    const threadId = ThreadId.make("0198-thread-id");

    expect(machineNameForThread(threadId)).toBe("thread-0198-thread-id");
    expect(hostWorkspaceRootForThread(threadId)).toBe("/tank/threads/0198-thread-id/ws");
    expect(GOLDEN_IMAGE_ALIAS).toBe("golden");
    expect(MACHINE_GUEST_USER).toBe("kixey");
    expect(MACHINE_GUEST_WORKSPACE_ROOT).toBe("/home/kixey/ws");
  });

  it.effect("is a no-op boundary and never probes a machine runtime", () => {
    let spawnCount = 0;
    const spawner = ChildProcessSpawner.make(() => {
      spawnCount += 1;
      return Effect.succeed(makeHandle());
    });

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      const created = yield* machines.createFromGolden(ThreadId.make("thread-1"));
      yield* machines.start(binding);
      yield* machines.stop(binding);
      yield* machines.archive(binding);
      yield* machines.destroy(binding);

      expect(Option.isNone(created)).toBe(true);
      expect(yield* machines.hostToGuestPath(binding, "/tmp/project")).toBe("/tmp/project");
      expect(yield* machines.guestToHostPath(binding, "/tmp/project")).toBe("/tmp/project");
      expect(yield* machines.hostReachableUrl(binding, "http://127.0.0.1:3773/mcp")).toBe(
        "http://127.0.0.1:3773/mcp",
      );
      expect(spawnCount).toBe(0);
    }).pipe(Effect.provide(provideHostMachineService(spawner)));
  });

  it.effect("exec preserves the host child-process launch specification", () => {
    let captured: unknown;
    const spawner = ChildProcessSpawner.make((command) => {
      captured = command;
      return Effect.succeed(makeHandle());
    });
    const env = { PATH: "/custom/bin", TOKEN: "secret" };

    return Effect.gen(function* () {
      const machines = yield* MachineService;
      yield* machines.exec({
        binding,
        command: "provider.cmd",
        args: ["app-server", "--flag=value"],
        cwd: "C:\\workspace",
        env,
        extendEnv: false,
        shell: "powershell.exe",
        detached: true,
        forceKillAfter: "2 seconds",
      });

      expect(captured).toMatchObject({
        _tag: "StandardCommand",
        command: "provider.cmd",
        args: ["app-server", "--flag=value"],
        options: {
          cwd: "C:\\workspace",
          env,
          extendEnv: false,
          shell: "powershell.exe",
          detached: true,
          forceKillAfter: "2 seconds",
        },
      });
    }).pipe(Effect.provide(provideHostMachineService(spawner)), Effect.scoped);
  });
});
