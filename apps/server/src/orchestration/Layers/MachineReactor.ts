import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { GitWorkflowService } from "../../git/GitWorkflowService.ts";
import { MachineService } from "../../machine/MachineService.ts";
import { ThreadMachineService } from "../../machine/ThreadMachineService.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { MachineReactor, type MachineReactorShape } from "../Services/MachineReactor.ts";
import { cleanupMachineWorktree } from "./ThreadDeletionReactor.ts";

type ThreadCreatedEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;
type ThreadArchivedEvent = Extract<OrchestrationEvent, { type: "thread.archived" }>;
type MachineLifecycleEvent = ThreadCreatedEvent | ThreadArchivedEvent;

export const make = Effect.gen(function* () {
  const gitWorkflow = yield* GitWorkflowService;
  const machines = yield* MachineService;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadMachines = yield* ThreadMachineService;

  const safelyProcess = <E>(
    effect: Effect.Effect<void, E>,
    event: MachineLifecycleEvent,
    message: string,
  ): Effect.Effect<void> =>
    effect.pipe(
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.interrupt
          : Effect.logWarning(message, {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const processEvent = (event: MachineLifecycleEvent): Effect.Effect<void> =>
    event.type === "thread.created"
      ? safelyProcess(
          threadMachines.ensureForThread(event.payload.threadId).pipe(Effect.asVoid),
          event,
          "machine reactor failed to bind thread machine",
        )
      : safelyProcess(
          cleanupMachineWorktree({
            machine: event.payload.machine,
            projectWorkspaceRoot: event.payload.projectWorkspaceRoot,
            gitWorkflow,
            machines,
          }),
          event,
          "machine reactor failed to archive thread machine",
        );
  const worker = yield* makeDrainableWorker(processEvent);

  const start: MachineReactorShape["start"] = Effect.fn("MachineReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.created" || event.type === "thread.archived"
          ? worker.enqueue(event)
          : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies MachineReactorShape;
});

export const MachineReactorLive = Layer.effect(MachineReactor, make);
