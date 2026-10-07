import {
  EnvironmentAuthorizationError,
  clientRpcRequiredScopes,
  authScopeRequiredResponse,
  type EnvironmentId,
  type ClientGuardedRpcTag,
  ORCHESTRATION_V2_WS_METHODS,
  WS_METHODS,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";
import { RpcClientError } from "effect/rpc";

import * as EnvironmentSupervisor from "../connection/supervisor.ts";
import type { WsRpcProtocolClient } from "../rpc/protocol.ts";
import type { RpcSession } from "../rpc/session.ts";

export class EnvironmentRpcUnavailableError extends Schema.TaggedError<EnvironmentRpcUnavailableError>()(
  "EnvironmentRpcUnavailableError",
  {
    environmentId: Schema.String,
    message: Schema.String,
  },
) {}

export interface EnvironmentRpcRequestObservation {
  readonly environmentId: string;
  readonly method: string;
}

export class EnvironmentRpcRequestObserver extends Context.Reference<{
  readonly observe: (
    request: EnvironmentRpcRequestObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcRequestObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export type EnvironmentRpcTag = keyof WsRpcProtocolClient & string;
type RpcMethod<TTag extends EnvironmentRpcTag> = WsRpcProtocolClient[TTag];

export type EnvironmentSubscriptionRpcTag =
  | typeof WS_METHODS.codexAuthCallbackSubscribe
  | typeof WS_METHODS.providerAuthSubscribe
  | typeof WS_METHODS.providerInstallSubscribe
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeShell
  | typeof ORCHESTRATION_V2_WS_METHODS.subscribeThread
  | typeof WS_METHODS.subscribeAuthAccess
  | typeof WS_METHODS.subscribeServerConfig
  | typeof WS_METHODS.subscribeServerLifecycle
  | typeof WS_METHODS.scheduledTasksSubscribe
  | typeof WS_METHODS.subscribeTerminalEvents
  | typeof WS_METHODS.subscribeTerminalMetadata
  | typeof WS_METHODS.subscribePreviewEvents
  | typeof WS_METHODS.subscribeDiscoveredLocalServers
  | typeof WS_METHODS.subscribeDeviceState
  | typeof WS_METHODS.subscribeResourceTelemetry
  | typeof WS_METHODS.pullRequestsSubscribeRefreshes
  | typeof WS_METHODS.subscribeVcsStatus
  | typeof WS_METHODS.subscribeWorktreeSetup
  | typeof WS_METHODS.subscribeProjectClones
  | typeof WS_METHODS.terminalAttach
  | typeof WS_METHODS.terminalObserve;

export type EnvironmentStreamCommandRpcTag =
  | typeof WS_METHODS.chatGptHandoffSubscribe
  | typeof WS_METHODS.cloudInstallRelayClient
  | typeof WS_METHODS.serverUpdateServerWithProgress
  | typeof WS_METHODS.gitRunStackedAction;

export type EnvironmentStreamRpcTag =
  | EnvironmentSubscriptionRpcTag
  | EnvironmentStreamCommandRpcTag;

export type EnvironmentUnaryRpcTag = Exclude<EnvironmentRpcTag, EnvironmentStreamRpcTag>;

export interface EnvironmentRpcSubscriptionObservation {
  readonly environmentId: string;
  readonly method: EnvironmentSubscriptionRpcTag;
  readonly input: unknown;
}

export class EnvironmentRpcSubscriptionObserver extends Context.Reference<{
  readonly observe: (
    subscription: EnvironmentRpcSubscriptionObservation,
  ) => Effect.Effect<Effect.Effect<void>>;
}>("@t3tools/client-runtime/rpc/EnvironmentRpcSubscriptionObserver", {
  defaultValue: () => ({
    observe: () => Effect.succeed(Effect.void),
  }),
}) {}

export const isRpcClientError = Schema.is(RpcClientError.RpcClientError);
const isEnvironmentAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** Ceiling for the doubling delay between same-session expected-failure retries. */
const MAX_EXPECTED_FAILURE_RETRY_DELAY_MS = 30_000;

export type EnvironmentRpcInput<TTag extends EnvironmentRpcTag> = Parameters<RpcMethod<TTag>>[0];

export type EnvironmentRpcSuccess<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcFailure<TTag extends EnvironmentUnaryRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Effect.Effect<any, infer E, any>
    ? E
    : never;

export type EnvironmentRpcStreamValue<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<infer A, any, any>
    ? A
    : never;

export type EnvironmentRpcStreamFailure<TTag extends EnvironmentStreamRpcTag> =
  RpcMethod<TTag> extends (input: any, options?: any) => Stream.Stream<any, infer E, any>
    ? E
    : never;

const currentSession = Effect.fn("EnvironmentRpc.currentSession")(function* () {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  return yield* SubscriptionRef.get(supervisor.session).pipe(
    Effect.flatMap(
      Option.match({
        onNone: () =>
          Effect.fail(
            new EnvironmentRpcUnavailableError({
              environmentId: supervisor.target.environmentId,
              message: `${supervisor.target.label} is not connected.`,
            }),
          ),
        onSome: Effect.succeed,
      }),
    ),
  );
});

export const getInitialServerConfig = Effect.fn("EnvironmentRpc.getInitialServerConfig")(
  function* () {
    const session = yield* currentSession();
    return yield* session.initialConfig;
  },
);

/**
 * Requests that express the user's intent to drive work on a host. When the
 * host is unreachable these wake it and wait instead of failing, so sending a
 * message, answering an approval, resuming a queued run or opening a terminal
 * on a suspended Cloudbox brings the machine back. Passive calls (activity
 * reports, probes, reads) are deliberately absent: an idle open window must
 * never keep a billed machine awake.
 */
const WAKE_ON_UNAVAILABLE_METHODS: ReadonlySet<string> = new Set([
  ORCHESTRATION_V2_WS_METHODS.dispatchCommand,
  ORCHESTRATION_V2_WS_METHODS.launchThread,
  WS_METHODS.terminalOpen,
]);

/**
 * How long a wake-worthy request waits for the host to come back. A suspended
 * GCE instance resumes in well under a minute and a Boat sandbox restores from
 * its snapshot in one to two; the rest covers relay
 * authorization and the websocket handshake. Past this the request fails with
 * the usual unavailable error and the user can retry.
 */
const WAKE_SESSION_TIMEOUT = Duration.seconds(180);

/**
 * Command types sent through `dispatchCommand` without the user asking for
 * anything: `thread.visit` is emitted when a thread is merely shown (including
 * a cached unread thread restored at app start). Bookkeeping like that must
 * never start a billed machine.
 */
const PASSIVE_COMMAND_TYPES: ReadonlySet<string> = new Set(["thread.visit"]);

/** Whether this request expresses user intent to drive work on the host. */
const isWakeWorthy = (tag: string, input: unknown): boolean => {
  if (!WAKE_ON_UNAVAILABLE_METHODS.has(tag)) return false;
  if (tag !== ORCHESTRATION_V2_WS_METHODS.dispatchCommand) return true;
  const type =
    typeof input === "object" && input !== null && "type" in input ? input.type : undefined;
  return typeof type !== "string" || !PASSIVE_COMMAND_TYPES.has(type);
};

/**
 * Returns the live session, waking the host first when it is asleep.
 *
 * Call this at the start of a user operation that needs the host (sending a
 * message, uploading an attachment) so the operation's own prerequisite reads
 * do not fail fast before the command that would have woken it. `request`
 * calls it for wake-worthy commands as well.
 *
 * Only relay hosts (a suspended Cloudbox VM, woken through its wake policy)
 * and SSH hosts (a Boat box, resumed when the SSH proxy reconnects) can be
 * brought back by the client. An environment the user switched off is left
 * alone and fails at once, as do primary and bearer hosts.
 */
export const ensureSessionForUserAction = Effect.fn("EnvironmentRpc.ensureSessionForUserAction")(
  function* () {
    const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
    const current = yield* SubscriptionRef.get(supervisor.session);
    if (Option.isSome(current)) {
      return current.value;
    }
    const canWake =
      supervisor.target._tag === "RelayConnectionTarget" ||
      supervisor.target._tag === "SshConnectionTarget";
    const state = yield* SubscriptionRef.get(supervisor.state);
    if (!canWake || !state.desired) {
      return yield* currentSession();
    }
    yield* Effect.annotateCurrentSpan({ "environment.wake_requested": true });
    yield* supervisor.wake;
    // `changes` replays the current value first, so a session established
    // between the read above and this subscription is still observed.
    const awaited = yield* SubscriptionRef.changes(supervisor.session).pipe(
      Stream.filter(Option.isSome),
      Stream.map((session) => session.value),
      Stream.runHead,
      Effect.timeoutOption(WAKE_SESSION_TIMEOUT),
    );
    const session = Option.flatten(awaited);
    if (Option.isSome(session)) {
      return session.value;
    }
    return yield* new EnvironmentRpcUnavailableError({
      environmentId: supervisor.target.environmentId,
      message: `${supervisor.target.label} did not come back after a wake request.`,
    });
  },
);

/** Installed by the shared command boundary. A missing boundary denies protected writes. */
export class RpcPermissionGuard extends Context.Reference<{
  readonly authorize: (
    environmentId: EnvironmentId,
    method: string,
    input: unknown,
  ) => Effect.Effect<void, EnvironmentAuthorizationError>;
}>("@t3tools/client-runtime/rpc/RpcPermissionGuard", {
  defaultValue: () => ({
    authorize: (_environmentId, method, input) => {
      const scope = clientRpcRequiredScopes(method, input)[0];
      return scope === undefined
        ? Effect.void
        : Effect.fail(
            new EnvironmentAuthorizationError({
              ...authScopeRequiredResponse(scope),
              message: `This connection requires ${scope}.`,
            }),
          );
    },
  }),
}) {}

const authorizeRequest = Effect.fn("EnvironmentRpc.authorize")(function* (
  method: string,
  input: unknown,
) {
  if (clientRpcRequiredScopes(method, input).length === 0) return;
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  const guard = yield* RpcPermissionGuard;
  yield* guard.authorize(supervisor.target.environmentId, method, input);
});

export const requestGuarded = Effect.fn("EnvironmentRpc.request")(function* <
  TTag extends EnvironmentUnaryRpcTag,
>(tag: TTag, input: EnvironmentRpcInput<TTag>) {
  const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
  yield* Effect.annotateCurrentSpan({
    "environment.id": supervisor.target.environmentId,
    "rpc.method": tag,
  });
  // Authorize first: a request this connection may not make must not wake a host.
  yield* authorizeRequest(tag, input);
  const session = isWakeWorthy(tag, input)
    ? yield* ensureSessionForUserAction()
    : yield* currentSession();
  const observer = yield* EnvironmentRpcRequestObserver;
  const method = session.client[tag] as (
    input: EnvironmentRpcInput<TTag>,
  ) => Effect.Effect<EnvironmentRpcSuccess<TTag>, EnvironmentRpcFailure<TTag>>;
  const completeObservation = yield* observer.observe({
    environmentId: supervisor.target.environmentId,
    method: tag,
  });
  return yield* method(input).pipe(Effect.ensuring(completeObservation));
});

export function runStreamGuarded<TTag extends EnvironmentStreamCommandRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  | EnvironmentRpcStreamFailure<TTag>
  | EnvironmentRpcUnavailableError
  | EnvironmentAuthorizationError,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    authorizeRequest(tag, input).pipe(
      Effect.andThen(currentSession()),
      Effect.map((session) => {
        const method = session.client[tag] as (
          input: EnvironmentRpcInput<TTag>,
        ) => Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>;
        return method(input);
      }),
    ),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.runStream", {
      attributes: { "rpc.method": tag },
    }),
  );
}

