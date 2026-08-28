import { CommandId, EventId, ProjectId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Stream from "effect/Stream";
import { describe, expect } from "vite-plus/test";

import { ThreadMachineService } from "../../machine/ThreadMachineService.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { MachineReactor } from "../Services/MachineReactor.ts";
import { MachineReactorLive } from "./MachineReactor.ts";

const threadId = ThreadId.make("direct-thread");
const createdEvent = {
  sequence: 1,
  eventId: EventId.make("event-thread-created"),
  aggregateKind: "thread" as const,
  aggregateId: threadId,
  type: "thread.created" as const,
  occurredAt: "2026-01-01T00:00:00.000Z",
  commandId: CommandId.make("command-thread-created"),
  causationEventId: null,
  correlationId: null,
  metadata: {},
  payload: {
    threadId,
    projectId: ProjectId.make("project-1"),
    title: "Direct thread",
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access" as const,
    interactionMode: "default" as const,
    branch: null,
    worktreePath: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  },
};

describe("MachineReactor", () => {
  it.effect("ensures machines for direct thread.create events", () =>
    Effect.gen(function* () {
      const observed = yield* Deferred.make<ThreadId>();
      const reactorLayer = MachineReactorLive.pipe(
        Layer.provide(
          Layer.mock(OrchestrationEngineService)({
            streamDomainEvents: Stream.make(createdEvent),
          }),
        ),
        Layer.provide(
          Layer.succeed(
            ThreadMachineService,
            ThreadMachineService.of({
              ensureForThread: (id) =>
                Deferred.succeed(observed, id).pipe(Effect.as(Option.none())),
              runSetupForThread: () => Effect.succeed({ status: "no-script" }),
            }),
          ),
        ),
        Layer.provide(NodeServices.layer),
      );

      yield* Effect.gen(function* () {
        const reactor = yield* MachineReactor;
        yield* reactor.start();
        expect(yield* Deferred.await(observed)).toBe(threadId);
        yield* reactor.drain;
      }).pipe(Effect.provide(reactorLayer), Effect.scoped);
    }),
  );
});
