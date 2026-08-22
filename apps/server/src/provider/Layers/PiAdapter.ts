/**
 * PiAdapter — `ProviderAdapterShape` implementation driving the pi CLI in
 * RPC mode (`pi --mode rpc`).
 *
 * One child process per T3 Code thread. The pi RPC protocol is JSONL over
 * stdin/stdout with strict LF framing — records must only be split on `\n`
 * (never on Unicode separators), so the pump uses a manual buffer instead of
 * a generic line reader. Commands are correlated by an incrementing `id`;
 * responses resolve Deferreds, everything else is a streamed event mapped
 * into the canonical `ProviderRuntimeEvent` vocabulary.
 *
 * v1 scope: prompt / steer / abort, streaming text + reasoning deltas, tool
 * lifecycle items, usage updates, compaction items, session stop. Extension
 * UI dialogs are auto-cancelled (pi extensions that require interactive
 * answers will see a cancelled response). Thread persistence and rollback
 * land in a later slice.
 *
 * @module provider/Layers/PiAdapter
 */
import {
  EventId,
  type PiSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  type ProviderSendTurnInput,
  type ProviderSession,
  type ProviderSessionStartInput,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Result from "effect/Result";
import * as Scope from "effect/Scope";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import { ServerConfig } from "../../config.ts";
import {
  ProviderAdapterProcessError,
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
  type ProviderAdapterError,
} from "../Errors.ts";
import type { PiAdapterShape } from "../Services/PiAdapter.ts";
import type { ProviderThreadSnapshot } from "../Services/ProviderAdapter.ts";

const PROVIDER = ProviderDriverKind.make("pi");

const READY_TIMEOUT_MS = 45_000;
const COMMAND_RESPONSE_TIMEOUT_MS = 30_000;
const ENCODER = new TextEncoder();

/** A decoded line from the pi RPC stdout stream. */
type PiRpcMessage = Record<string, unknown>;

interface PiPendingCommand {
  readonly deferred: Deferred.Deferred<PiRpcMessage, ProviderAdapterError>;
}

interface PiSessionContext {
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly createdAtIso: string;
  readonly child: ChildProcessSpawner.ChildProcessHandle;
  readonly sessionScope: Scope.Closeable;
  readonly pendingCommands: Map<string, PiPendingCommand>;
  readonly nextCommandId: Ref.Ref<number>;
  readonly activeTurnId: Ref.Ref<TurnId | undefined>;
  readonly lastStopReason: Ref.Ref<string | undefined>;
  readonly lastUsageTotalTokens: Ref.Ref<number | undefined>;
  readonly model: Ref.Ref<string | undefined>;
  readonly stopped: Ref.Ref<boolean>;
}

export interface PiAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly environment?: NodeJS.ProcessEnv | undefined;
  readonly nativeEventLogPath?: string | undefined;
}

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * Encode one RPC command as a strict-JSON line. Kept outside Effect
 * generators so the schema-preference lint does not fire on protocol
 * encoding of untyped upstream payloads.
 */
const encodeRpcLine = (command: PiRpcMessageLike): string => `${JSON.stringify(command)}\n`;

interface PiRpcMessageLike {
  readonly [key: string]: unknown;
}

/**
 * Decode one RPC line. Returns `undefined` for blank or non-JSON lines.
 * Kept outside Effect generators (see encodeRpcLine note).
 */
const decodeRpcLine = (rawLine: string): PiRpcMessageLike | undefined => {
  if (rawLine.length === 0) {
    return undefined;
  }
  try {
    const parsed: unknown = JSON.parse(rawLine);
    if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
      return undefined;
    }
    return parsed as PiRpcMessageLike;
  } catch {
    return undefined;
  }
};

const adapterError = (
  method: string,
  detail: string,
  cause?: unknown,
): ProviderAdapterRequestError =>
  new ProviderAdapterRequestError({
    provider: PROVIDER,
    method,
    detail,
    ...(cause !== undefined ? { cause } : {}),
  });

/**
 * Map a pi tool name to the canonical tool lifecycle item type. pi's built-in
 * tools cover read/bash/edit/write; anything else (MCP tools, custom tools)
 * lands as `dynamic_tool_call`.
 */
function piToolToItemType(toolName: string): ToolLifecycleItemTypeForAdapter {
  switch (toolName) {
    case "bash":
      return "command_execution" as const;
    case "edit":
    case "write":
      return "file_change" as const;
    default:
      return "dynamic_tool_call" as const;
  }
}
type ToolLifecycleItemTypeForAdapter = "command_execution" | "file_change" | "dynamic_tool_call";

