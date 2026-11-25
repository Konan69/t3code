/**
 * PeerTransport - The wire to another T3 environment.
 *
 * Everything that touches SSH, the forwarded port, or the peer's HTTP and
 * WebSocket API lives behind this service, so `PeerEnvironmentService` can own
 * connection lifetime and retries without a network, and tests can swap the
 * wire for a fake.
 *
 * @module PeerTransport
 */
import * as NodeSocket from "@effect/platform-node/NodeSocket";
import {
  AuthAccessTokenType,
  AuthEnvironmentBootstrapTokenType,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthTokenExchangeGrantType,
  EnvironmentHttpApi,
  ORCHESTRATION_PROTOCOL_HEADER,
  ORCHESTRATION_PROTOCOL_QUERY_PARAM,
  ORCHESTRATION_PROTOCOL_VERSION,
  ORCHESTRATION_PROTOCOL_VERSION_TEXT,
  environmentOrchestrationProtocolVersion,
  type ExecutionEnvironmentDescriptor,
  ORCHESTRATION_V2_WS_METHODS,
  type OrchestrationV2Command,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type PeerEnvironmentConfig,
  type ThreadId,
  WsRpcGroup,
} from "@t3tools/contracts";
import * as NetService from "@t3tools/shared/Net";
import { encodeOAuthScope } from "@t3tools/shared/oauthScope";
import { resolveSshTarget, targetConnectionKey } from "@t3tools/ssh/command";
import {
  issueRemotePairingToken,
  launchOrReuseRemoteServer,
  REMOTE_ATTACH_NOT_RUNNING_EXIT,
  type RemoteT3RunnerOptions,
  startSshTunnel,
} from "@t3tools/ssh/tunnel";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { HttpClient, HttpClientError } from "effect/http";
import * as HttpApiClient from "effect/http-api/HttpApiClient";
import { ChildProcessSpawner } from "effect/process";
import * as RpcClient from "effect/rpc/RpcClient";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as Socket from "effect/socket/Socket";

import {
  PeerCommandRejected,
  PeerEnvironmentUnauthorized,
  PeerEnvironmentUnreachable,
  PeerProtocolMismatch,
  PeerThreadNotFound,
} from "./PeerErrors.ts";

/** Loopback ends of the tunnel to the peer's server. */
export interface PeerLink {
  readonly httpBaseUrl: string;
  readonly wsBaseUrl: string;
}

/** What one request to the peer needs: who, through which tunnel, as whom. */
export interface PeerSession {
  readonly peer: PeerEnvironmentConfig;
  readonly link: PeerLink;
  readonly bearer: Redacted.Redacted<string>;
}

/** A thread's projection as the peer returned it, with its paging flag. */
export interface PeerThreadSnapshot {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly hasMoreHistory: boolean;
}

export type PeerDispatchCommand = Extract<
  OrchestrationV2Command,
  { readonly type: "message.dispatch" }
>;

type PeerRequestError =
  | PeerEnvironmentUnreachable
  | PeerEnvironmentUnauthorized
  | PeerProtocolMismatch;

export class PeerTransport extends Context.Service<
  PeerTransport,
  {
    /**
     * Finds the T3 server running on the peer and forwards a loopback port to
     * it; fails when none is running. The tunnel is owned by the caller's scope; closing it ends the SSH
     * process and leaves the peer's server and its threads running.
     */
    readonly open: (
      peer: PeerEnvironmentConfig,
    ) => Effect.Effect<PeerLink, PeerEnvironmentUnreachable, Scope.Scope>;
    /**
     * Mints a one-time pairing credential on the peer over SSH and exchanges
     * it for a bearer limited to reading and operating orchestration.
     */
    readonly authorize: (
      peer: PeerEnvironmentConfig,
      link: PeerLink,
    ) => Effect.Effect<Redacted.Redacted<string>, PeerRequestError>;
    readonly shell: (
      session: PeerSession,
    ) => Effect.Effect<OrchestrationV2ShellSnapshot, PeerRequestError>;
    readonly thread: (
      session: PeerSession,
      threadId: ThreadId,
    ) => Effect.Effect<PeerThreadSnapshot, PeerRequestError | PeerThreadNotFound>;
    /** Succeeds once the peer has accepted the command; the turn runs on after that. */
    readonly dispatch: (
      session: PeerSession,
      command: PeerDispatchCommand,
    ) => Effect.Effect<void, PeerRequestError | PeerCommandRejected>;
  }
