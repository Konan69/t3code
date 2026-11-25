/**
 * PeerEnvironmentService - Lets a thread on this server work with threads on
 * another T3 environment.
 *
 * A peer is reachable only when it is listed in the `peerEnvironments`
 * setting. Each configured peer has at most one connection (an SSH tunnel plus
 * a bearer), opened by the first operation that needs it, shared by every
 * caller, and closed after ten minutes without use so a machine billed while
 * awake can go back to sleep. Listing the configured peers never connects.
 *
 * @module PeerEnvironmentService
 */
import * as NodeCrypto from "node:crypto";
import {
  CommandId,
  type EnvironmentId,
  MessageId,
  OrchestrationV2ConversationMessage,
  OrchestrationV2ShellThreadStatus,
  type PeerEnvironmentConfig,
  PeerEnvironmentId,
  ProjectId,
  type ProviderInteractionMode,
  type RuntimeMode,
  type ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { resolveInteractionMode, resolveRuntimeMode } from "../mcp/OrchestratorMcpService.ts";
import * as Settings from "../serverSettings.ts";
import {
  PeerAttachmentsUnsupported,
  type PeerCommandRejected,
  PeerEnvironmentNotConfigured,
  type PeerEnvironmentUnauthorized,
  PeerEnvironmentUnreachable,
  PeerEnvironmentWaking,
  PeerModeEscalationDenied,
  type PeerProtocolMismatch,
  type PeerThreadNotFound,
} from "./PeerErrors.ts";
import * as PeerTransport from "./PeerTransport.ts";

/** How long an unused connection is kept before its tunnel is closed. */
const PEER_IDLE_RELEASE = Duration.minutes(10);
/**
 * Longest one call may take. Kept under the shortest MCP tool timeout a
 * provider applies (Codex: 60 seconds), so the caller always gets an answer.
 */
const PEER_CALL_DEADLINE = Duration.seconds(45);
/** Longest a connect (wake, tunnel, pairing) may run in the background. */
const PEER_CONNECT_LIMIT = Duration.minutes(4);
/** `listThreads` returns this many threads, most recently active first. */
export const PEER_THREAD_LIST_LIMIT = 50;
export const PEER_MESSAGE_DEFAULT_LIMIT = 20;
export const PEER_MESSAGE_MAX_LIMIT = 100;
/** Characters kept per message; the rest is replaced by a marker. */
export const PEER_MESSAGE_TEXT_LIMIT = 4000;

export const PeerEnvironmentSummary = Schema.Struct({
  peerId: PeerEnvironmentId,
  label: Schema.String,
  target: Schema.String,
  /** Whether a tunnel is open right now. A closed one opens on the next call. */
  connected: Schema.Boolean,
});
export type PeerEnvironmentSummary = typeof PeerEnvironmentSummary.Type;

export const PeerThreadSummary = Schema.Struct({
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  /** Null when the peer's snapshot no longer lists the thread's project. */
  projectTitle: Schema.NullOr(Schema.String),
  status: OrchestrationV2ShellThreadStatus,
  /** True while the thread waits on an approval or an answer from its user. */
  awaitingInput: Schema.Boolean,
  lastActivityAt: Schema.String,
});

export const PeerThreadList = Schema.Struct({
  peerId: PeerEnvironmentId,
  threads: Schema.Array(PeerThreadSummary),
  /** Threads on the peer before the list was cut to the most recent ones. */
  total: Schema.Int,
  truncated: Schema.Boolean,
});
export type PeerThreadList = typeof PeerThreadList.Type;

export const PeerThreadMessage = Schema.Struct({
  messageId: MessageId,
  role: OrchestrationV2ConversationMessage.fields.role,
  text: Schema.String,
  /** True when `text` was cut at the per-message limit. */
  truncated: Schema.Boolean,
  /** True while the peer's agent is still writing this message. */
  streaming: Schema.Boolean,
  createdAt: Schema.String,
});

export const PeerThreadDetail = Schema.Struct({
  peerId: PeerEnvironmentId,
  threadId: ThreadId,
  title: Schema.String,
  projectId: ProjectId,
  status: OrchestrationV2ShellThreadStatus,
  awaitingInput: Schema.Boolean,
  /** Oldest first. */
  messages: Schema.Array(PeerThreadMessage),
  /** True when the thread holds messages older than the ones returned. */
  hasEarlierMessages: Schema.Boolean,
});
export type PeerThreadDetail = typeof PeerThreadDetail.Type;

export const PeerSendResult = Schema.Struct({
  peerId: PeerEnvironmentId,
  threadId: ThreadId,
  messageId: MessageId,
  accepted: Schema.Literal(true),
});
export type PeerSendResult = typeof PeerSendResult.Type;

export interface PeerSendInput {
  readonly threadId: ThreadId;
  readonly text: string;
  /** The caller's own key for this prompt; the same key never posts twice. */
  readonly clientRequestId: string;
  /** The thread on this server that is sending, and the modes it runs with. */
  readonly sender: {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly runtimeMode: RuntimeMode;
    readonly interactionMode: ProviderInteractionMode;
  };
  /** Accepted only so a caller that passes attachments gets a clear refusal. */
  readonly attachments?: ReadonlyArray<unknown>;
}

type PeerConnectionError =
  | PeerEnvironmentNotConfigured
  | PeerEnvironmentWaking
  | PeerEnvironmentUnreachable
  | PeerEnvironmentUnauthorized
  | PeerProtocolMismatch
  | ServerSettingsError;

export class PeerEnvironmentService extends Context.Service<
  PeerEnvironmentService,
  {
    /** The configured peers. Reads settings only; never opens SSH. */
    readonly listPeers: Effect.Effect<ReadonlyArray<PeerEnvironmentSummary>, ServerSettingsError>;
    readonly listThreads: (peerId: string) => Effect.Effect<PeerThreadList, PeerConnectionError>;
    readonly readThread: (
      peerId: string,
      threadId: ThreadId,
      options: { readonly limit: number },
    ) => Effect.Effect<PeerThreadDetail, PeerConnectionError | PeerThreadNotFound>;
    /**
     * Posts a prompt into a thread on the peer and returns once the peer has
     * accepted it. The turn it starts is not awaited.
     */
    readonly sendMessage: (
      peerId: string,
      input: PeerSendInput,
    ) => Effect.Effect<
      PeerSendResult,
      | PeerConnectionError
      | PeerThreadNotFound
      | PeerModeEscalationDenied
      | PeerCommandRejected
      | PeerAttachmentsUnsupported
    >;
  }
>()("t3/peer/PeerEnvironmentService") {}

/**
 * The ids a prompt carries on the peer, derived from who sends it and the
 * caller's request key. The peer keeps a receipt per command id, so a tool
 * call retried with the same key replays the first outcome instead of posting
 * the prompt again.
 */
function peerMessageIdentity(input: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly clientRequestId: string;
}): { readonly commandId: CommandId; readonly messageId: MessageId } {
  const digest = NodeCrypto.createHash("sha256")
    .update(`${input.environmentId}\0${input.threadId}\0${input.clientRequestId}`)
    .digest("hex")
    .slice(0, 32);
  return {
    commandId: CommandId.make(`command:mcp:peer:${digest}`),
    messageId: MessageId.make(`message:mcp:peer:${digest}`),
  };
}

