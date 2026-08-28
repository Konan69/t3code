import type { OrchestrationEvent } from "@t3tools/contracts";
import { makeDrainableWorker } from "@t3tools/shared/DrainableWorker";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import { ThreadMachineService } from "../../machine/ThreadMachineService.ts";
import { forkParked } from "../../serverActivation.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { MachineReactor, type MachineReactorShape } from "../Services/MachineReactor.ts";

type ThreadCreatedEvent = Extract<OrchestrationEvent, { type: "thread.created" }>;

export const make = Effect.gen(function* () {
  const orchestrationEngine = yield* OrchestrationEngineService;
  const threadMachines = yield* ThreadMachineService;

  const processThreadCreated = (event: ThreadCreatedEvent) =>
    threadMachines.ensureForThread(event.payload.threadId).pipe(
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterruptsOnly(cause)
          ? Effect.failCause(cause)
          : Effect.logWarning("machine reactor failed to bind thread machine", {
              threadId: event.payload.threadId,
              cause: Cause.pretty(cause),
            }),
      ),
    );
  const worker = yield* makeDrainableWorker(processThreadCreated);

  const start: MachineReactorShape["start"] = Effect.fn("MachineReactor.start")(function* () {
    yield* forkParked(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) =>
        event.type === "thread.created" ? worker.enqueue(event) : Effect.void,
      ),
    );
  });

  return { start, drain: worker.drain } satisfies MachineReactorShape;
});

export const MachineReactorLive = Layer.effect(MachineReactor, make);
