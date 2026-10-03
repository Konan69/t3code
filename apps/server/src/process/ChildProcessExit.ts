import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export interface ProviderProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export const observeProviderProcessExit = <E>(
  exitCode: Effect.Effect<number, E>,
): Effect.Effect<ProviderProcessExit, never> =>
  exitCode.pipe(
    Effect.matchCause({
      onFailure: (cause) => {
        const detail = Cause.pretty(cause);
        const signal = /signal:\s*'([^']+)'/i.exec(detail)?.[1] ?? null;
        return { exitCode: null, signal };
      },
      onSuccess: (code) => ({ exitCode: Number(code), signal: null }),
    }),
  );
