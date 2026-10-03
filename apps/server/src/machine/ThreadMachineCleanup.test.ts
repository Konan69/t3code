import { type ThreadMachineBinding, GitCommandError } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import { expect } from "vite-plus/test";

import { cleanupThreadMachine } from "./ThreadMachineCleanup.ts";

const machine: ThreadMachineBinding = {
  machineId: "thread-one",
  machineName: "thread-one",
  state: "running",
  projectWorkspaceRoot: "/repo",
  hostWorkspaceRoot: "/tank/threads/one/ws",
  guestWorkspaceRoot: "/home/kixey/ws",
};
const now = DateTime.makeUnsafe("2026-01-01T00:00:00Z");

it.effect.each(["active", "archived", "deleted"] as const)(
  "cleans up machine resources for a %s thread",
  (state) =>
    Effect.gen(function* () {
      const calls: string[] = [];
      yield* cleanupThreadMachine({
        thread: {
          machine,
          archivedAt: state === "archived" ? now : null,
          deletedAt: state === "deleted" ? now : null,
        },
        machines: {
          archive: () =>
            Effect.sync(() => {
              calls.push("archive");
            }),
          destroy: () =>
            Effect.sync(() => {
              calls.push("destroy");
            }),
        },
        git: {
          removeWorktree: (input) =>
            Effect.sync(() => {
              expect(input).toEqual({ cwd: "/repo", path: machine.hostWorkspaceRoot, force: true });
              calls.push("remove-worktree");
            }),
          pruneWorktrees: () =>
            Effect.sync(() => {
              calls.push("prune");
            }),
        },
      });
      expect(calls).toEqual(
        state === "active"
          ? []
          : state === "archived"
            ? ["archive"]
            : ["remove-worktree", "destroy"],
      );
    }),
);

it.effect("destroys resources and prunes stale registrations after worktree removal fails", () =>
  Effect.gen(function* () {
    const calls: string[] = [];
    yield* cleanupThreadMachine({
      thread: { machine, archivedAt: null, deletedAt: now },
      machines: {
        archive: () => Effect.void,
        destroy: () =>
          Effect.sync(() => {
            calls.push("destroy");
          }),
      },
      git: {
        removeWorktree: () =>
          Effect.fail(
            new GitCommandError({
              operation: "removeWorktree",
              command: "remove",
              cwd: "/repo",
              detail: "missing worktree",
            }),
          ),
        pruneWorktrees: () =>
          Effect.sync(() => {
            calls.push("prune");
          }),
      },
    });
    expect(calls).toEqual(["destroy", "prune"]);
  }),
);