function boundedText(text: string): { readonly text: string; readonly truncated: boolean } {
  const characters = Array.from(text);
  if (characters.length <= PEER_MESSAGE_TEXT_LIMIT) return { text, truncated: false };
  const dropped = characters.length - PEER_MESSAGE_TEXT_LIMIT;
  return {
    text: `${characters.slice(0, PEER_MESSAGE_TEXT_LIMIT).join("")}\n… [truncated: ${dropped} more characters]`,
    truncated: true,
  };
}

interface Connection {
  readonly peer: PeerEnvironmentConfig;
  readonly link: PeerTransport.PeerLink;
  readonly scope: Scope.Closeable;
  bearer: Redacted.Redacted<string>;
  lastUsedAt: number;
}

type ConnectError = PeerEnvironmentUnreachable | PeerEnvironmentUnauthorized | PeerProtocolMismatch;

/** A connect in progress. It runs in the service, not in the call that began it. */
interface Pending {
  readonly peer: PeerEnvironmentConfig;
  readonly token: object;
  readonly fiber: Fiber.Fiber<Connection, ConnectError>;
}

interface PeerState {
  /** Serializes the decisions about one peer: reuse, start, re-pair, release. */
  readonly lock: Semaphore.Semaphore;
  connection: Connection | null;
  pending: Pending | null;
}

