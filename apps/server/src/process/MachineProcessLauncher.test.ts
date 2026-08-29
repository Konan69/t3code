import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationThread,
  type ThreadMachineBinding,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeMachineProcessLauncher } from "./MachineProcessLauncher.ts";
import { makeHostProcessLauncher } from "./ProcessLauncher.ts";

const threadId = ThreadId.make("machine-launch-thread");
const binding = {
  machineId: "thread-machine-launch-thread",
  machineName: "thread-machine-launch-thread",
  state: "running",
  hostWorkspaceRoot: "/tank/threads/machine-launch-thread/ws",
  guestWorkspaceRoot: "/home/kixey/ws",
} satisfies ThreadMachineBinding;

const thread = {
  id: threadId,
  projectId: ProjectId.make("project-1"),
  title: "Machine launch",
  modelSelection: { instanceId: ProviderInstanceId.make("pi"), model: "default" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: "t3/machine-launch",
  worktreePath: null,
  machine: binding,
  latestTurn: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  messages: [],
  proposedPlans: [],
  activities: [],
  checkpoints: [],
  session: null,
} satisfies OrchestrationThread;

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

describe("MachineProcessLauncher", () => {
  it.effect("routes bound thread launches through MachineService.exec", () => {
    const handle = makeHandle();
    let machineInput: unknown;
    let hostReachableInput: unknown;
    let hostLaunches = 0;
    const host = makeHostProcessLauncher(
      ChildProcessSpawner.make(() => {
        hostLaunches += 1;
        return Effect.succeed(handle);
      }),
    );
    const launcher = makeMachineProcessLauncher(
      host,
      {
        exec: (input) => {
          machineInput = input;
          return Effect.succeed(handle);
        },
        ensureExecutableShim: ({ binding: machineBinding, command }) => {
          expect(machineBinding).toEqual(binding);
          expect(command).toBe("/host/bin/claude");
          return Effect.succeed("/t3/machine-shims/thread-machine-launch-thread/claude");
        },
        hostReachableUrl: (machineBinding, url) => {
          hostReachableInput = { binding: machineBinding, url };
          return Effect.succeed("http://10.42.0.18:4301/");
        },
      },
      { getThreadDetailById: () => Effect.succeed(Option.some(thread)) },
    );

    return Effect.gen(function* () {
      const launched = yield* launcher.launch({
        threadId,
        command: "/host/bin/pi",
        args: ["--mode", "rpc"],
        cwd: "/tank/threads/machine-launch-thread/ws/packages/app",
        env: { HOME: "/home/kixey", TOKEN: "secret" },
        extendEnv: false,
        shell: false,
      });

      expect(launched).toBe(handle);
      expect(hostLaunches).toBe(0);
      expect(machineInput).toEqual({
        binding,
        command: "/host/bin/pi",
        args: ["--mode", "rpc"],
        cwd: "/tank/threads/machine-launch-thread/ws/packages/app",
        env: { HOME: "/home/kixey", TOKEN: "secret" },
        extendEnv: false,
        shell: false,
      });
      expect(yield* launcher.resolveSdkExecutable({ threadId, command: "/host/bin/claude" })).toBe(
        "/t3/machine-shims/thread-machine-launch-thread/claude",
      );
      expect(yield* launcher.hostReachableUrl!({ threadId, url: "http://127.0.0.1:4301" })).toBe(
        "http://10.42.0.18:4301/",
      );
      expect(hostReachableInput).toEqual({ binding, url: "http://127.0.0.1:4301" });
    }).pipe(Effect.scoped);
  });

  it.effect("preserves host launches when the thread has no machine binding", () => {
    const handle = makeHandle();
    let hostInput: unknown;
    let machineLaunches = 0;
    const host = makeHostProcessLauncher(
      ChildProcessSpawner.make((input) => {
        hostInput = input;
        return Effect.succeed(handle);
      }),
    );
    const launcher = makeMachineProcessLauncher(
      host,
      {
        exec: () => {
          machineLaunches += 1;
          return Effect.succeed(handle);
        },
        ensureExecutableShim: () => Effect.die("machine shim resolution should not run"),
        hostReachableUrl: () => Effect.die("machine URL resolution should not run"),
      },
      {
        getThreadDetailById: () =>
          Effect.succeed(Option.some({ ...thread, machine: null } satisfies OrchestrationThread)),
      },
    );

    return Effect.gen(function* () {
      const launched = yield* launcher.launch({
        threadId,
        command: "/host/bin/codex",
        args: ["app-server"],
        cwd: "/host/workspace",
        env: { TOKEN: "secret" },
        extendEnv: true,
        shell: false,
      });

      expect(launched).toBe(handle);
      expect(machineLaunches).toBe(0);
      expect(hostInput).toMatchObject({
        command: "/host/bin/codex",
        args: ["app-server"],
        options: {
          cwd: "/host/workspace",
          env: { TOKEN: "secret" },
          extendEnv: true,
          shell: false,
        },
      });
      expect(yield* launcher.resolveSdkExecutable({ threadId, command: "/host/bin/claude" })).toBe(
        "/host/bin/claude",
      );
      expect(yield* launcher.hostReachableUrl!({ threadId, url: "http://127.0.0.1:4301" })).toBe(
        "http://127.0.0.1:4301",
      );
    }).pipe(Effect.scoped);
  });
});
