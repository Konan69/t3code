import { assert, describe, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ShellSnapshot,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  PeerEnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as TestClock from "effect/testing/TestClock";

import * as Settings from "../serverSettings.ts";
import * as PeerEnvironmentService from "./PeerEnvironmentService.ts";
import {
  PeerEnvironmentUnauthorized,
  PeerEnvironmentUnreachable,
  PeerThreadNotFound,
} from "./PeerErrors.ts";
import * as PeerTransport from "./PeerTransport.ts";

const BOAT = PeerEnvironmentId.make("boat");
const boat = { id: BOAT, label: "Boat box", target: "boat" };
const sender = {
  environmentId: EnvironmentId.make("environment-local"),
  threadId: ThreadId.make("thread-local"),
};
const NOW = DateTime.makeUnsafe("2026-10-04T00:00:00.000Z");

const emptyShell: OrchestrationV2ShellSnapshot = {
  schemaVersion: 1,
  snapshotSequence: 0,
  threads: [],
  archivedThreads: [],
  projects: [],
};

const threadShell = (
  id: string,
  overrides: Partial<OrchestrationV2ThreadShell> = {},
): OrchestrationV2ThreadShell => {
  const threadId = ThreadId.make(id);
  return {
    id: threadId,
    projectId: ProjectId.make("project-1"),
    title: id,
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    activeRunId: null,
    latestRunId: null,
    status: "idle",
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    providerInstanceHistory: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
    ...overrides,
  };
};

const message = (id: string, text: string): OrchestrationV2ConversationMessage => ({
  id: MessageId.make(id),
  threadId: ThreadId.make("thread-remote"),
  createdBy: "agent",
  creationSource: "provider",
  runId: null,
  nodeId: null,
  role: "assistant",
  text,
  attachments: [],
  streaming: false,
  createdAt: NOW,
  updatedAt: NOW,
});

const projection = (
  messages: ReadonlyArray<OrchestrationV2ConversationMessage>,
): OrchestrationV2ThreadProjection => {
  const threadId = ThreadId.make("thread-remote");
  return {
    thread: {
      id: threadId,
      projectId: ProjectId.make("project-1"),
      title: "Remote work",
      providerInstanceId: ProviderInstanceId.make("codex"),
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      activeProviderThreadId: null,
      lineage: { rootThreadId: threadId, parentThreadId: null, relationshipToParent: null },
      forkedFrom: null,
      createdBy: "user",
      creationSource: "web",
      createdAt: NOW,
      updatedAt: NOW,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
    runs: [],
    attempts: [],
    nodes: [],
    subagents: [],
    providerSessions: [],
    providerThreads: [],
    providerTurns: [],
    runtimeRequests: [],
    messages,
    plans: [],
    turnItems: [],
    checkpointScopes: [],
    checkpoints: [],
    contextHandoffs: [],
    contextTransfers: [],
    visibleTurnItems: [],
    updatedAt: NOW,
  };
};

type Transport = PeerTransport.PeerTransport["Service"];

/**
 * A wire that never leaves the process. It counts what the service asked of
 * it, and each request can be scripted to fail the way a real peer would.
 */
const makeWire = (script: Partial<Pick<Transport, "open" | "shell" | "thread">> = {}) => {
  const seen = {
    opened: 0,
    closed: 0,
    paired: 0,
    bearers: [] as string[],
    dispatched: [] as PeerTransport.PeerDispatchCommand[],
  };
  const transport: Transport = {
    open: (peer) =>
      Effect.gen(function* () {
        seen.opened += 1;
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            seen.closed += 1;
          }),
        );
        return script.open === undefined
          ? { httpBaseUrl: "http://127.0.0.1:1/", wsBaseUrl: "ws://127.0.0.1:1/" }
          : yield* script.open(peer);
      }),
    authorize: () =>
      Effect.sync(() => {
        seen.paired += 1;
        return Redacted.make(`bearer-${seen.paired}`);
      }),
    shell: (session) =>
      Effect.suspend(() => {
        seen.bearers.push(Redacted.value(session.bearer));
        return script.shell === undefined ? Effect.succeed(emptyShell) : script.shell(session);
      }),
    thread: (session, threadId) =>
      script.thread === undefined
        ? Effect.fail(new PeerThreadNotFound({ peerId: session.peer.id, threadId }))
        : script.thread(session, threadId),
    dispatch: (_session, command) =>
      Effect.sync(() => {
        seen.dispatched.push(command);
      }),
  };
  return {
    seen,
    layer: PeerEnvironmentService.layer.pipe(
      Layer.provide(Layer.succeed(PeerTransport.PeerTransport, transport)),
      Layer.provide(Settings.layerTest({ peerEnvironments: [boat] })),
    ),
  };
};

