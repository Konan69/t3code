import * as Data from "effect/Data";
import * as Effect from "effect/Effect";

import type { RelayWakePolicy } from "./model.ts";

export const WAKE_ENDPOINT_TIMEOUT_MS = 5_000;

class WakeEndpointRequestError extends Data.TaggedError("WakeEndpointRequestError")<{}> {}

export type WakeEndpointResult =
  | { readonly _tag: "Resuming" }
  | { readonly _tag: "Running" }
  | { readonly _tag: "UnsupportedState" }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "UnexpectedResponse"; readonly status: number }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "RequestFailed" };

export type WakeEndpointFetch = (
  input: string,
  init: RequestInit,
) => PromiseLike<{ readonly status: number }>;

function resultFromStatus(status: number): WakeEndpointResult {
  switch (status) {
    case 202:
      return { _tag: "Resuming" };
    case 200:
      return { _tag: "Running" };
    case 409:
      return { _tag: "UnsupportedState" };
    case 401:
      return { _tag: "Unauthorized" };
    default:
      return { _tag: "UnexpectedResponse", status };
  }
}

function wakeUrl(policy: RelayWakePolicy): string {
  return `${policy.endpoint.replace(/\/+$/, "")}/wake/${encodeURIComponent(policy.name)}`;
}

export const wakeEndpoint = Effect.fn("clientRuntime.connection.wakeEndpoint")(function* (
  policy: RelayWakePolicy,
  request: WakeEndpointFetch = globalThis.fetch,
): Effect.fn.Return<WakeEndpointResult> {
  const requestEffect = Effect.tryPromise({
    try: (signal) =>
      request(wakeUrl(policy), {
        method: "POST",
        headers: {
          Authorization: `Bearer ${policy.secret}`,
        },
        signal,
      }),
    catch: () => new WakeEndpointRequestError(),
  }).pipe(
    Effect.map((response) => resultFromStatus(response.status)),
    Effect.catch(() =>
      Effect.logWarning("Cloudbox wake request failed; continuing with relay connection.").pipe(
        Effect.as<WakeEndpointResult>({ _tag: "RequestFailed" }),
      ),
    ),
  );

  return yield* requestEffect.pipe(
    Effect.timeoutOrElse({
      duration: WAKE_ENDPOINT_TIMEOUT_MS,
      orElse: () =>
        Effect.logWarning(
          "Cloudbox wake request timed out; continuing with relay connection.",
        ).pipe(Effect.as<WakeEndpointResult>({ _tag: "TimedOut" })),
    }),
    Effect.tap((result) =>
      result._tag === "Unauthorized" ||
      result._tag === "UnsupportedState" ||
      result._tag === "UnexpectedResponse"
        ? Effect.logWarning(
            "Cloudbox wake request was not accepted; continuing with relay connection.",
            {
              result: result._tag,
              ...(result._tag === "UnexpectedResponse" ? { status: result.status } : {}),
            },
          )
        : Effect.void,
    ),
  );
});
