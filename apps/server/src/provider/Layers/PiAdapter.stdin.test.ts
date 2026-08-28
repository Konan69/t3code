import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Sink from "effect/Sink";
import { describe, expect } from "vite-plus/test";

import { runPiStdinWriter } from "./PiAdapter.ts";

describe("PiAdapter stdin writer", () => {
  it.effect("keeps stdin open across commands and ends it exactly once when stopped", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const queue = yield* Queue.bounded<string>(2);
        const wroteBoth = yield* Deferred.make<void>();
        const writes: string[] = [];
        let endCount = 0;
        const decoder = new TextDecoder();
        const stdin = Sink.forEach((chunk: Uint8Array) =>
          Effect.sync(() => {
            writes.push(decoder.decode(chunk));
          }).pipe(
            Effect.flatMap(() =>
              writes.length < 2
                ? Effect.void
                : Deferred.succeed(wroteBoth, undefined).pipe(Effect.asVoid),
            ),
          ),
        ).pipe(Sink.ensuring(Effect.sync(() => (endCount += 1))));

        const writer = yield* runPiStdinWriter(queue, stdin).pipe(Effect.forkScoped);
        yield* Queue.offer(queue, '{"type":"first"}\n');
        yield* Queue.offer(queue, '{"type":"second"}\n');
        yield* Deferred.await(wroteBoth);

        expect(writes).toEqual(['{"type":"first"}\n', '{"type":"second"}\n']);
        expect(endCount).toBe(0);

        yield* Queue.shutdown(queue);
        yield* Fiber.await(writer);
        expect(endCount).toBe(1);

        yield* Queue.shutdown(queue);
        yield* Fiber.await(writer);
        expect(endCount).toBe(1);
      }),
    ),
  );
});
