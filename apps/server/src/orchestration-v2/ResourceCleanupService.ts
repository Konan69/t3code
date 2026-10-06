import { ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { MachineService } from "../machine/MachineService.ts";
import { cleanupThreadMachine } from "../machine/ThreadMachineCleanup.ts";
import { GitWorkflowService } from "../git/GitWorkflowService.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import { resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "attachment"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupTerminals: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const machines = yield* Effect.serviceOption(MachineService);
    const git = yield* Effect.serviceOption(GitWorkflowService);
    const projections = yield* Effect.serviceOption(ProjectionStoreV2);
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    return {
      cleanupTerminals: (threadId: string) =>
        terminals.close({ threadId, deleteHistory: true }).pipe(
          Effect.andThen(() => {
            if (Option.isNone(machines) || Option.isNone(git) || Option.isNone(projections))
              return Effect.void;
            return projections.value
              .getThread(ThreadId.make(threadId))
              .pipe(
                Effect.flatMap((thread) =>
                  cleanupThreadMachine({ thread, machines: machines.value, git: git.value }),
                ),
              );
          }),
          Effect.mapError(
            (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
          ),
        ),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            return path === null
              ? Effect.void
              : fileSystem
                  .remove(path, { force: true })
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                    ),
                  );
          },
          { discard: true, concurrency: 4 },
        ),
    };
  }),
);
