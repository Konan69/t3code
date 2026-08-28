import {
  CommandId,
  type ProjectId,
  type ThreadId,
  type ThreadMachineBinding,
} from "@t3tools/contracts";
import { projectScriptRuntimeEnv, setupProjectScript } from "@t3tools/shared/projectScripts";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
) {}

const isThreadMachineServiceError = Schema.is(ThreadMachineServiceError);

export type ThreadMachineSetupResult =
  | { readonly status: "no-script" }
  | {
      readonly status: "completed";
      readonly scriptId: string;
      readonly scriptName: string;
    };

export interface ThreadMachineServiceShape {
  readonly ensureForThread: (
    threadId: ThreadId,
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

export function shouldPrepareGitWorktree(binding: ThreadMachineBinding | undefined): boolean {
  return binding === undefined;
}

function sameMachineIdentity(
  left: ThreadMachineBinding | null | undefined,
  right: ThreadMachineBinding,
): boolean {
  return (
    left?.machineId === right.machineId &&
    left.machineName === right.machineName &&
    left.hostWorkspaceRoot === right.hostWorkspaceRoot &&
    left.guestWorkspaceRoot === right.guestWorkspaceRoot
  );
}

export const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const machines = yield* MachineService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const commandId = (operation: string) =>
    crypto.randomUUIDv4.pipe(
      Effect.orDie,
      Effect.map((id) => CommandId.make(`server:machine:${operation}:${id}`)),
    );

  const ensureForThreadRaw = Effect.fn("ThreadMachineService.ensureForThread")(function* (
    threadId: ThreadId,
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

    const created = yield* machines.createFromGolden(threadId);
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
  const ensureForThread: ThreadMachineServiceShape["ensureForThread"] = (threadId) =>
    ensureForThreadRaw(threadId).pipe(
      Effect.mapError((cause) =>
        isThreadMachineServiceError(cause)
          ? cause
          : new ThreadMachineServiceError({
              operation: "ensure",
              threadId,
              detail: "Failed to ensure thread machine.",
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
              detail: "Failed to run setup in thread machine.",
              cause,
            }),
      ),
    );

  return ThreadMachineService.of({ ensureForThread, runSetupForThread });
});

export const layer = Layer.effect(ThreadMachineService, make);
