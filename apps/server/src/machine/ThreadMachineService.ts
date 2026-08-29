import {
  CommandId,
  type OrchestrationProjectShell,
  type OrchestrationThread,
  type ProjectId,
  type ThreadId,
  type ThreadMachineBinding,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { OrchestrationEngineService } from "../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MachineService } from "./MachineService.ts";
import * as Context from "effect/Context";

export class ThreadMachineServiceError extends Schema.TaggedErrorClass<ThreadMachineServiceError>()(
  "ThreadMachineServiceError",
  {
    operation: Schema.String,
    threadId: Schema.String,
    detail: Schema.String,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Thread machine service failed for thread '${this.threadId}' in ${this.operation}: ${this.detail}`;
  }
}

const isThreadMachineServiceError = Schema.is(ThreadMachineServiceError);

function innermostCauseMessage(cause: unknown): string | undefined {
  const seen = new Set<unknown>();
  let current = cause;
  let resolved: string | undefined;

  while (Predicate.isObject(current) && !seen.has(current)) {
    seen.add(current);
    const message =
      Predicate.hasProperty(current, "message") && Predicate.isString(current.message)
        ? current.message.trim()
        : "";
    const detail =
      Predicate.hasProperty(current, "detail") && Predicate.isString(current.detail)
        ? current.detail.trim()
        : "";
    resolved = message || detail || resolved;
    if (!Predicate.hasProperty(current, "cause") || current.cause === undefined) {
      break;
    }
    current = current.cause;
  }

  if (Predicate.isString(current) && current.trim().length > 0) {
    return current.trim();
  }
  return resolved;
}

export type ThreadMachineSetupResult =
  | { readonly status: "no-script" }
  | {
      readonly status: "completed";
      readonly scriptId: string;
      readonly scriptName: string;
    };

export interface MachineWorktreePreparation {
  readonly projectCwd: string;
  readonly baseBranch: string;
  readonly branch?: string | undefined;
  readonly startFromOrigin?: boolean | undefined;
}

export interface ThreadMachineServiceShape {
  readonly ensureForThread: (
    threadId: ThreadId,
    preparation?: MachineWorktreePreparation,
  ) => Effect.Effect<Option.Option<ThreadMachineBinding>, ThreadMachineServiceError>;
  readonly runSetupForThread: (input: {
    readonly threadId: ThreadId;
    readonly projectId: ProjectId;
    readonly binding: ThreadMachineBinding;
  }) => Effect.Effect<ThreadMachineSetupResult, ThreadMachineServiceError>;
}

export class ThreadMachineService extends Context.Service<
  ThreadMachineService,
  ThreadMachineServiceShape
>()("t3/machine/ThreadMachineService") {}

function sameMachineIdentity(
  left: ThreadMachineBinding | null | undefined,
  right: ThreadMachineBinding,
): boolean {
  return (
    left?.machineId === right.machineId &&
    left.machineName === right.machineName &&
    left.projectWorkspaceRoot === right.projectWorkspaceRoot &&
    left.hostWorkspaceRoot === right.hostWorkspaceRoot &&
    left.guestWorkspaceRoot === right.guestWorkspaceRoot
  );
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const fileSystem = yield* FileSystem.FileSystem;
  const gitWorkflow = yield* GitWorkflowService;
  const machines = yield* MachineService;
  const ensureSemaphore = yield* Semaphore.make(1);
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const commandId = (operation: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`server:machine:${operation}:${id}`)),
    );

  const ensureWorktree = Effect.fn("ThreadMachineService.ensureWorktree")(function* (
    thread: OrchestrationThread,
    project: OrchestrationProjectShell,
    binding: ThreadMachineBinding,
    preparation?: MachineWorktreePreparation,
  ) {
    if (yield* fileSystem.exists(`${binding.hostWorkspaceRoot}/.git`)) {
      return;
    }

    let baseRef = preparation?.baseBranch;
    if (!baseRef) {
      const status = yield* gitWorkflow.localStatus({ cwd: project.workspaceRoot });
      if (!status.isRepo || !status.refName) {
        return yield* new ThreadMachineServiceError({
          operation: "prepare-worktree",
          threadId: thread.id,
          detail: `Project '${project.id}' has no current Git branch for a machine worktree.`,
        });
      }
      baseRef = status.refName;
    }

    if (
      preparation?.startFromOrigin === true &&
      (yield* gitWorkflow.remoteExists({ cwd: preparation.projectCwd, remoteName: "origin" }))
    ) {
      yield* gitWorkflow.fetchRemote({ cwd: preparation.projectCwd, remoteName: "origin" });
      baseRef = (yield* gitWorkflow.resolveRemoteTrackingCommit({
        cwd: preparation.projectCwd,
        refName: preparation.baseBranch,
        fallbackRemoteName: "origin",
      })).commitSha;
    }

    const branch = preparation?.branch ?? thread.branch ?? `t3/${binding.machineName}`;
    const projectCwd = preparation?.projectCwd ?? project.workspaceRoot;
    const matchingRefs = yield* gitWorkflow.listRefs({ cwd: projectCwd, query: branch, limit: 20 });
    const branchExists = matchingRefs.refs.some(
      (ref) => ref.name === branch && ref.isRemote !== true,
    );
    const branchIsCheckedOut = (yield* gitWorkflow.listWorktrees({ cwd: projectCwd })).some(
      (worktree) => worktree.refName === branch,
    );
    const newBranch = `t3/${binding.machineName}`;
    if (branchIsCheckedOut) {
      yield* Effect.logInfo(
        "thread machine branch is already checked out; creating a dedicated branch",
        {
          threadId: thread.id,
          requestedBranch: branch,
          newBranch,
        },
      );
    }
    const worktree = yield* gitWorkflow.createWorktree({
      cwd: projectCwd,
      refName: branchIsCheckedOut ? branch : branchExists ? branch : baseRef,
      ...(branchIsCheckedOut
        ? { newRefName: newBranch, baseRefName: branch }
        : branchExists
          ? {}
          : { newRefName: branch, baseRefName: preparation?.baseBranch ?? baseRef }),
      path: binding.hostWorkspaceRoot,
    });
    if (thread.branch !== worktree.worktree.refName) {
      yield* orchestrationEngine.dispatch({
        type: "thread.meta.update",
        commandId: yield* commandId("worktree"),
        threadId: thread.id,
        branch: worktree.worktree.refName,
      });
    }
  });

  const ensureForThreadRaw = Effect.fn("ThreadMachineService.ensureForThread")(function* (
    threadId: ThreadId,
    preparation?: MachineWorktreePreparation,
  ) {
    const thread = yield* projectionSnapshotQuery
      .getThreadDetailById(threadId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!thread) {
      return yield* new ThreadMachineServiceError({
        operation: "resolve-thread",
        threadId,
        detail: `Thread '${threadId}' was not found.`,
      });
    }
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(thread.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (project?.machineMode !== "thread") {
      return Option.none();
    }

    const workspace = yield* machines.ensureWorkspace(threadId, project.workspaceRoot);
    if (Option.isNone(workspace)) {
      return Option.none();
    }
    const cleanupBinding = { ...workspace.value, state: "stopped" as const };
    if (!sameMachineIdentity(thread.machine, cleanupBinding)) {
      yield* orchestrationEngine.dispatch({
        type: "thread.machine.bind",
        commandId: yield* commandId("bind-workspace"),
        threadId,
        binding: cleanupBinding,
      });
    }
    yield* ensureWorktree(thread, project, workspace.value, preparation);

    const created = yield* machines.createFromGolden(threadId, project.workspaceRoot);
    if (Option.isNone(created)) {
      return Option.none();
    }
    const binding = { ...created.value, state: "running" as const };
    if (!sameMachineIdentity(thread.machine, binding)) {
      yield* orchestrationEngine.dispatch({
        type: "thread.machine.bind",
        commandId: yield* commandId("bind"),
        threadId,
        binding,
      });
    } else if (thread.machine?.state !== binding.state) {
      yield* orchestrationEngine.dispatch({
        type: "thread.machine.state.set",
        commandId: yield* commandId("state"),
        threadId,
        state: binding.state,
      });
    }
    return Option.some(binding);
  });
  const ensureForThread: ThreadMachineServiceShape["ensureForThread"] = (threadId, preparation) =>
    ensureSemaphore
      .withPermits(1)(ensureForThreadRaw(threadId, preparation))
      .pipe(
        Effect.mapError((cause) =>
          isThreadMachineServiceError(cause)
            ? cause
            : new ThreadMachineServiceError({
                operation: "ensure",
                threadId,
                detail: innermostCauseMessage(cause) ?? "Failed to ensure thread machine.",
                cause,
              }),
        ),
      );

  const runSetupForThreadRaw = Effect.fn("ThreadMachineService.runSetupForThread")(function* (
    input: Parameters<ThreadMachineServiceShape["runSetupForThread"]>[0],
  ) {
    const project = yield* projectionSnapshotQuery
      .getProjectShellById(input.projectId)
      .pipe(Effect.map(Option.getOrUndefined));
    if (!project) {
      return yield* new ThreadMachineServiceError({
        operation: "resolve-project",
        threadId: input.threadId,
        detail: `Project '${input.projectId}' was not found.`,
      });
    }
    const script = setupProjectScript(project.scripts);
    if (!script) {
      return { status: "no-script" } as const;
    }
    const env = projectScriptRuntimeEnv({
      project: { cwd: input.binding.guestWorkspaceRoot },
      worktreePath: input.binding.guestWorkspaceRoot,
    });
    const exitCode = yield* machines
      .exec({
        binding: input.binding,
        command: "/bin/bash",
        args: ["-lc", script.command],
        cwd: input.binding.hostWorkspaceRoot,
        env,
        extendEnv: true,
        stdin: "ignore",
      })
      .pipe(
        Effect.flatMap((handle) => handle.exitCode),
        Effect.scoped,
      );
    if (Number(exitCode) !== 0) {
      return yield* new ThreadMachineServiceError({
        operation: "setup",
        threadId: input.threadId,
        detail: `Setup script '${script.name}' exited with ${Number(exitCode)}.`,
      });
    }
    return {
      status: "completed",
      scriptId: script.id,
      scriptName: script.name,
    } as const;
  });
  const runSetupForThread: ThreadMachineServiceShape["runSetupForThread"] = (input) =>
    runSetupForThreadRaw(input).pipe(
      Effect.mapError((cause) =>
        isThreadMachineServiceError(cause)
          ? cause
          : new ThreadMachineServiceError({
              operation: "setup",
              threadId: input.threadId,
              detail: innermostCauseMessage(cause) ?? "Failed to run setup in thread machine.",
              cause,
            }),
      ),
    );

  return ThreadMachineService.of({ ensureForThread, runSetupForThread });
});

export const layer = Layer.effect(ThreadMachineService, make);