interface SubscriptionOptions<TTag extends EnvironmentSubscriptionRpcTag> {
  /** Reports protocol or programming defects without changing their recovery policy. */
  readonly onDefect?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  readonly onExpectedFailure?: (
    cause: Cause.Cause<EnvironmentRpcStreamFailure<TTag>>,
  ) => Effect.Effect<void, never, never>;
  /**
   * First delay before resubscribing on the same session after an expected
   * failure. Each consecutive failure doubles it up to 30 seconds, and the
   * first value from a healthy stream resets it. Authorization failures are
   * not retried; they wait for the next session or `resubscribe` signal.
   */
  readonly retryExpectedFailureAfter?: Duration.Input;
  readonly resubscribe?: Stream.Stream<unknown, never, never>;
}

function subscribeDynamicMapped<TTag extends EnvironmentSubscriptionRpcTag, A>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  mapStream: (
    session: RpcSession,
    stream: Stream.Stream<EnvironmentRpcStreamValue<TTag>, EnvironmentRpcStreamFailure<TTag>>,
  ) => Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  A,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return Stream.unwrap(
    Effect.gen(function* () {
      const supervisor = yield* EnvironmentSupervisor.EnvironmentSupervisor;
      const observer = yield* EnvironmentRpcSubscriptionObserver;
      const sessionChanges = SubscriptionRef.changes(supervisor.session);
      const sessions =
        options?.resubscribe === undefined
          ? sessionChanges
          : Stream.merge(
              sessionChanges,
              options.resubscribe.pipe(
                Stream.mapEffect(() => SubscriptionRef.get(supervisor.session)),
              ),
            );
      return sessions.pipe(
        Stream.switchMap(
          Option.match({
            onNone: () => Stream.empty,
            onSome: (session) => {
              const method = (
                tag === WS_METHODS.subscribeServerConfig
                  ? session.subscribeServerConfig
                  : session.client[tag]
              ) as (
                input: EnvironmentRpcInput<TTag>,
              ) => Stream.Stream<
                EnvironmentRpcStreamValue<TTag>,
                EnvironmentRpcStreamFailure<TTag>
              >;
              // Consecutive expected-failure retries on this session. Reset by
              // the first value a resubscribed stream delivers.
              let expectedFailureRetries = 0;
              const subscribeToSession = (): Stream.Stream<A, EnvironmentRpcStreamFailure<TTag>> =>
                Stream.suspend(() =>
                  Stream.unwrap(
                    Effect.gen(function* () {
                      const input = yield* makeInput(session);
                      const completeObservation = yield* observer.observe({
                        environmentId: supervisor.target.environmentId,
                        method: tag,
                        input,
                      });
                      const stream = mapStream(session, method(input)).pipe(
                        Stream.onFirst(() =>
                          Effect.sync(() => {
                            expectedFailureRetries = 0;
                          }),
                        ),
                      );
                      return stream.pipe(Stream.ensuring(completeObservation));
                    }),
                  ).pipe(
                    Stream.tapCause((cause) =>
                      options?.onDefect !== undefined &&
                      cause.reasons.some(
                        (reason) =>
                          reason._tag === "Die" ||
                          (reason._tag === "Fail" &&
                            isRpcClientError(reason.error) &&
                            reason.error.reason._tag === "RpcClientDefect"),
                      )
                        ? options.onDefect(cause)
                        : Effect.void,
                    ),
                    Stream.catchCause((cause) => {
                      const hasOnlyExpectedFailures =
                        cause.reasons.length > 0 &&
                        cause.reasons.every((reason) => reason._tag === "Fail");
                      const isTransportFailure =
                        hasOnlyExpectedFailures &&
                        cause.reasons.every(
                          (reason) => reason._tag === "Fail" && isRpcClientError(reason.error),
                        );
                      if (isTransportFailure) {
                        return Stream.fromEffect(
                          Effect.logWarning(
                            "Durable RPC subscription lost its transport; waiting for the next session.",
                            {
                              cause: Cause.pretty(cause),
                              method: tag,
                              environmentId: supervisor.target.environmentId,
                            },
                          ),
                        ).pipe(Stream.drain);
                      }
                      if (hasOnlyExpectedFailures && options?.onExpectedFailure !== undefined) {
                        const handled = Stream.fromEffect(options.onExpectedFailure(cause)).pipe(
                          Stream.drain,
                        );
                        const isAuthorizationFailure = cause.reasons.some(
                          (reason) =>
                            reason._tag === "Fail" && isEnvironmentAuthorizationError(reason.error),
                        );
                        if (
                          options.retryExpectedFailureAfter === undefined ||
                          isAuthorizationFailure
                        ) {
                          return handled;
                        }
                        const retryDelay = Duration.millis(
                          Math.min(
                            Duration.toMillis(options.retryExpectedFailureAfter) *
                              2 ** expectedFailureRetries,
                            MAX_EXPECTED_FAILURE_RETRY_DELAY_MS,
                          ),
                        );
                        expectedFailureRetries += 1;
                        return handled.pipe(
                          Stream.concat(
                            Stream.fromEffect(Effect.sleep(retryDelay)).pipe(Stream.drain),
                          ),
                          Stream.concat(subscribeToSession()),
                        );
                      }
                      return Stream.failCause(cause);
                    }),
                  ),
                );
              return subscribeToSession();
            },
          }),
        ),
      );
    }),
  ).pipe(
    Stream.withSpan("EnvironmentRpc.subscribe", {
      attributes: { "rpc.method": tag },
    }),
  );
}