function firstTextOfContent(content: unknown): string | undefined {
  if (typeof content === "string") {
    return content;
  }
  if (!Array.isArray(content)) {
    return undefined;
  }
  for (const block of content) {
    if (
      block !== null &&
      typeof block === "object" &&
      (block as Record<string, unknown>).type === "text"
    ) {
      const text = (block as Record<string, unknown>).text;
      if (typeof text === "string") {
        return text;
      }
    }
  }
  return undefined;
}

/** Stable, generator-free detail rendering for tool args. */
function renderArgsDetail(args: unknown): string | undefined {
  if (typeof args === "string") {
    return truncateDetail(args);
  }
  try {
    return truncateDetail(JSON.stringify(args));
  } catch {
    return undefined;
  }
}

function truncateDetail(value: string | undefined, max = 400): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) {
    return undefined;
  }
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

/**
 * Parse a model slug of the form `provider/model` with optional
 * `:thinkingLevel` suffix into its set_model / set_thinking_level parts.
 */
export function parsePiModelSlug(
  slug: string,
): { provider: string; modelId: string; thinking?: string } | undefined {
  const colonIndex = slug.indexOf(":");
  const withoutThinking = colonIndex === -1 ? slug : slug.slice(0, colonIndex);
  const thinking = colonIndex === -1 ? undefined : slug.slice(colonIndex + 1);
  const slashIndex = withoutThinking.indexOf("/");
  if (slashIndex <= 0 || slashIndex === withoutThinking.length - 1) {
    return undefined;
  }
  return {
    provider: withoutThinking.slice(0, slashIndex),
    modelId: withoutThinking.slice(slashIndex + 1),
    ...(thinking ? { thinking } : {}),
  };
}

export function makePiAdapter(
  piConfig: PiSettings,
  options?: PiAdapterLiveOptions,
): Effect.Effect<
  PiAdapterShape,
  never,
  ChildProcessSpawner.ChildProcessSpawner | Crypto.Crypto | ServerConfig | Scope.Scope
