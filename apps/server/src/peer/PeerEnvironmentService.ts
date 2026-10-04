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
  type ServerSettingsError,
  ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Predicate from "effect/Predicate";
import type * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import * as Settings from "../serverSettings.ts";
import {
  PeerAttachmentsUnsupported,
  type PeerCommandRejected,
  PeerEnvironmentNotConfigured,
  type PeerEnvironmentUnauthorized,
  type PeerEnvironmentUnreachable,
  type PeerProtocolMismatch,
  type PeerThreadNotFound,
} from "./PeerErrors.ts";
import * as PeerTransport from "./PeerTransport.ts";

/** How long an unused connection is kept before its tunnel is closed. */
const PEER_IDLE_RELEASE = Duration.minutes(10);
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
  /** The thread on this server that is sending. */
  readonly sender: { readonly environmentId: EnvironmentId; readonly threadId: ThreadId };
  /** Accepted only so a caller that passes attachments gets a clear refusal. */
  readonly attachments?: ReadonlyArray<unknown>;
}

type PeerConnectionError =
  | PeerEnvironmentNotConfigured
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
      PeerConnectionError | PeerCommandRejected | PeerAttachmentsUnsupported
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

interface PeerState {
  /** Serializes connect, re-pair, and release for one peer. */
  readonly lock: Semaphore.Semaphore;
  connection: Connection | null;
}

const sameRoute = (left: PeerEnvironmentConfig, right: PeerEnvironmentConfig) =>
  left.target === right.target &&
  left.port === right.port &&
  left.identityFile === right.identityFile;

