import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ThreadMachineBinding,
} from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MachineService } from "./MachineService.ts";
import { ThreadMachineService, layer, shouldPrepareGitWorktree } from "./ThreadMachineService.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const binding = {
  machineId: "thread-thread-1",
  machineName: "thread-thread-1",
  state: "running",
  hostWorkspaceRoot: "/tank/threads/thread-1/ws",
  guestWorkspaceRoot: "/home/kixey/ws",
} satisfies ThreadMachineBinding;

const thread: OrchestrationThread = {
  id: threadId,
  projectId,
  title: "Machine thread",
  modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  machine: null,
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
};

const project = (machineMode: "off" | "thread"): OrchestrationProjectShell => ({
  id: projectId,
  title: "Project",
  workspaceRoot: "/repo",
  defaultModelSelection: null,
  defaultThreadEnvMode: null,
  machineMode,
  faviconPath: null,
  scripts: [
    {
      id: "setup",
      name: "Setup",
      command: "bun install",
      icon: "configure",
      runOnWorktreeCreate: true,
    },
  ],
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
});

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

const makeLayer = (input: {
  readonly machineMode: "off" | "thread";
  readonly onCreate?: () => void;
  readonly onDispatch?: (command: unknown) => void;
  readonly onExec?: (execInput: unknown) => void;
  readonly existingMachine?: ThreadMachineBinding | null;
}) => {
  const machineLayer = Layer.succeed(
    MachineService,
    MachineService.of({
      createFromGolden: () => {
        input.onCreate?.();
        return Effect.succeed(Option.some(binding));
      },
      start: () => Effect.void,
      stop: () => Effect.void,
      exec: (execInput) => {
        input.onExec?.(execInput);
        return Effect.succeed(makeHandle());
      },
      archive: () => Effect.void,
      destroy: () => Effect.void,
      hostToGuestPath: (_binding, value) => Effect.succeed(value),
      guestToHostPath: (_binding, value) => Effect.succeed(value),
      hostReachableUrl: (_binding, value) => Effect.succeed(value),
    }),
  );
  return layer.pipe(
    Layer.provide(machineLayer),
    Layer.provide(
      Layer.mock(ProjectionSnapshotQuery)({
        getThreadDetailById: () =>
          Effect.succeed(
            Option.some({
              ...thread,
              machine: input.existingMachine ?? thread.machine,
            }),
          ),
        getProjectShellById: () => Effect.succeed(Option.some(project(input.machineMode))),
      }),
    ),
    Layer.provide(
      Layer.mock(OrchestrationEngineService)({
        dispatch: (command) => {
          input.onDispatch?.(command);
          return Effect.succeed({ sequence: 1 });
        },
      }),
    ),
    Layer.provide(NodeServices.layer),
  );
};

describe("ThreadMachineService", () => {
  it("skips bootstrap worktree creation once a machine binding exists", () => {
    expect(shouldPrepareGitWorktree(undefined)).toBe(true);
    expect(shouldPrepareGitWorktree(binding)).toBe(false);
  });

  it.effect("does nothing while project machine mode is off", () => {
    let creates = 0;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.ensureForThread(threadId);
      expect(Option.isNone(result)).toBe(true);
      expect(creates).toBe(0);
    }).pipe(Effect.provide(makeLayer({ machineMode: "off", onCreate: () => (creates += 1) })));
  });

  it.effect("creates and persists a deterministic binding when mode is on", () => {
    const dispatched: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.ensureForThread(threadId);
      expect(Option.getOrThrow(result)).toEqual(binding);
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.machine.bind",
          threadId,
          binding,
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({ machineMode: "thread", onDispatch: (command) => dispatched.push(command) }),
      ),
    );
  });

  it.effect("persists reconciled running state without rebinding the identity", () => {
    const dispatched: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      yield* service.ensureForThread(threadId);
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.machine.state.set",
          threadId,
          state: "running",
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          existingMachine: { ...binding, state: "stopped" },
          onDispatch: (command) => dispatched.push(command),
        }),
      ),
    );
  });

  it.effect("runs setup through machine exec with null stdin", () => {
    let execInput: unknown;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.runSetupForThread({ threadId, projectId, binding });
      expect(result).toEqual({ status: "completed", scriptId: "setup", scriptName: "Setup" });
      expect(execInput).toMatchObject({
        binding,
        command: "/bin/bash",
        args: ["-lc", "bun install"],
        cwd: binding.hostWorkspaceRoot,
        stdin: "ignore",
      });
    }).pipe(
      Effect.provide(makeLayer({ machineMode: "thread", onExec: (input) => (execInput = input) })),
    );
  });
});
