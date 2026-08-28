import {
  EventId,
  GitCommandError,
  ThreadId,
  type OrchestrationEvent,
  type ThreadMachineBinding,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import { describe, expect, it } from "vite-plus/test";

import {
  cleanupMachineWorktree,
  logCleanupCauseUnlessInterrupted,
} from "./ThreadDeletionReactor.ts";

describe("logCleanupCauseUnlessInterrupted", () => {
  const threadId = ThreadId.make("thread-deletion-reactor-test");

  it("swallows ordinary cleanup failures", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.fail("cleanup failed"),
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isSuccess(exit)).toBe(true);
  });

  it("removes the registered worktree before destroying its machine dataset", async () => {
    const order: string[] = [];
    const machine = {
      machineId: "thread-cleanup",
      machineName: "thread-cleanup",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/cleanup/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;
    const event = {
      sequence: 1,
      eventId: EventId.make("event-cleanup"),
      aggregateKind: "thread",
      aggregateId: threadId,
      occurredAt: "2026-01-01T00:00:00.000Z",
      commandId: null,
      causationEventId: null,
      correlationId: null,
      metadata: {},
      type: "thread.deleted",
      payload: {
        threadId,
        deletedAt: "2026-01-01T00:00:00.000Z",
        projectWorkspaceRoot: "/repo",
        machine,
      },
    } satisfies Extract<OrchestrationEvent, { type: "thread.deleted" }>;

    await Effect.runPromise(
      cleanupMachineWorktree({
        machine: event.payload.machine,
        projectWorkspaceRoot: event.payload.projectWorkspaceRoot,
        gitWorkflow: {
          removeWorktree: (input) => {
            expect(input).toEqual({ cwd: "/repo", path: "/tank/threads/cleanup/ws" });
            order.push("worktree.remove");
            return Effect.void;
          },
        },
        machines: {
          destroy: (binding) => {
            expect(binding).toEqual(machine);
            order.push("dataset.destroy");
            return Effect.void;
          },
        },
      }),
    );

    expect(order).toEqual(["worktree.remove", "dataset.destroy"]);
  });

  it("destroys machine resources when Git worktree removal fails", async () => {
    const machine = {
      machineId: "thread-failed-create",
      machineName: "thread-failed-create",
      state: "running",
      hostWorkspaceRoot: "/tank/threads/failed-create/ws",
      guestWorkspaceRoot: "/home/kixey/ws",
    } satisfies ThreadMachineBinding;
    let destroyed = false;

    await Effect.runPromise(
      cleanupMachineWorktree({
        machine,
        projectWorkspaceRoot: "/repo",
        gitWorkflow: {
          removeWorktree: () =>
            Effect.fail(
              new GitCommandError({
                operation: "GitVcsDriver.removeWorktree",
                command: "git worktree remove",
                cwd: "/repo",
                detail: "worktree was never created",
              }),
            ),
        },
        machines: {
          destroy: () =>
            Effect.sync(() => {
              destroyed = true;
            }),
        },
      }),
    );

    expect(destroyed).toBe(true);
  });

  it("preserves interrupt causes", async () => {
    const exit = await Effect.runPromiseExit(
      logCleanupCauseUnlessInterrupted({
        effect: Effect.interrupt,
        message: "thread deletion cleanup skipped provider session stop",
        threadId,
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    if (Exit.isFailure(exit)) {
      expect(Cause.hasInterruptsOnly(exit.cause)).toBe(true);
    }
  });
});