>()("t3/peer/PeerTransport") {}

const REQUEST_TIMEOUT = "30 seconds";
const DISPATCH_TIMEOUT = "30 seconds";
const SOCKET_OPEN_TIMEOUT = "15 seconds";
const DETAIL_LIMIT = 300;

// A server has no one to type a password, so SSH either authenticates with a
// key or fails. BatchMode also keeps a host-key prompt from hanging the call.
const sshAuth = (peer: PeerEnvironmentConfig) => ({
  batchMode: "yes" as const,
  interactiveAuth: false,
  ...(peer.identityFile === undefined ? {} : { identityFile: peer.identityFile }),
});

// This server is a guest on the peer: it attaches to the T3 server already
// running there and never installs, starts, stops, or restarts one. A peer
// with no server running is reported as unreachable.
const runner: RemoteT3RunnerOptions = { preserveRunningServer: true };

/** The last line a person would read, bounded so tool output stays small. */
function summarize(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .findLast((entry) => entry.length > 0);
  return (line ?? "no detail was reported").slice(0, DETAIL_LIMIT);
}

const NOT_RUNNING_DETAIL =
  "T3 is not running on that machine, and this server does not start it. Opening that environment in the T3 app starts it; then call again.";

function sshFailureDetail(cause: unknown): string {
  if (Predicate.isTagged(cause, "SshCommandError")) {
    const { stderr, message, exitCode } = cause as unknown as {
      stderr: string;
      message: string;
      exitCode: number | null;
    };
    if (exitCode === REMOTE_ATTACH_NOT_RUNNING_EXIT) return NOT_RUNNING_DETAIL;
    return summarize(stderr.trim().length > 0 ? stderr : message);
  }
  return summarize(cause instanceof Error ? cause.message : String(cause));
}

/**
 * Sorts a failed request into the three outcomes callers handle differently:
 * the credential was refused, the peer speaks another contract, or nothing
 * usable answered. Declared API errors arrive as tagged values; anything the
 * contract does not declare arrives as an `HttpClientError` with the response.
 */
function classifyRequestFailure(peer: PeerEnvironmentConfig, cause: unknown): PeerRequestError {
  const peerId = peer.id;
  if (
    Predicate.isTagged(cause, "PeerEnvironmentUnreachable") ||
    Predicate.isTagged(cause, "PeerEnvironmentUnauthorized") ||
    Predicate.isTagged(cause, "PeerProtocolMismatch")
  ) {
    return cause as unknown as PeerRequestError;
  }
  if (
    Predicate.isTagged(cause, "EnvironmentAuthInvalidError") ||
    Predicate.isTagged(cause, "EnvironmentHttpUnauthorizedError") ||
    Predicate.isTagged(cause, "EnvironmentScopeRequiredError") ||
    Predicate.isTagged(cause, "EnvironmentOperationForbiddenError") ||
    Predicate.isTagged(cause, "EnvironmentHttpForbiddenError") ||
    Predicate.isTagged(cause, "EnvironmentAuthorizationError")
  ) {
    return new PeerEnvironmentUnauthorized({ peerId, detail: "the peer refused the credential" });
  }
  if (Schema.isSchemaError(cause) || Predicate.isTagged(cause, "EnvironmentRequestInvalidError")) {
    return new PeerProtocolMismatch({
      peerId,
      detail: "its response did not match this server's contract",
    });
  }
  if (HttpClientError.isHttpClientError(cause) && cause.response !== undefined) {
    const status = cause.response.status;
    if (status === 401 || status === 403) {
      return new PeerEnvironmentUnauthorized({ peerId, detail: `HTTP ${status}` });
    }
    if (status >= 500) {
      return new PeerEnvironmentUnreachable({ peerId, detail: `the peer answered HTTP ${status}` });
    }
    return new PeerProtocolMismatch({
      peerId,
      detail:
        status >= 200 && status < 300
          ? "its response did not match this server's contract"
          : `it answered HTTP ${status} to a request this server's contract defines`,
    });
  }
  if (Predicate.isTagged(cause, "EnvironmentInternalError")) {
    return new PeerEnvironmentUnreachable({
      peerId,
      detail: "the peer reported an internal error",
    });
  }
  return new PeerEnvironmentUnreachable({
    peerId,
    detail: "the tunnel to the peer stopped answering",
  });
}

