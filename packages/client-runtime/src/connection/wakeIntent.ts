import type { EnvironmentId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

export class WakeIntent extends Context.Service<
  WakeIntent,
  {
    readonly arm: (environmentId: EnvironmentId) => Effect.Effect<void>;
    readonly consume: (environmentId: EnvironmentId) => Effect.Effect<boolean>;
  }
>()("@t3tools/client-runtime/connection/wakeIntent") {}

export const make = Effect.gen(function* () {
  const armedEnvironmentIds = yield* Ref.make<ReadonlySet<EnvironmentId>>(new Set());

  const arm = (environmentId: EnvironmentId) =>
    Ref.update(armedEnvironmentIds, (current) => {
      const next = new Set(current);
      next.add(environmentId);
      return next;
    });

  const consume = (environmentId: EnvironmentId) =>
    Ref.modify(armedEnvironmentIds, (current) => {
      if (!current.has(environmentId)) {
        return [false, current] as const;
      }
      const next = new Set(current);
      next.delete(environmentId);
      return [true, next] as const;
    });

  return WakeIntent.of({ arm, consume });
});

export const layer = Layer.effect(WakeIntent, make);
