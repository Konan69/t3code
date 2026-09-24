import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type * as Scope from "effect/Scope";

export interface MachineReactorShape {
  readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  readonly drain: Effect.Effect<void>;
}

export class MachineReactor extends Context.Service<MachineReactor, MachineReactorShape>()(
  "t3/orchestration/Services/MachineReactor",
) {}
