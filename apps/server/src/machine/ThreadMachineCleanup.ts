import type { OrchestrationV2AppThread } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

import type { GitWorkflowService } from "../git/GitWorkflowService.ts";
import type { MachineService } from "./MachineService.ts";

/** Called by V2's durable terminal cleanup after archive or deletion. */
export const cleanupThreadMachine = Effect.fn("cleanupThreadMachine")(function* (input: {
  readonly thread: Pick<OrchestrationV2AppThread, "machine" | "archivedAt" | "deletedAt">;
  readonly machines: Pick<MachineService["Service"], "archive" | "destroy">;
  readonly git: Pick<GitWorkflowService["Service"], "removeWorktree" | "pruneWorktrees">;
}) {
  const { machine, archivedAt, deletedAt } = input.thread;
  if (!machine) return;
  if (deletedAt === null) {
    if (archivedAt !== null) yield* input.machines.archive(machine);
    return;
  }
  const root = machine.projectWorkspaceRoot;
  const removalFailed =
    root === undefined
      ? false
      : yield* input.git
          .removeWorktree({
            cwd: root,
            path: machine.hostWorkspaceRoot,
            force: true,
          })
          .pipe(
            Effect.as(false),
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause)
                ? Effect.failCause(cause)
                : Effect.logWarning(
                    "Machine worktree removal failed; destroying resources and pruning Git.",
                    {
                      machineName: machine.machineName,
                      cause: Cause.pretty(cause),
                    },
                  ).pipe(Effect.as(true)),
            ),
          );
  yield* input.machines.destroy(machine);
  if (removalFailed && root !== undefined) yield* input.git.pruneWorktrees({ cwd: root });
});
