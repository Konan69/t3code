import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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

export type WakeStatusResult =
  | {
      readonly _tag: "Status";
      readonly state: "suspended" | "running" | "resuming" | "stopped" | "other";
      readonly gceStatus: string;
    }
  | { readonly _tag: "Unauthorized" }
  | { readonly _tag: "UnexpectedResponse"; readonly status: number }
  | { readonly _tag: "TimedOut" }
  | { readonly _tag: "RequestFailed" };

export type WakeEndpointFetch = (
  input: string,
  init: RequestInit,
) => PromiseLike<{ readonly status: number }>;

export type WakeStatusFetch = (
  input: string,
  init: RequestInit,
) => PromiseLike<{
  readonly status: number;
  readonly json: () => PromiseLike<unknown>;
}>;

const WakeStatusResponse = Schema.Struct({
  state: Schema.String,
  gceStatus: Schema.String,
  name: Schema.String,
});
const decodeWakeStatusResponse = Schema.decodeUnknownOption(WakeStatusResponse, {
  onExcessProperty: "error",
});

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

function endpointUrl(policy: RelayWakePolicy, operation: "wake" | "status"): string {
  return `${policy.endpoint.replace(/\/+$/, "")}/${operation}/${encodeURIComponent(policy.name)}`;
}

function authorizationHeaders(policy: RelayWakePolicy): HeadersInit {
  return { Authorization: `Bearer ${policy.secret}` };
}

function normalizedWakeState(
  state: string,
): "suspended" | "running" | "resuming" | "stopped" | "other" {
  switch (state) {
    case "suspended":
    case "running":
    case "resuming":
    case "stopped":
      return state;
    default:
      return "other";
  }
}

export const wakeEndpoint = Effect.fn("clientRuntime.connection.wakeEndpoint")(function* (
  policy: RelayWakePolicy,
  request: WakeEndpointFetch = globalThis.fetch,
): Effect.fn.Return<WakeEndpointResult> {
  const requestEffect = Effect.tryPromise({
    try: (signal) =>
      request(endpointUrl(policy, "wake"), {
        method: "POST",
        headers: authorizationHeaders(policy),
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

export const wakeStatus = Effect.fn("clientRuntime.connection.wakeStatus")(function* (
  policy: RelayWakePolicy,
  request: WakeStatusFetch = globalThis.fetch,
): Effect.fn.Return<WakeStatusResult> {
  const requestEffect = Effect.tryPromise({
    try: (signal) =>
      request(endpointUrl(policy, "status"), {
        method: "GET",
        headers: authorizationHeaders(policy),
        signal,
      }),
    catch: () => new WakeEndpointRequestError(),
  }).pipe(
    Effect.flatMap((response) => {
      if (response.status === 401) {
        return Effect.succeed<WakeStatusResult>({ _tag: "Unauthorized" });
      }
      if (response.status !== 200) {
        return Effect.succeed<WakeStatusResult>({
          _tag: "UnexpectedResponse",
          status: response.status,
        });
      }
      return Effect.tryPromise({
        try: () => response.json(),
        catch: () => new WakeEndpointRequestError(),
      }).pipe(
        Effect.map(decodeWakeStatusResponse),
        Effect.map(
          Option.match({
            onNone: (): WakeStatusResult => ({ _tag: "UnexpectedResponse", status: 200 }),
            onSome: (body): WakeStatusResult => ({
              _tag: "Status",
              state: normalizedWakeState(body.state),
              gceStatus: body.gceStatus,
            }),
          }),
        ),
        Effect.orElseSucceed((): WakeStatusResult => ({ _tag: "UnexpectedResponse", status: 200 })),
      );
    }),
    Effect.orElseSucceed((): WakeStatusResult => ({ _tag: "RequestFailed" })),
  );

  return yield* requestEffect.pipe(
    Effect.timeoutOrElse({
      duration: WAKE_ENDPOINT_TIMEOUT_MS,
      orElse: () => Effect.succeed<WakeStatusResult>({ _tag: "TimedOut" }),
    }),
  );
});