export function subscribeDynamic<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(tag, makeInput, (_session, stream) => stream, options);
}

/** Tags each value before `switchMap` can buffer it across a session change. */
export function subscribeDynamicWithSession<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  makeInput: (session: RpcSession) => Effect.Effect<EnvironmentRpcInput<TTag>>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  readonly [session: RpcSession, value: EnvironmentRpcStreamValue<TTag>],
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamicMapped(
    tag,
    makeInput,
    (session, stream) => stream.pipe(Stream.map((value) => [session, value] as const)),
    options,
  );
}

export function subscribe<TTag extends EnvironmentSubscriptionRpcTag>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
  options?: SubscriptionOptions<TTag>,
): Stream.Stream<
  EnvironmentRpcStreamValue<TTag>,
  EnvironmentRpcStreamFailure<TTag>,
  EnvironmentSupervisor.EnvironmentSupervisor
> {
  return subscribeDynamic(tag, () => Effect.succeed(input), options);
}

/** Protected writes must go through the permission-aware command layer. */
export const request = <TTag extends Exclude<EnvironmentUnaryRpcTag, ClientGuardedRpcTag>>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => requestGuarded(tag, input);

export const runStream = <
  TTag extends Exclude<EnvironmentStreamCommandRpcTag, ClientGuardedRpcTag>,
>(
  tag: TTag,
  input: EnvironmentRpcInput<TTag>,
) => runStreamGuarded(tag, input);