> {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("pi");
    const serverConfig = yield* ServerConfig;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const crypto = yield* Crypto.Crypto;

    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError((cause) =>
        adapterError("crypto/randomUUIDv4", "Failed to generate pi runtime identifier.", cause),
      ),
    );

    const runtimeEvents = yield* Queue.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, PiSessionContext>();

    const emit = (event: ProviderRuntimeEvent) =>
      Queue.offer(runtimeEvents, event).pipe(Effect.asVoid);

    const buildEventBase = (input: {
      threadId: ThreadId;
      turnId?: TurnId | undefined;
      itemId?: string | undefined;
      raw?: unknown;
    }) =>
      Effect.gen(function* () {
        const eventId = EventId.make(yield* randomUUIDv4);
        const createdAt = yield* nowIso;
        return {
          eventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          createdAt,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
        };
      });

    // Layer-level finalizer: stopping the adapter stops every pi child.
    yield* Effect.addFinalizer(() =>
      Effect.gen(function* () {
        const contexts = [...sessions.values()];
        sessions.clear();
        yield* Effect.forEach(contexts, (context) => Effect.ignore(shutdownPiContext(context)), {
          concurrency: "unbounded",
          discard: true,
        });
      }).pipe(Effect.ensuring(Queue.shutdown(runtimeEvents))),
    );

    const shutdownPiContext = (context: PiSessionContext) =>
      Effect.gen(function* () {
        if (yield* Ref.getAndSet(context.stopped, true)) {
          return;
        }
        for (const [, pending] of context.pendingCommands) {
          yield* Deferred.done(
            pending.deferred,
            Exit.fail(
              new ProviderAdapterSessionClosedError({
                provider: PROVIDER,
                threadId: context.threadId,
              }),
            ),
          );
        }
        context.pendingCommands.clear();
        yield* context.child.kill().pipe(Effect.catch(() => Effect.void));
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
      });

    const failCommand = (
      context: PiSessionContext,
      id: string,
      error: ProviderAdapterError,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const pending = context.pendingCommands.get(id);
        if (!pending) {
          return;
        }
        context.pendingCommands.delete(id);
        yield* Deferred.fail(pending.deferred, error).pipe(Effect.ignore);
      });

    const writeToPiStdin = (context: PiSessionContext, text: string) =>
      Stream.make(text).pipe(
        Stream.run(Sink.mapInput(context.child.stdin, (chunk: string) => ENCODER.encode(chunk))),
        Effect.mapError(
          (cause) =>
            new ProviderAdapterProcessError({
              provider: PROVIDER,
              threadId: context.threadId,
              detail: "Failed to write to pi process stdin.",
              cause,
            }),
        ),
      );

    const sendCommand = (context: PiSessionContext, command: PiRpcMessage) =>
      writeToPiStdin(context, encodeRpcLine(command));

    /**
     * Send a command carrying an `id` and await its correlated `response`
     * line. Responses arrive out of order relative to events; the reader
     * fiber resolves the Deferred.
     */
    const requestPi = <A = PiRpcMessage>(
      context: PiSessionContext,
      command: PiRpcMessage,
      timeoutMs = COMMAND_RESPONSE_TIMEOUT_MS,
    ): Effect.Effect<A, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (yield* Ref.get(context.stopped)) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId: context.threadId,
          });
        }
        const idNum = yield* Ref.updateAndGet(context.nextCommandId, (n) => n + 1);
        const id = `t3-${idNum}`;
        const deferred = yield* Deferred.make<PiRpcMessage, ProviderAdapterError>();
        context.pendingCommands.set(id, { deferred });
        const writeFailure = new ProviderAdapterProcessError({
          provider: PROVIDER,
          threadId: context.threadId,
          detail: "Failed to write to pi process stdin.",
        });
        yield* sendCommand(context, { ...command, id }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              void cause;
              return yield* failCommand(context, id, writeFailure).pipe(Effect.as(writeFailure));
            }),
          ),
        );
        const response = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(timeoutMs),
          Effect.flatMap((result): Effect.Effect<PiRpcMessage, ProviderAdapterError> => {
            if (Option.isSome(result)) {
              return Effect.succeed(result.value);
            }
            // Timed out: drop the pending entry so late responses no-op.
            context.pendingCommands.delete(id);
            return Effect.fail(
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: `pi/${String(command.type)}`,
                detail: `pi did not respond to '${String(command.type)}' within ${String(timeoutMs)}ms.`,
              }),
            );
          }),
        );
        if (
          typeof response === "object" &&
          response !== null &&
          (response as Record<string, unknown>).success === false
        ) {
          const errorText = (response as Record<string, unknown>).error;
          return yield* adapterError(
            `pi/${String(command.type)}`,
            typeof errorText === "string"
              ? errorText
              : `pi command '${String(command.type)}' failed.`,
          );
        }
        return response as A;
      });

    const makeItemEventPayload = (payload: Record<string, unknown>) => payload;

    const emitItemStarted = (
      context: PiSessionContext,
      turnId: TurnId | undefined,
      itemId: string,
      itemType: ToolLifecycleItemTypeForAdapter | "context_compaction",
      title: string,
      detail?: string | undefined,
    ) =>
      Effect.gen(function* () {
        const base = yield* buildEventBase({
          threadId: context.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
        });
        yield* emit({
          ...base,
          type: "item.started",
          payload: makeItemEventPayload({
            itemType,
            status: "inProgress",
            title,
            ...(detail ? { detail } : {}),
          }),
        } as ProviderRuntimeEvent);
      });

    const emitItemUpdated = (
      context: PiSessionContext,
      turnId: TurnId | undefined,
      itemId: string,
      detail: string,
    ) =>
      Effect.gen(function* () {
        const base = yield* buildEventBase({
          threadId: context.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
        });
        yield* emit({
          ...base,
          type: "item.updated",
          payload: makeItemEventPayload({ detail }),
        } as ProviderRuntimeEvent);
      });

    const emitItemCompleted = (
      context: PiSessionContext,
      turnId: TurnId | undefined,
      itemId: string,
      itemType: ToolLifecycleItemTypeForAdapter | "assistant_message" | "context_compaction",
      status: "completed" | "failed",
      fields: {
        title?: string | undefined;
        detail?: string | undefined;
        data?: unknown;
      } = {},
    ) =>
      Effect.gen(function* () {
        const base = yield* buildEventBase({
          threadId: context.threadId,
          ...(turnId ? { turnId } : {}),
          itemId,
        });
        yield* emit({
          ...base,
          type: "item.completed",
          payload: makeItemEventPayload({
            itemType,
            status,
            ...(fields.title ? { title: fields.title } : {}),
            ...(fields.detail ? { detail: fields.detail } : {}),
            ...(fields.data !== undefined ? { data: fields.data } : {}),
          }),
        } as ProviderRuntimeEvent);
      });

    const emitContentDelta = (
      context: PiSessionContext,
      turnId: TurnId,
      streamKind: "assistant_text" | "reasoning_text",
      delta: string,
      contentIndex?: number | undefined,
    ) =>
      Effect.gen(function* () {
        const base = yield* buildEventBase({ threadId: context.threadId, turnId });
        yield* emit({
          ...base,
          type: "content.delta",
          payload: makeItemEventPayload({
            streamKind,
            delta,
            ...(contentIndex !== undefined ? { contentIndex } : {}),
          }),
        } as ProviderRuntimeEvent);
      });

    const emitUsageUpdate = (context: PiSessionContext, totalTokens: number | undefined) =>
      Effect.gen(function* () {
        if (totalTokens === undefined || !Number.isFinite(totalTokens)) {
          return;
        }
        yield* Ref.set(context.lastUsageTotalTokens, totalTokens);
        const base = yield* buildEventBase({ threadId: context.threadId });
        yield* emit({
          ...base,
          type: "thread.token-usage.updated",
          payload: makeItemEventPayload({
            usage: { usedTokens: Math.max(0, Math.round(totalTokens)) },
          }),
        } as ProviderRuntimeEvent);
      });

    const finalizeActiveTurn = (context: PiSessionContext, settled: boolean) =>
      Effect.gen(function* () {
        const turnId = yield* Ref.getAndSet(context.activeTurnId, undefined);
        const base = yield* buildEventBase({
          threadId: context.threadId,
          ...(turnId ? { turnId } : {}),
        });
        const state = yield* Ref.get(context.lastStopReason);
        if (!settled && !turnId) {
          return;
        }
        if (state === "aborted") {
          if (turnId) {
            yield* emit({
              ...base,
              type: "turn.aborted",
              payload: makeItemEventPayload({ reason: "aborted by user" }),
            } as ProviderRuntimeEvent);
          }
        } else if (turnId) {
          const usage = yield* Ref.get(context.lastUsageTotalTokens);
          yield* emit({
            ...base,
            type: "turn.completed",
            payload: makeItemEventPayload({
              state: "completed",
              ...(state ? { stopReason: state } : {}),
              ...(usage !== undefined ? { usage } : {}),
            }),
          } as ProviderRuntimeEvent);
        }
        yield* emit({
          ...base,
          type: "session.state.changed",
          payload: makeItemEventPayload({ state: "ready" }),
        } as ProviderRuntimeEvent);
        yield* emit({
          ...base,
          type: "thread.state.changed",
          payload: makeItemEventPayload({ state: "idle" }),
        } as ProviderRuntimeEvent);
      });

    /** Map one decoded pi event line to zero or more canonical events. */
    const handlePiEvent = (context: PiSessionContext, message: PiRpcMessage) =>
      Effect.gen(function* () {
        const eventType = message.type;
        const turnId = yield* Ref.get(context.activeTurnId);
        switch (eventType) {
          case "agent_start": {
            const base = yield* buildEventBase({ threadId: context.threadId });
            yield* emit({
              ...base,
              type: "session.state.changed",
              payload: makeItemEventPayload({ state: "running" }),
            } as ProviderRuntimeEvent);
            yield* emit({
              ...base,
              type: "thread.state.changed",
              payload: makeItemEventPayload({ state: "active" }),
            } as ProviderRuntimeEvent);
            break;
          }
          case "message_update": {
            const deltaEvent = message.assistantMessageEvent as Record<string, unknown> | undefined;
            if (!deltaEvent || !turnId) {
              break;
            }
            const contentIndex =
              typeof deltaEvent.contentIndex === "number" ? deltaEvent.contentIndex : undefined;
            if (deltaEvent.type === "text_delta" && typeof deltaEvent.delta === "string") {
              yield* emitContentDelta(
                context,
                turnId,
                "assistant_text",
                deltaEvent.delta,
                contentIndex,
              );
            } else if (
              deltaEvent.type === "thinking_delta" &&
              typeof deltaEvent.delta === "string"
            ) {
              yield* emitContentDelta(
                context,
                turnId,
                "reasoning_text",
                deltaEvent.delta,
                contentIndex,
              );
            }
            const usage = message.usage as Record<string, unknown> | undefined;
            if (usage && typeof usage.totalTokens === "number") {
              yield* emitUsageUpdate(context, usage.totalTokens);
            }
            break;
          }
          case "message_end": {
            const piMessage = message.message as Record<string, unknown> | undefined;
            if (!piMessage || piMessage.role !== "assistant") {
              break;
            }
            yield* Ref.set(
              context.lastStopReason,
              typeof piMessage.stopReason === "string" ? piMessage.stopReason : undefined,
            );
            const usage = piMessage.usage as Record<string, unknown> | undefined;
            if (usage && typeof usage.totalTokens === "number") {
              yield* emitUsageUpdate(context, usage.totalTokens);
            }
            if (turnId) {
              const text = firstTextOfContent(piMessage.content);
              yield* emitItemCompleted(
                context,
                turnId,
                `msg-${yield* randomUUIDv4}`,
                "assistant_message",
                "completed",
                {
                  detail: truncateDetail(text),
                  data: { stopReason: piMessage.stopReason },
                },
              );
            }
            break;
          }
          case "tool_execution_start": {
            const toolCallId =
              typeof message.toolCallId === "string" ? message.toolCallId : undefined;
            if (!toolCallId) {
              break;
            }
            const toolName = typeof message.toolName === "string" ? message.toolName : "tool";
            yield* emitItemStarted(
              context,
              turnId,
              toolCallId,
              piToolToItemType(toolName),
              toolName,
              renderArgsDetail(message.args) ?? truncateDetail(firstTextOfContent(message.args)),
            );
            break;
          }
          case "tool_execution_update": {
            const toolCallId =
              typeof message.toolCallId === "string" ? message.toolCallId : undefined;
            const partial = message.partialResult as Record<string, unknown> | undefined;
            const text = firstTextOfContent(partial?.content);
            if (toolCallId && text) {
              yield* emitItemUpdated(context, turnId, toolCallId, truncateDetail(text) ?? "");
            }
            break;
          }
          case "tool_execution_end": {
            const toolCallId =
              typeof message.toolCallId === "string" ? message.toolCallId : undefined;
            if (!toolCallId) {
              break;
            }
            const result = message.result as Record<string, unknown> | undefined;
            yield* emitItemCompleted(
              context,
              turnId,
              toolCallId,
              piToolToItemType(typeof message.toolName === "string" ? message.toolName : "other"),
              message.isError === true ? "failed" : "completed",
              { detail: truncateDetail(firstTextOfContent(result?.content)) },
            );
            break;
          }
          case "compaction_start": {
            yield* emitItemStarted(
              context,
              turnId,
              `compaction-${yield* randomUUIDv4}`,
              "context_compaction",
              "Compacting conversation context",
              typeof message.reason === "string" ? message.reason : undefined,
            );
            break;
          }
          case "compaction_end": {
            // Compaction has no stable upstream id; surface completion via a
            // standalone completed item so the timeline shows the boundary.
            yield* emitItemCompleted(
              context,
              turnId,
              `compaction-${yield* randomUUIDv4}`,
              "context_compaction",
              message.aborted === true ? "failed" : "completed",
              {
                detail:
                  message.aborted === true
                    ? "Compaction aborted."
                    : truncateDetail(
                        (message.result as Record<string, unknown> | undefined)?.summary as
                          | string
                          | undefined,
                      ),
              },
            );
            break;
          }
          case "auto_retry_start": {
            const base = yield* buildEventBase({ threadId: context.threadId });
            yield* emit({
              ...base,
              type: "runtime.warning",
              payload: makeItemEventPayload({
                message: `pi transient error — retrying (attempt ${String(
                  message.attempt ?? "?",
                )}/${String(message.maxAttempts ?? "?")}).`,
              }),
            } as ProviderRuntimeEvent);
            break;
          }
          case "auto_retry_end": {
            if (message.success === false) {
              const base = yield* buildEventBase({ threadId: context.threadId });
              yield* emit({
                ...base,
                type: "runtime.error",
                payload: makeItemEventPayload({
                  message: "pi exhausted automatic retries.",
                  class: "provider_error",
                  detail: message.finalError,
                }),
              } as ProviderRuntimeEvent);
            }
            break;
          }
          case "extension_error": {
            const base = yield* buildEventBase({ threadId: context.threadId });
            yield* emit({
              ...base,
              type: "runtime.warning",
              payload: makeItemEventPayload({
                message: "A pi extension threw an error.",
                detail: typeof message.error === "string" ? message.error : undefined,
              }),
            } as ProviderRuntimeEvent);
            break;
          }
          case "agent_settled": {
            yield* finalizeActiveTurn(context, true);
            break;
          }
          case "agent_end": {
            // Non-settling agent_end (retry/continuation pending) keeps the
            // turn open; nothing to emit here — agent_settled finalizes.
            if (message.willRetry === true) {
              yield* Ref.set(context.lastStopReason, undefined);
            }
            break;
          }
          default:
            break;
        }
      });

    const respondToUiDialog = (context: PiSessionContext, message: PiRpcMessage) =>
      Effect.gen(function* () {
        // v1 policy: auto-cancel every interactive dialog so prompts never
        // hang waiting for a UI that cannot answer. Fire-and-forget methods
        // (notify/setStatus/setWidget/…) need no response at all.
        const method = message.method;
        if (
          method === "select" ||
          method === "confirm" ||
          method === "input" ||
          method === "editor"
        ) {
          const id = typeof message.id === "string" ? message.id : undefined;
          if (id) {
            yield* sendCommand(context, {
              type: "extension_ui_response",
              id,
              cancelled: true,
            }).pipe(Effect.ignore);
          }
        }
      });

    const handleLine = (context: PiSessionContext, rawLine: string) =>
      Effect.gen(function* () {
        const message = decodeRpcLine(rawLine);
        if (!message) {
          return;
        }
        const type = message.type;
        if (type === "response") {
          const id = typeof message.id === "string" ? message.id : undefined;
          if (id) {
            const pending = context.pendingCommands.get(id);
            if (pending) {
              context.pendingCommands.delete(id);
              yield* Deferred.succeed(pending.deferred, message).pipe(Effect.ignore);
            }
          }
          return;
        }
        if (type === "extension_ui_request") {
          yield* respondToUiDialog(context, message);
          return;
        }
        yield* handlePiEvent(context, message).pipe(Effect.ignore);
      });

    const startReaderFiber = (context: PiSessionContext, sessionScope: Scope.Scope) =>
      Effect.gen(function* () {
        let buffer = "";
        yield* context.child.stdout.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) =>
            Effect.gen(function* () {
              // Strict LF-only framing per the pi RPC protocol contract.
              buffer += chunk;
              for (;;) {
                const newlineIndex = buffer.indexOf("\n");
                if (newlineIndex === -1) {
                  break;
                }
                let line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                if (line.endsWith("\r")) {
                  line = line.slice(0, -1);
                }
                yield* handleLine(context, line).pipe(Effect.ignore);
              }
            }),
          ),
          Effect.ignore,
          Effect.forkIn(sessionScope),
        );
        yield* context.child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach(() => Effect.void),
          Effect.ignore,
          Effect.forkIn(sessionScope),
        );
        // Exit watcher.
        yield* context.child.exitCode.pipe(
          Effect.flatMap(() =>
            Effect.gen(function* () {
              if (yield* Ref.getAndSet(context.stopped, true)) {
                return;
              }
              sessions.delete(context.threadId);
              const base = yield* buildEventBase({ threadId: context.threadId });
              yield* emit({
                ...base,
                type: "session.exited",
                payload: makeItemEventPayload({
                  reason: "pi process exited unexpectedly.",
                  exitKind: "error",
                  recoverable: true,
                }),
              } as ProviderRuntimeEvent).pipe(Effect.ignore);
            }),
          ),
          Effect.ignore,
          Effect.forkIn(sessionScope),
        );
      });

    const getSessionOrError = (
      threadId: ThreadId,
    ): Effect.Effect<PiSessionContext, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({
            provider: PROVIDER,
            threadId,
          });
        }
        if (yield* Ref.get(context.stopped)) {
          return yield* new ProviderAdapterSessionClosedError({
            provider: PROVIDER,
            threadId,
          });
        }
        return context;
      });

    const applyModelSelection = (
      context: PiSessionContext,
      modelSlug: string | undefined,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        const effective =
          modelSlug?.trim() ||
          (piConfig.defaultModel.trim() ? piConfig.defaultModel.trim() : undefined);
        if (!effective) {
          return;
        }
        const parsed = parsePiModelSlug(effective);
        if (!parsed) {
          yield* Effect.logWarning("Ignoring unparseable pi model selection.", {
            model: effective,
          });
          return;
        }
        yield* requestPi(context, {
          type: "set_model",
          provider: parsed.provider,
          modelId: parsed.modelId,
        }).pipe(Effect.ignore);
        if (parsed.thinking) {
          yield* requestPi(context, {
            type: "set_thinking_level",
            level: parsed.thinking,
          }).pipe(Effect.ignore);
        }
        yield* Ref.set(context.model, effective);
      });

    const startSession = (
      input: ProviderSessionStartInput,
    ): Effect.Effect<ProviderSession, ProviderAdapterError> =>
      Effect.gen(function* () {
        if (sessions.has(input.threadId)) {
          yield* stopSession(input.threadId).pipe(Effect.ignore);
        }
        const sessionScope = yield* Scope.make();
        const startedAtIso = yield* nowIso;
        const launchArgs =
          piConfig.launchArgs.trim().length > 0 ? piConfig.launchArgs.trim().split(/\s+/) : [];
        const spawnOptions = options?.environment ? { env: options.environment } : {};
        const spawnCommand = yield* resolveSpawnCommand(
          piConfig.binaryPath || "pi",
          ["--mode", "rpc", "--no-session", ...launchArgs],
          spawnOptions,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new ProviderAdapterProcessError({
                provider: PROVIDER,
                threadId: input.threadId,
                detail: "Failed to resolve the pi command path.",
                cause,
              }),
          ),
        );

        const child = yield* spawner
          .spawn(
            ChildProcess.make(spawnCommand.command, spawnCommand.args, {
              shell: spawnCommand.shell,
              cwd: input.cwd ?? serverConfig.cwd,
              env: options?.environment ?? undefined,
              extendEnv: options?.environment === undefined,
            }),
          )
          .pipe(
            Effect.provideService(Scope.Scope, sessionScope),
            Effect.mapError(
              (cause) =>
                new ProviderAdapterProcessError({
                  provider: PROVIDER,
                  threadId: input.threadId,
                  detail: "Failed to spawn the pi process.",
                  cause,
                }),
            ),
          );

        const initialId = yield* Ref.make(0);
        const context: PiSessionContext = {
          threadId: input.threadId,
          cwd: input.cwd ?? serverConfig.cwd,
          runtimeMode: input.runtimeMode,
          createdAtIso: startedAtIso,
          child,
          sessionScope,
          pendingCommands: new Map(),
          nextCommandId: initialId,
          activeTurnId: yield* Ref.make<TurnId | undefined>(undefined),
          lastStopReason: yield* Ref.make<string | undefined>(undefined),
          lastUsageTotalTokens: yield* Ref.make<number | undefined>(undefined),
          model: yield* Ref.make<string | undefined>(undefined),
          stopped: yield* Ref.make(false),
        };

        yield* startReaderFiber(context, sessionScope);

        sessions.set(input.threadId, context);

        const readyState = yield* requestPi<Record<string, unknown>>(
          context,
          {
            type: "get_state",
          },
          READY_TIMEOUT_MS,
        ).pipe(Effect.result);
        if (Result.isFailure(readyState)) {
          // Startup failed: tear the child down before surfacing why.
          yield* shutdownPiContext(context).pipe(Effect.ignoreCause);
          yield* Scope.close(sessionScope, Exit.void).pipe(Effect.ignore);
          return yield* new ProviderAdapterProcessError({
            provider: PROVIDER,
            threadId: input.threadId,
            detail: `The pi process did not become ready within ${String(
              READY_TIMEOUT_MS / 1000,
            )}s. Is the pi CLI installed and authenticated?`,
            cause: readyState.failure,
          });
        }

        yield* applyModelSelection(context, input.modelSelection?.model);

        const modelValue = yield* Ref.get(context.model);
        const base = yield* buildEventBase({ threadId: input.threadId });
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          ...(context.cwd ? { cwd: context.cwd } : {}),
          ...(modelValue ? { model: modelValue } : {}),
          threadId: input.threadId,
          createdAt: startedAtIso,
          updatedAt: startedAtIso,
        };
        yield* emit({
          ...base,
          type: "session.started",
          payload: makeItemEventPayload({}),
        } as ProviderRuntimeEvent);
        yield* emit({
          ...base,
          type: "thread.started",
          payload: makeItemEventPayload({}),
        } as ProviderRuntimeEvent);
        yield* emit({
          ...base,
          type: "session.state.changed",
          payload: makeItemEventPayload({ state: "ready" }),
        } as ProviderRuntimeEvent);
        return session;
      });

    const sendTurn = (
      input: ProviderSendTurnInput,
    ): Effect.Effect<{ threadId: ThreadId; turnId: TurnId }, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = yield* getSessionOrError(input.threadId);
        const existingTurn = yield* Ref.get(context.activeTurnId);
        if (existingTurn) {
          // Agent already running — deliver as a steering message.
          yield* requestPi(context, {
            type: "steer",
            ...(input.input ? { message: input.input } : {}),
          }).pipe(
            Effect.mapError((cause) => adapterError("pi/steer", "Failed to steer pi.", cause)),
          );
          return { threadId: input.threadId, turnId: existingTurn };
        }
        if (!input.input) {
          return yield* new ProviderAdapterValidationError({
            provider: PROVIDER,
            operation: "sendTurn",
            issue: "pi requires non-empty prompt input when no turn is running.",
          });
        }
        const turnId = TurnId.make(yield* randomUUIDv4);
        yield* Ref.set(context.activeTurnId, turnId);
        yield* Ref.set(context.lastStopReason, undefined as string | undefined);
        const modelValue = yield* Ref.get(context.model);
        const base = yield* buildEventBase({ threadId: input.threadId, turnId });
        yield* emit({
          ...base,
          type: "turn.started",
          payload: makeItemEventPayload({
            ...(modelValue ? { model: modelValue } : {}),
          }),
        } as ProviderRuntimeEvent);
        yield* requestPi(context, { type: "prompt", message: input.input }).pipe(
          Effect.tapError(() => Ref.set(context.activeTurnId, undefined)),
          Effect.mapError((cause) =>
            adapterError("pi/prompt", "Failed to send prompt to pi.", cause),
          ),
        );
        return { threadId: input.threadId, turnId };
      });

    const interruptTurn = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = yield* getSessionOrError(threadId);
        yield* sendCommand(context, { type: "abort" }).pipe(
          Effect.mapError((cause) => adapterError("pi/abort", "Failed to abort pi.", cause)),
        );
      });

    const unsupportedOperation = (method: string): Effect.Effect<never, ProviderAdapterError> =>
      new ProviderAdapterRequestError({
        provider: PROVIDER,
        method: `pi/${method}`,
        detail: "This operation is not supported by the pi driver yet.",
      });

    const stopSession = (threadId: ThreadId): Effect.Effect<void, ProviderAdapterError> =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return;
        }
        sessions.delete(threadId);
        yield* shutdownPiContext(context);
        const base = yield* buildEventBase({ threadId });
        yield* emit({
          ...base,
          type: "session.exited",
          payload: makeItemEventPayload({ reason: "stopped by user", exitKind: "graceful" }),
        } as ProviderRuntimeEvent).pipe(Effect.ignore);
      });

    const buildSessionRecord = (
      context: PiSessionContext,
      status: ProviderSession["status"],
    ): Effect.Effect<ProviderSession> =>
      Effect.gen(function* () {
        const updatedAt = yield* nowIso;
        const modelValue = yield* Ref.get(context.model);
        const activeTurn = yield* Ref.get(context.activeTurnId);
        return {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status,
          runtimeMode: context.runtimeMode,
          ...(context.cwd ? { cwd: context.cwd } : {}),
          ...(modelValue ? { model: modelValue } : {}),
          threadId: context.threadId,
          createdAt: context.createdAtIso,
          updatedAt,
          ...(activeTurn ? { activeTurnId: activeTurn } : {}),
        };
      });

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
      },

      startSession,

      sendTurn,

      interruptTurn,

      respondToRequest: () =>
        unsupportedOperation("respondToRequest") as Effect.Effect<void, ProviderAdapterError>,

      respondToUserInput: () =>
        unsupportedOperation("respondToUserInput") as Effect.Effect<void, ProviderAdapterError>,

      stopSession,

      listSessions: (): Effect.Effect<ReadonlyArray<ProviderSession>> =>
        Effect.forEach([...sessions.values()], (context) => buildSessionRecord(context, "running")),

      hasSession: (threadId: ThreadId): Effect.Effect<boolean> =>
        Effect.sync(() => sessions.has(threadId)),

      readThread: (
        threadId: ThreadId,
      ): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        Effect.gen(function* () {
          yield* getSessionOrError(threadId);
          // v1: live threads render purely from streamed events; historical
          // replay from pi's session file lands in a later slice.
          return { threadId, turns: [] };
        }),

      rollbackThread: (): Effect.Effect<ProviderThreadSnapshot, ProviderAdapterError> =>
        unsupportedOperation("rollbackThread"),

      stopAll: (): Effect.Effect<void> =>
        Effect.gen(function* () {
          const threadIds = [...sessions.keys()];
          yield* Effect.forEach(
            threadIds,
            (threadId) => stopSession(threadId).pipe(Effect.ignore),
            { concurrency: "unbounded", discard: true },
          );
        }),

      get streamEvents() {
        return Stream.fromQueue(runtimeEvents);
      },
    } satisfies PiAdapterShape;
  });
}