/**
 * Where the command socket connects. The peer refuses the upgrade with HTTP
 * 426 unless the URL names the orchestration protocol this build speaks.
 */
export function peerSocketUrl(link: PeerLink, ticket: string): string {
  const url = new URL(link.wsBaseUrl);
  url.pathname = "/ws";
  url.searchParams.set("wsTicket", ticket);
  url.searchParams.set(ORCHESTRATION_PROTOCOL_QUERY_PARAM, String(ORCHESTRATION_PROTOCOL_VERSION));
  return url.toString();
}

/**
 * The peer speaks another orchestration protocol than this build: pairing
 * with it would write a credential its server reads differently, and it would
 * refuse the command socket. A descriptor that names no protocol is a server
 * from before negotiation, counted the way the clients count it.
 */
export function peerProtocolMismatch(
  peer: PeerEnvironmentConfig,
  descriptor: Pick<
    ExecutionEnvironmentDescriptor,
    "orchestrationProtocolVersion" | "serverVersion"
  >,
): PeerProtocolMismatch | null {
  const protocol = environmentOrchestrationProtocolVersion(descriptor);
  return protocol === ORCHESTRATION_PROTOCOL_VERSION
    ? null
    : new PeerProtocolMismatch({
        peerId: peer.id,
        detail: `it speaks orchestration protocol ${protocol} (T3 ${descriptor.serverVersion}), this server speaks ${ORCHESTRATION_PROTOCOL_VERSION}`,
      });
}

/**
 * Whether the peer refuses the command socket for its protocol. The WebSocket
 * client does not expose the status of a refused upgrade, so after a failed
 * open the same URL, without a ticket, is asked over plain HTTP: the peer
 * checks the protocol before anything else and answers 426.
 */
export const refusesSocketProtocol = (httpClient: HttpClient.HttpClient, link: PeerLink) =>
  httpClient.get(peerSocketUrl(link, "").replace(/^ws/u, "http")).pipe(
    Effect.map((response) => response.status === 426),
    Effect.timeoutOption("5 seconds"),
    Effect.map(Option.getOrElse(() => false)),
    Effect.orElseSucceed(() => false),
  );

/** A route this build expects that the peer answered with a bare 404. */
const isUndeclaredNotFound = (cause: unknown) =>
  HttpClientError.isHttpClientError(cause) && cause.response?.status === 404;

