// @effect-diagnostics nodeBuiltinImport:off
import { EventEmitter } from "node:events";
import { PassThrough, type Readable, type Writable } from "node:stream";

import * as NodeStream from "@effect/platform-node/NodeStream";
import type {
  SpawnedProcess as ClaudeSdkSpawnedProcess,
  SpawnOptions as ClaudeSdkSpawnOptions,
} from "@anthropic-ai/claude-agent-sdk";
import type { ThreadId } from "@t3tools/contracts";
import type * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import type { ChildProcessSpawner } from "effect/unstable/process";

import type { ProcessLaunchInput } from "../process/ProcessLauncher.ts";
import {
  observeProviderProcessExit,
  type ProviderProcessExit,
} from "./providerChildDiagnostics.ts";

export const CLAUDE_PROCESS_FORCE_KILL_AFTER = "5 seconds" as const;

export function makeClaudeProcessLaunchInput(input: {
  readonly threadId: ThreadId;
  readonly options: ClaudeSdkSpawnOptions;
}): ProcessLaunchInput {
  return {
    threadId: input.threadId,
    command: input.options.command,
    args: input.options.args,
    ...(input.options.cwd !== undefined ? { cwd: input.options.cwd } : {}),
    env: input.options.env,
    extendEnv: false,
    forceKillAfter: CLAUDE_PROCESS_FORCE_KILL_AFTER,
  };
}

type ExitListener = (code: number | null, signal: NodeJS.Signals | null) => void;
type ErrorListener = (error: Error) => void;
type ClaudeSpawnedProcessEvents = {
  readonly exit: [code: number | null, signal: NodeJS.Signals | null];
  readonly error: [error: Error];
};

export interface ClaudeSpawnedProcessOptions {
  readonly launch: Promise<ChildProcessSpawner.ChildProcessHandle>;
  readonly signal: AbortSignal;
  readonly forceKillAfter?: Duration.Input;
  readonly onStderr?: (chunk: string) => void;
  readonly onExit?: (exit: ProviderProcessExit) => void;
  readonly onSettled?: () => void;
}

function asError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

/** Adapts Effect's process handle to the synchronous process shape required by the Claude SDK. */
export class ClaudeSpawnedProcess implements ClaudeSdkSpawnedProcess {
  private readonly events = new EventEmitter<ClaudeSpawnedProcessEvents>();
  private readonly stdinBridge = new PassThrough();
  private readonly stdoutBridge = new PassThrough();
  private readonly forceKillAfter: Duration.Input;
  private readonly abortSignal: AbortSignal;
  private readonly options: ClaudeSpawnedProcessOptions;
  private child: ChildProcessSpawner.ChildProcessHandle | undefined;
  private requestedKillSignal: NodeJS.Signals | undefined;
  private killedValue = false;
  private exitCodeValue: number | null = null;
  private exited = false;
  private errorEmitted = false;

  readonly stdin: Writable = this.stdinBridge;
  readonly stdout: Readable = this.stdoutBridge;

  constructor(options: ClaudeSpawnedProcessOptions) {
    this.options = options;
    this.forceKillAfter = options.forceKillAfter ?? CLAUDE_PROCESS_FORCE_KILL_AFTER;
    this.abortSignal = options.signal;
    this.abortSignal.addEventListener("abort", this.onAbort, { once: true });
    if (this.abortSignal.aborted) {
      this.onAbort();
    }
    void this.connect();
  }

  get killed(): boolean {
    return this.killedValue;
  }

  get exitCode(): number | null {
    return this.exitCodeValue;
  }

  kill(signal: NodeJS.Signals): boolean {
    if (this.exited || this.killedValue) {
      return false;
    }
    this.killedValue = true;
    this.requestedKillSignal = signal;
    if (this.child) {
      this.killChild(this.child, signal);
    }
    return true;
  }

  on(event: "exit", listener: ExitListener): void;
  on(event: "error", listener: ErrorListener): void;
  on(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") {
      this.events.on(event, listener as ExitListener);
    } else {
      this.events.on(event, listener as ErrorListener);
    }
  }

  once(event: "exit", listener: ExitListener): void;
  once(event: "error", listener: ErrorListener): void;
  once(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") {
      this.events.once(event, listener as ExitListener);
    } else {
      this.events.once(event, listener as ErrorListener);
    }
  }

  off(event: "exit", listener: ExitListener): void;
  off(event: "error", listener: ErrorListener): void;
  off(event: "exit" | "error", listener: ExitListener | ErrorListener): void {
    if (event === "exit") {
      this.events.off(event, listener as ExitListener);
    } else {
      this.events.off(event, listener as ErrorListener);
    }
  }

  private readonly onAbort = (): void => {
    this.kill("SIGTERM");
  };

  private killChild(child: ChildProcessSpawner.ChildProcessHandle, signal: NodeJS.Signals): void {
    void Effect.runPromise(
      child.kill({
        killSignal: signal,
        forceKillAfter: this.forceKillAfter,
      }),
    ).catch((cause) => this.emitError(asError(cause)));
  }

  private consumeStdin(child: ChildProcessSpawner.ChildProcessHandle): void {
    void Effect.runPromise(
      NodeStream.fromReadable<Uint8Array, Error>({
        evaluate: () => this.stdinBridge,
        onError: asError,
      }).pipe(Stream.run(child.stdin)),
    ).catch((cause) => {
      if (!this.exited) {
        this.emitError(asError(cause));
      }
    });
  }

  private consumeStdout(child: ChildProcessSpawner.ChildProcessHandle): void {
    const source = NodeStream.toReadableNever(child.stdout);
    source.once("error", (cause) => this.emitError(asError(cause)));
    source.pipe(this.stdoutBridge);
  }

  private consumeStderr(child: ChildProcessSpawner.ChildProcessHandle): Promise<void> {
    return Effect.runPromise(
      child.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((chunk) =>
          Effect.sync(() => {
            this.options.onStderr?.(chunk);
          }),
        ),
      ),
    ).catch((cause) => {
      this.emitError(asError(cause));
    });
  }

  private async connect(): Promise<void> {
    try {
      const child = await this.options.launch;
      this.child = child;
      this.consumeStdin(child);
      this.consumeStdout(child);
      const stderrDone = this.consumeStderr(child);

      if (this.requestedKillSignal) {
        this.killChild(child, this.requestedKillSignal);
      }

      const exit = await Effect.runPromise(observeProviderProcessExit(child.exitCode));
      await stderrDone;
      const signal =
        (exit.signal as NodeJS.Signals | null) ??
        (exit.exitCode === null ? (this.requestedKillSignal ?? null) : null);
      this.exitCodeValue = exit.exitCode;
      this.exited = true;
      this.abortSignal.removeEventListener("abort", this.onAbort);
      this.options.onExit?.({ exitCode: exit.exitCode, signal });
      this.events.emit("exit", exit.exitCode, signal);
    } catch (cause) {
      this.exited = true;
      this.abortSignal.removeEventListener("abort", this.onAbort);
      this.stdinBridge.destroy();
      this.stdoutBridge.destroy();
      this.emitError(asError(cause));
    } finally {
      this.options.onSettled?.();
    }
  }

  private emitError(error: Error): void {
    if (this.errorEmitted) {
      return;
    }
    this.errorEmitted = true;
    this.events.emit("error", error);
  }
}