const sameRoute = (left: PeerEnvironmentConfig, right: PeerEnvironmentConfig) =>
  left.target === right.target &&
  left.port === right.port &&
  left.identityFile === right.identityFile;

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const transport = yield* PeerTransport.PeerTransport;
  const serviceScope = yield* Scope.Scope;
  const states = new Map<string, PeerState>();
  const idleMillis = Duration.toMillis(PEER_IDLE_RELEASE);

  const stateFor = (peerId: string): PeerState => {
    const existing = states.get(peerId);
    if (existing !== undefined) return existing;
    const created: PeerState = { lock: Semaphore.makeUnsafe(1), connection: null, pending: null };
    states.set(peerId, created);
    return created;
  };

  // Callers hold the peer's lock. Closing the scope ends the tunnel process
  // and the connection's idle watcher; the peer's server keeps running.
  const close = (state: PeerState, connection: Connection) =>
    Effect.suspend(() => {
      if (state.connection === connection) state.connection = null;
      return Scope.close(connection.scope, Exit.void);
    });

  const drop = (state: PeerState, connection: Connection) =>
    state.lock.withPermits(1)(close(state, connection));

  // Callers hold the peer's lock. Ends everything held for a peer that is no
  // longer configured, or whose route changed.
  const discard = (state: PeerState) =>
    Effect.gen(function* () {
      const { connection, pending } = state;
      state.pending = null;
      if (pending !== null) yield* Fiber.interrupt(pending.fiber);
      if (connection !== null) yield* close(state, connection);
    });

  const releaseIfIdle = (state: PeerState, connection: Connection) =>
    state.lock.withPermits(1)(
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        if (state.connection !== connection) return;
        if (now - connection.lastUsedAt < idleMillis) return;
        yield* close(state, connection);
      }),
    );

  /**
   * Closes the connection once it has gone unused for the idle period. The
   * watcher lives in the connection's scope, so it ends with the connection
   * however that is closed. Closing a scope interrupts the fibers in it, so
   * the release itself runs in a fiber of the service: the check and the
   * close happen under the peer's lock, and a caller arriving at that moment
   * either refreshes the connection first or reconnects after.
   */
  const releaseWhenIdle = (state: PeerState, connection: Connection): Effect.Effect<void> =>
    Effect.gen(function* () {
      while (state.connection === connection) {
        const now = yield* Clock.currentTimeMillis;
        const remaining = connection.lastUsedAt + idleMillis - now;
        if (remaining > 0) {
          yield* Effect.sleep(Duration.millis(remaining));
          continue;
        }
        const release = yield* releaseIfIdle(state, connection).pipe(Effect.forkIn(serviceScope));
        yield* Fiber.await(release);
      }
    });

  /**
   * Opens the tunnel and pairs, as a fiber of the service. Only the network
   * work is interruptible, and it is capped: the scope is closed on failure,
   * interruption, or the cap, and a finished connection is recorded before
   * interruption can be observed, so no tunnel is left without an owner.
   */
  const connect = (
    state: PeerState,
    peer: PeerEnvironmentConfig,
    token: object,
    registered: Deferred.Deferred<void>,
  ): Effect.Effect<Connection, ConnectError> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* Deferred.await(registered);
        const scope = yield* Scope.fork(serviceScope);
        const exit = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              const link = yield* transport.open(peer).pipe(Scope.provide(scope));
              const bearer = yield* transport.authorize(peer, link);
              return { link, bearer };
            }).pipe(
              Effect.timeoutOption(PEER_CONNECT_LIMIT),
              Effect.flatMap(
                Option.match({
                  onSome: (ready) => Effect.succeed(ready),
                  onNone: () =>
                    Effect.fail(
                      new PeerEnvironmentUnreachable({
                        peerId: peer.id,
                        detail: `connecting did not finish within ${Duration.format(PEER_CONNECT_LIMIT)}`,
                      }),
                    ),
                }),
              ),
            ),
          ),
        );
        const current = state.pending?.token === token;
        if (current) state.pending = null;
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit);
          return yield* Effect.failCause(exit.cause);
        }
        if (!current) {
          // Superseded while finishing: the peer was removed or re-pointed.
          yield* Scope.close(scope, Exit.void);
          return yield* Effect.interrupt;
        }
        const connection: Connection = {
          peer,
          link: exit.value.link,
          scope,
          bearer: exit.value.bearer,
          lastUsedAt: yield* Clock.currentTimeMillis,
        };
        state.connection = connection;
        // Forked from an uninterruptible region: the watcher must still be
        // interruptible, or closing the connection would wait out its sleep.
        yield* releaseWhenIdle(state, connection).pipe(Effect.interruptible, Effect.forkIn(scope));
        return connection;
      }),
    );

  // Callers hold the peer's lock. The fiber waits for `registered`, so it
  // cannot finish before `state.pending` names it.
  const startConnect = (state: PeerState, peer: PeerEnvironmentConfig) =>
    Effect.gen(function* () {
      const token = {};
      const registered = yield* Deferred.make<void>();
      const fiber = yield* connect(state, peer, token, registered).pipe(
        Effect.forkIn(serviceScope),
      );
      const pending: Pending = { peer, token, fiber };
      state.pending = pending;
      yield* Deferred.succeed(registered, undefined);
      return pending;
    }).pipe(Effect.uninterruptible);

  const configuredPeer = (peerId: string) =>
    settings.getSettings.pipe(
      Effect.map((current) =>
        current.peerEnvironments.find((candidate) => candidate.id === peerId),
      ),
    );

  /**
   * The peer's one connection. Settings are read again here, under the peer's
   * lock, on every call and every retry: a peer removed from the allowlist is
   * refused and loses its tunnel, and a re-pointed one is reached at its new
   * target. The connect itself is only joined, never owned, by the caller: a
   * caller that gives up leaves it running for the next one.
   */
  const acquire = (
    peerId: string,
  ): Effect.Effect<Connection, ConnectError | PeerEnvironmentNotConfigured | ServerSettingsError> =>
    Effect.gen(function* () {
      const state = stateFor(peerId);
      const step = yield* state.lock.withPermits(1)(
        Effect.gen(function* () {
          // Pruned while this caller waited for the lock.
          if (states.get(peerId) !== state) return { _tag: "Retry" as const };
          const peer = yield* configuredPeer(peerId);
          if (peer === undefined) {
            yield* discard(state);
            states.delete(peerId);
            return yield* new PeerEnvironmentNotConfigured({ peerId });
          }
          const connection = state.connection;
          if (connection !== null && sameRoute(connection.peer, peer)) {
            connection.lastUsedAt = yield* Clock.currentTimeMillis;
            return { _tag: "Ready" as const, connection };
          }
          // Re-pointed in settings: the old tunnel leads elsewhere.
          if (
            connection !== null ||
            (state.pending !== null && !sameRoute(state.pending.peer, peer))
          ) {
            yield* discard(state);
          }
          const pending = state.pending ?? (yield* startConnect(state, peer));
          return { _tag: "Pending" as const, fiber: pending.fiber };
        }),
      );
      if (step._tag === "Retry") return yield* acquire(peerId);
      if (step._tag === "Ready") return step.connection;
      const exit = yield* Fiber.await(step.fiber);
      if (Exit.isSuccess(exit)) return exit.value;
      // The connect was cancelled by a settings change, not by a failure.
      if (Cause.hasInterruptsOnly(exit.cause)) return yield* acquire(peerId);
      return yield* Effect.failCause(exit.cause);
    });

  // Pair again only if nobody replaced the refused bearer in the meantime and
  // the peer is still configured for the route this tunnel leads to.
  const repair = (
    peerId: string,
    state: PeerState,
    connection: Connection,
    refused: Redacted.Redacted<string>,
  ) =>
    state.lock.withPermits(1)(
      Effect.gen(function* () {
        if (state.connection !== connection || connection.bearer !== refused) return;
        const peer = yield* configuredPeer(peerId);
        if (peer === undefined || !sameRoute(peer, connection.peer)) {
          return yield* close(state, connection);
        }
        connection.bearer = yield* transport.authorize(connection.peer, connection.link);
      }),
    );

  const touch = (connection: Connection) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        connection.lastUsedAt = now;
      }),
    );

  /**
   * Runs one operation against a configured peer. A refused credential is
   * replaced by pairing again, and a dead tunnel by reconnecting, each at
   * most once per call; a second failure of the same kind is returned.
   *
   * The whole call is bounded, because an agent's tool call is: a caller
   * still waiting for the machine to wake is told so and asked to call
   * again, while the connect it was waiting on carries on.
   */
  const withPeer = <A, E>(
    peerId: string,
    operation: (
      session: PeerTransport.PeerSession,
    ) => Effect.Effect<A, E | PeerEnvironmentUnauthorized | PeerEnvironmentUnreachable>,
  ): Effect.Effect<A, E | PeerConnectionError> => {
    const attempt = (repaired: {
      readonly credential: boolean;
      readonly tunnel: boolean;
    }): Effect.Effect<A, E | PeerConnectionError> =>
      Effect.gen(function* () {
        const connection = yield* acquire(peerId);
        const state = stateFor(peerId);
        const bearer = connection.bearer;
        return yield* operation({ peer: connection.peer, link: connection.link, bearer }).pipe(
          Effect.ensuring(touch(connection)),
          Effect.catch((error): Effect.Effect<A, E | PeerConnectionError> => {
            if (!repaired.credential && Predicate.isTagged(error, "PeerEnvironmentUnauthorized")) {
              return repair(peerId, state, connection, bearer).pipe(
                Effect.andThen(attempt({ ...repaired, credential: true })),
              );
            }
            if (!repaired.tunnel && Predicate.isTagged(error, "PeerEnvironmentUnreachable")) {
              return drop(state, connection).pipe(
                Effect.andThen(attempt({ ...repaired, tunnel: true })),
              );
            }
            return Effect.fail(error);
          }),
        );
      });
    return attempt({ credential: false, tunnel: false }).pipe(
      Effect.timeoutOption(PEER_CALL_DEADLINE),
      Effect.flatMap(
        Option.match({
          onSome: (value) => Effect.succeed(value),
          onNone: () =>
            Effect.suspend((): Effect.Effect<never, PeerConnectionError> => {
              const connection = states.get(peerId)?.connection;
              return Effect.fail(
                connection == null
                  ? new PeerEnvironmentWaking({ peerId })
                  : new PeerEnvironmentUnreachable({
                      peerId: connection.peer.id,
                      detail: `the peer did not answer within ${Duration.format(PEER_CALL_DEADLINE)}; the same call can be repeated`,
                    }),
              );
            }),
        }),
      ),
    );
  };

  // A peer removed from the allowlist, or pointed at another host, must not
  // keep a tunnel to the old one until the idle timer gets to it, and its
  // entry must not outlive it.
  const reconcile = (peers: ReadonlyArray<PeerEnvironmentConfig>) =>
    Effect.forEach(
      [...states],
      ([peerId, state]) =>
        state.lock.withPermits(1)(
          Effect.gen(function* () {
            const configured = peers.find((peer) => peer.id === peerId);
            const held = state.connection?.peer ?? state.pending?.peer;
            if (configured !== undefined && (held === undefined || sameRoute(configured, held))) {
              return;
            }
            yield* discard(state);
            if (configured === undefined && states.get(peerId) === state) states.delete(peerId);
          }),
        ),
      { discard: true },
    );
  yield* settings.streamChanges.pipe(
    Stream.runForEach((next) => reconcile(next.peerEnvironments)),
    Effect.forkIn(serviceScope),
  );

  const listPeers = settings.getSettings.pipe(
    Effect.map((current) =>
      current.peerEnvironments.map((peer) => ({
        peerId: peer.id,
        label: peer.label,
        target: peer.target,
        connected: states.get(peer.id)?.connection != null,
      })),
    ),
  );

  const listThreads = (peerId: string) =>
    withPeer(peerId, (session) =>
      transport.shell(session).pipe(
        Effect.map((snapshot) => {
          const projectTitles = new Map(
            snapshot.projects.map((project) => [project.id, project.title]),
          );
          const threads = snapshot.threads
            .filter((thread) => thread.deletedAt === null && thread.archivedAt === null)
            .toSorted(
              (left, right) => right.updatedAt.epochMilliseconds - left.updatedAt.epochMilliseconds,
            );
          return {
            peerId: session.peer.id,
            threads: threads.slice(0, PEER_THREAD_LIST_LIMIT).map((thread) => ({
              threadId: thread.id,
              title: thread.title,
              projectId: thread.projectId,
              projectTitle: projectTitles.get(thread.projectId) ?? null,
              status: thread.status,
              awaitingInput: thread.pendingRuntimeRequest !== null,
              lastActivityAt: DateTime.formatIso(thread.updatedAt),
            })),
            total: threads.length,
            truncated: threads.length > PEER_THREAD_LIST_LIMIT,
          } satisfies PeerThreadList;
        }),
      ),
    ).pipe(Effect.withSpan("PeerEnvironmentService.listThreads"));

  const readThread = (peerId: string, threadId: ThreadId, options: { readonly limit: number }) =>
    withPeer(peerId, (session) =>
      transport.thread(session, threadId).pipe(
        Effect.map(({ projection, hasMoreHistory }) => {
          const limit = Math.min(Math.max(1, Math.trunc(options.limit)), PEER_MESSAGE_MAX_LIMIT);
          const messages = projection.messages.slice(-limit);
          return {
            peerId: session.peer.id,
            threadId: projection.thread.id,
            title: projection.thread.title,
            projectId: projection.thread.projectId,
            status: projection.runs.at(-1)?.status ?? "idle",
            awaitingInput: projection.runtimeRequests.some(
              (request) => request.status === "pending",
            ),
            messages: messages.map((message) => ({
              messageId: message.id,
              role: message.role,
              ...boundedText(message.text),
              streaming: message.streaming,
              createdAt: DateTime.formatIso(message.createdAt),
            })),
            hasEarlierMessages: hasMoreHistory || projection.messages.length > messages.length,
          } satisfies PeerThreadDetail;
        }),
      ),
    ).pipe(Effect.withSpan("PeerEnvironmentService.readThread"));

  const sendMessage = Effect.fn("PeerEnvironmentService.sendMessage")(function* (
    peerId: string,
    input: PeerSendInput,
  ) {
    if (input.attachments !== undefined && input.attachments.length > 0) {
      return yield* new PeerAttachmentsUnsupported({ peerId });
    }
    const identity = peerMessageIdentity({
      environmentId: input.sender.environmentId,
      threadId: input.sender.threadId,
      clientRequestId: input.clientRequestId,
    });
    return yield* withPeer(peerId, (session) =>
      Effect.gen(function* () {
        // The same rule as a send inside this environment: a caller may not
        // prompt a thread that runs with broader modes than its own.
        const target = (yield* transport.thread(session, input.threadId)).projection.thread;
        yield* resolveRuntimeMode(input.sender.runtimeMode, target.runtimeMode).pipe(
          Effect.andThen(
            resolveInteractionMode(input.sender.interactionMode, target.interactionMode),
          ),
          Effect.mapError(
            (denied) =>
              new PeerModeEscalationDenied({
                peerId: session.peer.id,
                threadId: input.threadId,
                detail: denied.message,
              }),
          ),
        );
        yield* transport.dispatch(session, {
          type: "message.dispatch",
          // An agent's MCP call, not the peer's user. `senderThreadId` is left
          // out: it names a thread in the receiving environment, and the
          // sender lives in this one.
          createdBy: "agent",
          creationSource: "mcp",
          commandId: identity.commandId,
          threadId: input.threadId,
          messageId: identity.messageId,
          text: input.text,
          attachments: [],
          // The peer decides against its own serialized state: start when the
          // thread is idle, otherwise steer or queue behind the active run.
          deliveryIntent: "auto",
          dispatchMode: { type: "start_immediately" },
        });
        return {
          peerId: session.peer.id,
          threadId: input.threadId,
          messageId: identity.messageId,
          accepted: true,
        } satisfies PeerSendResult;
      }),
    );
  });

  return PeerEnvironmentService.of({ listPeers, listThreads, readThread, sendMessage });
});

export const layer = Layer.effect(PeerEnvironmentService, make);