const make = Effect.gen(function* () {
  const httpClient = yield* HttpClient.HttpClient;
  const net = yield* NetService.NetService;
  const sshContext = yield* Effect.context<
    | ChildProcessSpawner.ChildProcessSpawner
    | FileSystem.FileSystem
    | Path.Path
    | HttpClient.HttpClient
    | NetService.NetService
  >();

  // `ssh -G` reads the local SSH config; it does not connect. Resolving the
  // alias the way the desktop app does yields the same remote state directory,
  // so both clients reuse one server on the peer.
  const resolveTarget = (peer: PeerEnvironmentConfig) =>
    resolveSshTarget(peer.target).pipe(
      Effect.map((target) => ({ ...target, port: peer.port ?? target.port })),
    );

  const unreachable = (peer: PeerEnvironmentConfig) => (cause: unknown) =>
    new PeerEnvironmentUnreachable({ peerId: peer.id, detail: sshFailureDetail(cause) });

  const open = Effect.fn("PeerTransport.open")(function* (peer: PeerEnvironmentConfig) {
    const target = yield* resolveTarget(peer);
    const launch = yield* launchOrReuseRemoteServer(target, sshAuth(peer), runner);
    const localPort = yield* net.reserveLoopbackPort();
    const link: PeerLink = {
      httpBaseUrl: `http://127.0.0.1:${localPort}/`,
      wsBaseUrl: `ws://127.0.0.1:${localPort}/`,
    };
    yield* startSshTunnel({
      key: targetConnectionKey(target),
      resolvedTarget: target,
      remotePort: launch.remotePort,
      localPort,
      httpBaseUrl: link.httpBaseUrl,
      wsBaseUrl: link.wsBaseUrl,
      authOptions: sshAuth(peer),
      remoteServerKind: launch.remoteServerKind,
      // The tunnel lives as long as the caller's scope.
      scope: yield* Scope.fork(yield* Effect.scope, "sequential"),
    });
    return link;
  });

  const apiGroup = <Group extends keyof typeof EnvironmentHttpApi.groups>(
    link: PeerLink,
    group: Group,
  ) => HttpApiClient.group(EnvironmentHttpApi, { httpClient, group, baseUrl: link.httpBaseUrl });

  const headers = (session: PeerSession) =>
    ({
      authorization: `Bearer ${Redacted.value(session.bearer)}`,
      [ORCHESTRATION_PROTOCOL_HEADER]: ORCHESTRATION_PROTOCOL_VERSION_TEXT,
    }) as const;

  // Every failure of a request is folded into the three request errors, plus
  // whatever the caller already narrowed (a missing thread, a rejected
  // command), and a request that outlives its budget counts as unreachable.
  const request = <A, E, R, Kept = never>(
    peer: PeerEnvironmentConfig,
    timeout: typeof REQUEST_TIMEOUT | typeof DISPATCH_TIMEOUT,
    effect: Effect.Effect<A, E, R>,
    keep: (cause: unknown) => Option.Option<Kept> = () => Option.none(),
  ): Effect.Effect<A, PeerRequestError | Kept, R> =>
    effect.pipe(
      Effect.timeoutOption(timeout),
      Effect.mapError((cause): PeerRequestError | Kept =>
        Option.getOrElse(keep(cause), () => classifyRequestFailure(peer, cause)),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(
              new PeerEnvironmentUnreachable({
                peerId: peer.id,
                detail: `the peer did not answer within ${timeout}`,
              }),
            ),
          onSome: (value: A) => Effect.succeed(value),
        }),
      ),
    );

  const authorize = Effect.fn("PeerTransport.authorize")(function* (
    peer: PeerEnvironmentConfig,
    link: PeerLink,
  ) {
    // Checked before pairing: a peer on another orchestration protocol would
    // refuse the command socket, and no credential changes that.
    const metadata = yield* apiGroup(link, "metadata");
    const descriptor = yield* request(peer, REQUEST_TIMEOUT, metadata.descriptor());
    const mismatch = peerProtocolMismatch(peer, descriptor);
    if (mismatch !== null) return yield* mismatch;
    const target = yield* resolveTarget(peer).pipe(Effect.mapError(unreachable(peer)));
    const pairing = yield* issueRemotePairingToken(target, sshAuth(peer), runner).pipe(
      Effect.mapError(unreachable(peer)),
    );
    const auth = yield* apiGroup(link, "auth");
    const token = yield* request(
      peer,
      REQUEST_TIMEOUT,
      auth.token({
        headers: {},
        payload: {
          grant_type: AuthTokenExchangeGrantType,
          subject_token: pairing.credential,
          subject_token_type: AuthEnvironmentBootstrapTokenType,
          requested_token_type: AuthAccessTokenType,
          scope: encodeOAuthScope([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
        },
      }),
    );
    return Redacted.make(token.access_token);
  });

  const shell = Effect.fn("PeerTransport.shell")(function* (session: PeerSession) {
    const orchestration = yield* apiGroup(session.link, "orchestration");
    return yield* request(
      session.peer,
      REQUEST_TIMEOUT,
      orchestration.shellSnapshot({ headers: headers(session) }),
    );
  });

  const thread = Effect.fn("PeerTransport.thread")(function* (
    session: PeerSession,
    threadId: ThreadId,
  ) {
    const orchestration = yield* apiGroup(session.link, "orchestration");
    const missing = (cause: unknown) =>
      Predicate.isTagged(cause, "EnvironmentResourceNotFoundError")
        ? Option.some(new PeerThreadNotFound({ peerId: session.peer.id, threadId }))
        : Option.none();
    const input = { params: { threadId }, headers: headers(session) };
    // The bounded route keeps a long thread from costing megabytes. A peer
    // that predates it answers a bare 404, and the full snapshot still works.
    return yield* orchestration.threadBoundedSnapshot(input).pipe(
      Effect.map((snapshot): PeerThreadSnapshot => ({
        projection: snapshot.projection,
        hasMoreHistory: snapshot.hasMoreHistory,
      })),
      Effect.catchIf(isUndeclaredNotFound, () =>
        orchestration.threadSnapshot(input).pipe(
          Effect.map((snapshot): PeerThreadSnapshot => ({
            projection: snapshot.projection,
            hasMoreHistory: snapshot.hasMoreHistory === true,
          })),
        ),
      ),
      (effect) => request(session.peer, REQUEST_TIMEOUT, effect, missing),
    );
  });

  const dispatch = Effect.fn("PeerTransport.dispatch")(function* (
    session: PeerSession,
    command: PeerDispatchCommand,
  ) {
    const rejected = (cause: unknown) => {
      if (!Predicate.isTagged(cause, "OrchestrationV2DispatchCommandError")) return Option.none();
      const { detail, message } = cause as unknown as { detail?: string; message: string };
      return Option.some(
        new PeerCommandRejected({
          peerId: session.peer.id,
          threadId: command.threadId,
          detail: summarize(detail ?? message),
        }),
      );
    };
    // The environment API has no HTTP route for commands, so the prompt goes
    // over the same typed WebSocket RPC the clients use. One socket per send:
    // a ticket is single use, and holding a socket open would keep a
    // subscription-shaped connection alive on a machine billed while awake.
    const send = Effect.gen(function* () {
      const auth = yield* apiGroup(session.link, "auth");
      const issued = yield* auth.webSocketTicket({
        headers: { authorization: `Bearer ${Redacted.value(session.bearer)}` },
      });
      const protocol = yield* Layer.build(
        Layer.effect(
          RpcClient.Protocol,
          RpcClient.makeProtocolSocket({
            retryTransientErrors: false,
            retryPolicy: Schedule.recurs(0),
          }),
        ).pipe(
          Layer.provide(
            Layer.mergeAll(
              Socket.layerWebSocket(peerSocketUrl(session.link, issued.ticket), {
                openTimeout: SOCKET_OPEN_TIMEOUT,
              }).pipe(Layer.provide(NodeSocket.layerWebSocketConstructor)),
              RpcSerialization.layerJson,
            ),
          ),
        ),
      );
      const client = yield* RpcClient.make(WsRpcGroup).pipe(Effect.provide(protocol));
      yield* client[ORCHESTRATION_V2_WS_METHODS.dispatchCommand](command);
    });
    return yield* request(session.peer, DISPATCH_TIMEOUT, Effect.scoped(send), rejected).pipe(
      // A refused upgrade looks like a dead tunnel. Reconnecting cannot cure a
      // protocol refusal, so it is told apart here, by status.
      Effect.catchTags({
        PeerEnvironmentUnreachable: (error) =>
          refusesSocketProtocol(httpClient, session.link).pipe(
            Effect.flatMap((refused) =>
              Effect.fail(
                refused
                  ? new PeerProtocolMismatch({
                      peerId: session.peer.id,
                      detail:
                        "it refused the command socket for this server's orchestration protocol",
                    })
                  : error,
              ),
            ),
          ),
      }),
    );
  });

  return PeerTransport.of({
    open: (peer) => open(peer).pipe(Effect.mapError(unreachable(peer)), Effect.provide(sshContext)),
    authorize: (peer, link) => authorize(peer, link).pipe(Effect.provide(sshContext)),
    shell,
    thread,
    dispatch,
  });
});

export const layer = Layer.effect(PeerTransport, make);