const unauthorized = new PeerEnvironmentUnauthorized({ peerId: BOAT, detail: "HTTP 401" });
const unreachable = new PeerEnvironmentUnreachable({ peerId: BOAT, detail: "tunnel closed" });

describe("PeerEnvironmentService connection lifetime", () => {
  it.effect("lists configured peers without opening a connection", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      assert.deepStrictEqual(yield* peers.listPeers, [
        { peerId: BOAT, label: "Boat box", target: "boat", connected: false },
      ]);
      assert.strictEqual(wire.seen.opened, 0);
      assert.strictEqual(wire.seen.paired, 0);

      yield* peers.listThreads("boat");
      assert.strictEqual((yield* peers.listPeers)[0]?.connected, true);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("refuses a peer that is not in the allowlist before any SSH", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const error = yield* peers.listThreads("someone-else").pipe(Effect.flip);
      assert.strictEqual(error._tag, "PeerEnvironmentNotConfigured");
      assert.strictEqual(wire.seen.opened, 0);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("shares one connect between callers that arrive together", () => {
    const connecting = Deferred.makeUnsafe<void>();
    const gate = Deferred.makeUnsafe<void>();
    const wire = makeWire({
      open: () =>
        Deferred.succeed(connecting, undefined).pipe(
          Effect.andThen(Deferred.await(gate)),
          Effect.as({ httpBaseUrl: "http://127.0.0.1:1/", wsBaseUrl: "ws://127.0.0.1:1/" }),
        ),
    });
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const first = yield* peers.listThreads("boat").pipe(Effect.forkChild);
      yield* Deferred.await(connecting);
      // The second caller arrives while the first is still connecting, and is
      // given time to start a connect of its own if nothing stopped it.
      const second = yield* peers.listThreads("boat").pipe(Effect.forkChild);
      yield* Effect.forEach(Array.from({ length: 50 }), () => Effect.yieldNow, { discard: true });
      assert.strictEqual(wire.seen.opened, 1);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.strictEqual(wire.seen.opened, 1);
      assert.strictEqual(wire.seen.paired, 1);
      assert.deepStrictEqual(wire.seen.bearers, ["bearer-1", "bearer-1"]);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("closes an unused connection after the idle period and reconnects on demand", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      yield* peers.listThreads("boat");

      // Use within the idle period keeps the tunnel and restarts the countdown.
      yield* TestClock.adjust("9 minutes");
      yield* peers.listThreads("boat");
      yield* TestClock.adjust("9 minutes");
      assert.strictEqual(wire.seen.closed, 0);
      assert.strictEqual(wire.seen.opened, 1);

      yield* TestClock.adjust("1 minute");
      assert.strictEqual(wire.seen.closed, 1);
      assert.strictEqual((yield* peers.listPeers)[0]?.connected, false);

      yield* peers.listThreads("boat");
      assert.strictEqual(wire.seen.opened, 2);
      assert.strictEqual(wire.seen.paired, 2);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("pairs again once when the peer refuses the bearer", () => {
    let refusals = 1;
    const wire = makeWire({
      shell: () =>
        Effect.suspend(() =>
          refusals-- > 0 ? Effect.fail(unauthorized) : Effect.succeed(emptyShell),
        ),
    });
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      yield* peers.listThreads("boat");
      // The retry carries the new bearer over the same tunnel.
      assert.deepStrictEqual(wire.seen.bearers, ["bearer-1", "bearer-2"]);
      assert.strictEqual(wire.seen.opened, 1);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("reports unauthorized when a fresh pairing is refused too", () => {
    const wire = makeWire({ shell: () => Effect.fail(unauthorized) });
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const error = yield* peers.listThreads("boat").pipe(Effect.flip);
      assert.strictEqual(error._tag, "PeerEnvironmentUnauthorized");
      assert.strictEqual(wire.seen.paired, 2);
      assert.strictEqual(wire.seen.bearers.length, 2);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("reconnects once when the tunnel dies, then reports unreachable", () => {
    let failures = 1;
    const wire = makeWire({
      shell: () =>
        Effect.suspend(() =>
          failures-- > 0 ? Effect.fail(unreachable) : Effect.succeed(emptyShell),
        ),
    });
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      yield* peers.listThreads("boat");
      assert.strictEqual(wire.seen.opened, 2);
      assert.strictEqual(wire.seen.closed, 1);

      failures = 2;
      const error = yield* peers.listThreads("boat").pipe(Effect.flip);
      assert.strictEqual(error._tag, "PeerEnvironmentUnreachable");
      // One reconnect for the call, not one per failure.
      assert.strictEqual(wire.seen.opened, 3);
    }).pipe(Effect.provide(wire.layer));
  });
});

describe("PeerEnvironmentService.sendMessage", () => {
  it.effect("a retried request reuses the command and message ids", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const send = (clientRequestId: string) =>
        peers.sendMessage("boat", {
          threadId: ThreadId.make("thread-remote"),
          text: "run the migration",
          clientRequestId,
          sender,
        });
      const first = yield* send("request-1");
      const retried = yield* send("request-1");
      const other = yield* send("request-2");

      const [a, b, c] = wire.seen.dispatched;
      assert.strictEqual(a?.commandId, b?.commandId);
      assert.strictEqual(a?.messageId, b?.messageId);
      assert.notStrictEqual(a?.commandId, c?.commandId);
      assert.strictEqual(first.messageId, retried.messageId);
      assert.notStrictEqual(first.messageId, other.messageId);
      assert.strictEqual(first.messageId, a?.messageId);
      assert.strictEqual(first.accepted, true);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("two local threads using the same request key do not collide", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const send = (threadId: string) =>
        peers.sendMessage("boat", {
          threadId: ThreadId.make("thread-remote"),
          text: "status?",
          clientRequestId: "request-1",
          sender: { ...sender, threadId: ThreadId.make(threadId) },
        });
      yield* send("thread-a");
      yield* send("thread-b");
      const [a, b] = wire.seen.dispatched;
      assert.notStrictEqual(a?.commandId, b?.commandId);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("sends as an agent over MCP, never as the peer's user", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      yield* peers.sendMessage("boat", {
        threadId: ThreadId.make("thread-remote"),
        text: "status?",
        clientRequestId: "request-1",
        sender,
      });
      const [command] = wire.seen.dispatched;
      assert.strictEqual(command?.createdBy, "agent");
      assert.strictEqual(command?.creationSource, "mcp");
      assert.deepStrictEqual(command?.attachments, []);
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("rejects attachments without connecting", () => {
    const wire = makeWire();
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const error = yield* peers
        .sendMessage("boat", {
          threadId: ThreadId.make("thread-remote"),
          text: "look at this",
          clientRequestId: "request-1",
          sender,
          attachments: [{ path: "/home/me/screenshot.png" }],
        })
        .pipe(Effect.flip);
      assert.strictEqual(error._tag, "PeerAttachmentsUnsupported");
      assert.strictEqual(wire.seen.opened, 0);
      assert.strictEqual(wire.seen.dispatched.length, 0);
    }).pipe(Effect.provide(wire.layer));
  });
});

describe("PeerEnvironmentService reads", () => {
  it.effect("lists the most recently active threads and leaves archived ones out", () => {
    const threads = Array.from({ length: 60 }, (_, index) =>
      threadShell(`thread-${index}`, {
        updatedAt: DateTime.makeUnsafe(Date.UTC(2026, 9, 1) + index * 60_000),
        ...(index === 59 ? { archivedAt: NOW } : {}),
      }),
    );
    const wire = makeWire({
      shell: () => Effect.succeed({ ...emptyShell, threads }),
    });
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const list = yield* peers.listThreads("boat");
      assert.strictEqual(list.threads.length, PeerEnvironmentService.PEER_THREAD_LIST_LIMIT);
      assert.strictEqual(list.total, 59);
      assert.strictEqual(list.truncated, true);
      assert.strictEqual(list.threads[0]?.threadId, "thread-58");
      assert.strictEqual(list.threads.at(-1)?.threadId, "thread-9");
    }).pipe(Effect.provide(wire.layer));
  });

  it.effect("returns the latest messages and marks text it cut", () => {
    const long = "x".repeat(PeerEnvironmentService.PEER_MESSAGE_TEXT_LIMIT + 25);
    const wire = makeWire({
      thread: () =>
        Effect.succeed({
          projection: projection([
            message("message-1", "first"),
            message("message-2", "second"),
            message("message-3", long),
          ]),
          hasMoreHistory: false,
        }),
    });
    return Effect.gen(function* () {
      const peers = yield* PeerEnvironmentService.PeerEnvironmentService;
      const detail = yield* peers.readThread("boat", ThreadId.make("thread-remote"), { limit: 2 });
      assert.deepStrictEqual(
        detail.messages.map((entry) => entry.messageId),
        ["message-2", "message-3"],
      );
      assert.strictEqual(detail.hasEarlierMessages, true);
      assert.strictEqual(detail.status, "idle");
      assert.strictEqual(detail.messages[0]?.truncated, false);
      const cut = detail.messages[1];
      assert.strictEqual(cut?.truncated, true);
      assert.isTrue(cut?.text.endsWith("[truncated: 25 more characters]"));
    }).pipe(Effect.provide(wire.layer));
  });
});
