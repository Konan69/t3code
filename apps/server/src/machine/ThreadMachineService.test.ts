import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  GitCommandError,
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

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MachineService } from "./MachineService.ts";
import { ThreadMachineService, layer } from "./ThreadMachineService.ts";

const projectId = ProjectId.make("project-1");
const threadId = ThreadId.make("thread-1");
const binding = {
  machineId: "thread-thread-1",
  machineName: "thread-thread-1",
  state: "running",
  projectWorkspaceRoot: "/repo",
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
  readonly onWorkspace?: (projectWorkspaceRoot: string | undefined) => void;
  readonly onCreate?: (projectWorkspaceRoot: string | undefined) => void;
  readonly onWorktree?: (input: unknown) => void;
  readonly onDispatch?: (command: unknown) => void;
  readonly onExec?: (execInput: unknown) => void;
  readonly existingMachine?: ThreadMachineBinding | null;
  readonly threadBranch?: string | null;
  readonly existingBranches?: ReadonlyArray<string>;
  readonly checkedOutBranches?: ReadonlyArray<string>;
  readonly failWorktreeCreate?: boolean;
}) => {
  const machineLayer = Layer.succeed(
    MachineService,
    MachineService.of({
      ensureWorkspace: (_threadId, projectWorkspaceRoot) => {
        input.onWorkspace?.(projectWorkspaceRoot);
        return Effect.succeed(Option.some(binding));
      },
      createFromGolden: (_threadId, projectWorkspaceRoot) => {
        input.onCreate?.(projectWorkspaceRoot);
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
              branch: input.threadBranch ?? thread.branch,
              machine: input.existingMachine ?? thread.machine,
            }),
          ),
        getProjectShellById: () => Effect.succeed(Option.some(project(input.machineMode))),
      }),
    ),
    Layer.provide(
      Layer.mock(GitWorkflowService)({
        localStatus: () =>
          Effect.succeed({
            isRepo: true,
            hasPrimaryRemote: false,
            isDefaultRef: true,
            refName: "main",
            hasWorkingTreeChanges: false,
            workingTree: { files: [], insertions: 0, deletions: 0 },
          }),
        remoteExists: () => Effect.succeed(false),
        listRefs: ({ query }) => {
          const refs = (input.existingBranches ?? [])
            .filter((name) => query === undefined || name.includes(query))
            .map((name) => ({
              name,
              current: false,
              isDefault: false,
              worktreePath: null,
            }));
          return Effect.succeed({
            refs,
            isRepo: true,
            hasPrimaryRemote: false,
            nextCursor: null,
            totalCount: refs.length,
          });
        },
        listWorktrees: () =>
          Effect.succeed(
            (input.checkedOutBranches ?? []).map((refName) => ({
              path: refName === "main" ? "/repo" : `/worktrees/${refName}`,
              refName,
              locked: false,
              prunable: false,
            })),
          ),
        createWorktree: (worktreeInput) => {
          input.onWorktree?.(worktreeInput);
          if (input.failWorktreeCreate) {
            return Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.createWorktree",
                command: "git worktree add",
                cwd: "/repo",
                detail: "workspace is not writable",
              }),
            );
          }
          return Effect.succeed({
            worktree: {
              path: binding.hostWorkspaceRoot,
              refName: worktreeInput.newRefName ?? worktreeInput.refName,
            },
          });
        },
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
  it.effect("does nothing while project machine mode is off", () => {
    let creates = 0;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.ensureForThread(threadId);
      expect(Option.isNone(result)).toBe(true);
      expect(creates).toBe(0);
    }).pipe(Effect.provide(makeLayer({ machineMode: "off", onCreate: () => (creates += 1) })));
  });

  it.effect("carries the project checkout root through machine creation and binding", () => {
    const roots: Array<string | undefined> = [];
    const dispatched: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.ensureForThread(threadId);

      expect(roots).toEqual(["/repo", "/repo"]);
      expect(Option.getOrThrow(result).projectWorkspaceRoot).toBe("/repo");
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.machine.bind",
          binding: expect.objectContaining({ projectWorkspaceRoot: "/repo" }),
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          onWorkspace: (root) => roots.push(root),
          onCreate: (root) => roots.push(root),
          onDispatch: (command) => dispatched.push(command),
        }),
      ),
    );
  });

  it.effect("keeps the unset-branch behavior for a new thread machine", () => {
    const order: string[] = [];
    const dispatched: unknown[] = [];
    let worktreeInput: unknown;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.ensureForThread(threadId);
      expect(Option.getOrThrow(result)).toEqual(binding);
      expect(order).toEqual(["dataset", "worktree", "device-and-start"]);
      expect(worktreeInput).toEqual({
        cwd: "/repo",
        refName: "main",
        newRefName: "t3/thread-thread-1",
        baseRefName: "main",
        path: "/tank/threads/thread-1/ws",
      });
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId,
          branch: "t3/thread-thread-1",
        }),
      );
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.machine.bind",
          threadId,
          binding,
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          onWorkspace: () => order.push("dataset"),
          onWorktree: (value) => {
            order.push("worktree");
            worktreeInput = value;
          },
          onCreate: () => order.push("device-and-start"),
          onDispatch: (command) => dispatched.push(command),
        }),
      ),
    );
  });

  it.effect("branches from a requested branch that the project checkout already uses", () => {
    const dispatched: unknown[] = [];
    let worktreeInput: unknown;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      yield* service.ensureForThread(threadId);

      expect(worktreeInput).toEqual({
        cwd: "/repo",
        refName: "main",
        newRefName: "t3/thread-thread-1",
        baseRefName: "main",
        path: "/tank/threads/thread-1/ws",
      });
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.meta.update",
          threadId,
          branch: "t3/thread-thread-1",
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          threadBranch: "main",
          existingBranches: ["main"],
          checkedOutBranches: ["main"],
          onWorktree: (value) => (worktreeInput = value),
          onDispatch: (command) => dispatched.push(command),
        }),
      ),
    );
  });

  it.effect("checks out an existing branch that no worktree uses", () => {
    const dispatched: unknown[] = [];
    let worktreeInput: unknown;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      yield* service.ensureForThread(threadId);

      expect(worktreeInput).toEqual({
        cwd: "/repo",
        refName: "feature/existing",
        path: "/tank/threads/thread-1/ws",
      });
      expect(dispatched).not.toContainEqual(
        expect.objectContaining({
          type: "thread.meta.update",
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          threadBranch: "feature/existing",
          existingBranches: ["feature/existing"],
          onWorktree: (value) => (worktreeInput = value),
          onDispatch: (command) => dispatched.push(command),
        }),
      ),
    );
  });

  it.effect("persists a cleanup binding before worktree creation can fail", () => {
    const dispatched: unknown[] = [];
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const result = yield* service.ensureForThread(threadId).pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(dispatched).toContainEqual(
        expect.objectContaining({
          type: "thread.machine.bind",
          threadId,
          binding: { ...binding, state: "stopped" },
        }),
      );
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          failWorktreeCreate: true,
          onDispatch: (command) => dispatched.push(command),
        }),
      ),
    );
  });

  it.effect("includes the root cause detail in ThreadMachineServiceError messages", () => {
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      const error = yield* service.ensureForThread(threadId).pipe(Effect.flip);

      expect(error.detail).toContain("workspace is not writable");
      expect(error.message).toContain("workspace is not writable");
    }).pipe(Effect.provide(makeLayer({ machineMode: "thread", failWorktreeCreate: true })));
  });

  it.effect("reuses an existing branch after an archived machine is recreated", () => {
    let worktreeInput: unknown;
    return Effect.gen(function* () {
      const service = yield* ThreadMachineService;
      yield* service.ensureForThread(threadId);
      expect(worktreeInput).toEqual({
        cwd: "/repo",
        refName: "t3/thread-thread-1",
        path: "/tank/threads/thread-1/ws",
      });
    }).pipe(
      Effect.provide(
        makeLayer({
          machineMode: "thread",
          existingBranches: [`t3/${binding.machineName}`],
          onWorktree: (value) => (worktreeInput = value),
        }),
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
