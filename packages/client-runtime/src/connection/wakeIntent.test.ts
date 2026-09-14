import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import * as WakeIntent from "./wakeIntent.ts";

const FIRST_ENVIRONMENT_ID = EnvironmentId.make("environment-1");
const SECOND_ENVIRONMENT_ID = EnvironmentId.make("environment-2");

describe("WakeIntent", () => {
  it.effect("consumes each environment's armed intent exactly once", () =>
    Effect.gen(function* () {
      const intents = yield* WakeIntent.WakeIntent;

      expect(yield* intents.consume(FIRST_ENVIRONMENT_ID)).toBe(false);
      yield* intents.arm(FIRST_ENVIRONMENT_ID);
      expect(yield* intents.consume(FIRST_ENVIRONMENT_ID)).toBe(true);
      expect(yield* intents.consume(FIRST_ENVIRONMENT_ID)).toBe(false);

      yield* intents.arm(FIRST_ENVIRONMENT_ID);
      yield* intents.arm(SECOND_ENVIRONMENT_ID);
      expect(yield* intents.consume(SECOND_ENVIRONMENT_ID)).toBe(true);
      expect(yield* intents.consume(FIRST_ENVIRONMENT_ID)).toBe(true);
      expect(yield* intents.consume(SECOND_ENVIRONMENT_ID)).toBe(false);
    }).pipe(Effect.provide(WakeIntent.layer)),
  );

  it.effect("coalesces repeated arms before the intent is consumed", () =>
    Effect.gen(function* () {
      const intents = yield* WakeIntent.WakeIntent;

      yield* intents.arm(FIRST_ENVIRONMENT_ID);
      yield* intents.arm(FIRST_ENVIRONMENT_ID);

      expect(yield* intents.consume(FIRST_ENVIRONMENT_ID)).toBe(true);
      expect(yield* intents.consume(FIRST_ENVIRONMENT_ID)).toBe(false);
    }).pipe(Effect.provide(WakeIntent.layer)),
  );
});