const make = Effect.gen(function* () {
  const settings = yield* Settings.ServerSettingsService;
  const transport = yield* PeerTransport.PeerTransport;
  const serviceScope = yield* Scope.Scope;
  const states = new Map<PeerEnvironmentId, PeerState>();
  const idleMillis = Duration.toMillis(PEER_IDLE_RELEASE);

  const stateFor = (peerId: PeerEnvironmentId): PeerState => {
    const existing = states.get(peerId);
    if (existing !== undefined) return existing;
    const created: PeerState = { lock: Semaphore.makeUnsafe(1), connection: null };
    states.set(peerId, created);
    return created;
  };

  // Callers hold the peer's lock. Closing the scope ends the tunnel process;
  // the peer's server keeps running.
  const close = (state: PeerState, connection: Connection) =>
    Effect.suspend(() => {
      if (state.connection === connection) state.connection = null;
      return Scope.close(connection.scope, Exit.void);
    });

  const drop = (state: PeerState, connection: Connection) =>
    state.lock.withPermits(1)(close(state, connection));

  /**
   * Closes the connection once it has gone unused for the idle period. The
   * check and the close run under the peer's lock, so a caller arriving at
   * that moment either refreshes the connection first or reconnects after.
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
        yield* state.lock.withPermits(1)(
          Effect.gen(function* () {
            const checkedAt = yield* Clock.currentTimeMillis;
            if (state.connection !== connection) return;
            if (checkedAt - connection.lastUsedAt < idleMillis) return;
            yield* close(state, connection);
          }),
        );
      }
    });

  /**
   * Opens the tunnel and pairs. Only the network work is interruptible: the
   * scope is closed on any failure or interruption, and a finished connection
   * is recorded before interruption can be observed, so no tunnel is left
   * without an owner to release it.
   */
  const connect = (state: PeerState, peer: PeerEnvironmentConfig) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const scope = yield* Scope.fork(serviceScope);
        const exit = yield* Effect.exit(
          restore(
            Effect.gen(function* () {
              const link = yield* transport.open(peer).pipe(Scope.provide(scope));
              const bearer = yield* transport.authorize(peer, link);
              return { link, bearer };
            }),
          ),
        );
        if (Exit.isFailure(exit)) {
          yield* Scope.close(scope, exit);
          return yield* Effect.failCause(exit.cause);
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
        // interruptible, or closing the service would wait out its sleep.
        yield* releaseWhenIdle(state, connection).pipe(
          Effect.interruptible,
          Effect.forkIn(serviceScope),
        );
        return connection;
      }),
    );

  /** The peer's one connection, opened here when there is none. */
  const checkout = (state: PeerState, peer: PeerEnvironmentConfig) =>
    state.lock.withPermits(1)(
      Effect.gen(function* () {
        const current = state.connection;
        if (current !== null && sameRoute(current.peer, peer)) {
          current.lastUsedAt = yield* Clock.currentTimeMillis;
          return current;
        }
        // The peer was re-pointed in settings: the old tunnel leads elsewhere.
        if (current !== null) yield* close(state, current);
        return yield* connect(state, peer);
      }),
    );

  // Pair again only if nobody replaced the refused bearer in the meantime.
  const repair = (state: PeerState, connection: Connection, refused: Redacted.Redacted<string>) =>
    state.lock.withPermits(1)(
      Effect.gen(function* () {
        if (state.connection !== connection || connection.bearer !== refused) return;
        connection.bearer = yield* transport.authorize(connection.peer, connection.link);
      }),
    );

  const touch = (connection: Connection) =>
    Clock.currentTimeMillis.pipe(
      Effect.map((now) => {
        connection.lastUsedAt = now;
      }),
    );

  const requirePeer = Effect.fn("PeerEnvironmentService.requirePeer")(function* (peerId: string) {
    const current = yield* settings.getSettings;
    const peer = current.peerEnvironments.find((candidate) => candidate.id === peerId);
    if (peer === undefined) return yield* new PeerEnvironmentNotConfigured({ peerId });
    return peer;
  });

  /**
   * Runs one operation against a configured peer. A refused credential is
   * replaced by pairing again, and a dead tunnel by reconnecting, each at
   * most once per call; a second failure of the same kind is returned.
   */
  const withPeer = <A, E>(
    peerId: string,
    operation: (
      session: PeerTransport.PeerSession,
    ) => Effect.Effect<A, E | PeerEnvironmentUnauthorized | PeerEnvironmentUnreachable>,
  ): Effect.Effect<A, E | PeerConnectionError> =>
    Effect.gen(function* () {
      const peer = yield* requirePeer(peerId);
      const state = stateFor(peer.id);
      const attempt = (repaired: {
        readonly credential: boolean;
        readonly tunnel: boolean;
      }): Effect.Effect<A, E | PeerConnectionError> =>
        Effect.gen(function* () {
          const connection = yield* checkout(state, peer);
          const bearer = connection.bearer;
          return yield* operation({ peer, link: connection.link, bearer }).pipe(
            Effect.ensuring(touch(connection)),
            Effect.catch((error): Effect.Effect<A, E | PeerConnectionError> => {
              if (
                !repaired.credential &&
                Predicate.isTagged(error, "PeerEnvironmentUnauthorized")
              ) {
                return repair(state, connection, bearer).pipe(
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
      return yield* attempt({ credential: false, tunnel: false });
    });

  // A peer removed from the allowlist, or pointed at another host, must not
  // keep a tunnel to the old one until the idle timer gets to it.
  const reconcile = (peers: ReadonlyArray<PeerEnvironmentConfig>) =>
    Effect.forEach(
      [...states.values()],
      (state) =>
        state.lock.withPermits(1)(
          Effect.suspend(() => {
            const connection = state.connection;
            if (connection === null) return Effect.void;
            const configured = peers.find((peer) => peer.id === connection.peer.id);
            return configured !== undefined && sameRoute(configured, connection.peer)
              ? Effect.void
              : close(state, connection);
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
      transport
        .dispatch(session, {
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
        })
        .pipe(
          Effect.as({
            peerId: session.peer.id,
            threadId: input.threadId,
            messageId: identity.messageId,
            accepted: true,
          } satisfies PeerSendResult),
        ),
    );
  });

  return PeerEnvironmentService.of({ listPeers, listThreads, readThread, sendMessage });
});

export const layer = Layer.effect(PeerEnvironmentService, make);
