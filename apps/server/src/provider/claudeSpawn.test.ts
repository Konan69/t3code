// @effect-diagnostics nodeBuiltinImport:off
import type { Readable } from "node:stream";

import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  CLAUDE_PROCESS_FORCE_KILL_AFTER,
  ClaudeSpawnedProcess,
  makeClaudeProcessLaunchInput,
} from "./claudeSpawn.ts";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function makeFakeHandle(input?: { readonly stdout?: string; readonly stderr?: string }) {
  let running = true;
  let resolveExit: ((code: number) => void) | undefined;
  let resolveKill:
    | ((options: Parameters<ChildProcessSpawner.ChildProcessHandle["kill"]>[0]) => void)
    | undefined;
  const exit = new Promise<number>((resolve) => {
    resolveExit = resolve;
  });
  const killCalled = new Promise<Parameters<ChildProcessSpawner.ChildProcessHandle["kill"]>[0]>(
    (resolve) => {
      resolveKill = resolve;
    },
  );
  const stdinChunks: Array<string> = [];

  const handle = ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Effect.promise(() => exit).pipe(
      Effect.map((code) => ChildProcessSpawner.ExitCode(code)),
    ),
    isRunning: Effect.sync(() => running),
    kill: (options) =>
      Effect.sync(() => {
        resolveKill?.(options);
      }),
    unref: Effect.succeed(Effect.void),
    stdin: Sink.forEach((chunk: Uint8Array) =>
      Effect.sync(() => {
        stdinChunks.push(decoder.decode(chunk));
      }),
    ),
    stdout: input?.stdout ? Stream.make(encoder.encode(input.stdout)) : Stream.empty,
    stderr: input?.stderr ? Stream.make(encoder.encode(input.stderr)) : Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });

  return {
    handle,
    stdinChunks,
    killCalled,
    exit: (code: number) => {
      running = false;
      resolveExit?.(code);
    },
  };
}

async function readAll(readable: Readable): Promise<string> {
  let result = "";
  for await (const chunk of readable) {
    result += Buffer.from(chunk as Uint8Array).toString("utf8");
  }
  return result;
}

function waitForExit(process: ClaudeSpawnedProcess) {
  return new Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>(
    (resolve, reject) => {
      process.once("exit", (code, signal) => resolve({ code, signal }));
      process.once("error", reject);
    },
  );
}

describe("ClaudeSpawnedProcess", () => {
  it("maps the SDK's full spawn contract to ProcessLauncher input", () => {
    expect(
      makeClaudeProcessLaunchInput({
        threadId: ThreadId.make("thread-claude-machine"),
        options: {
          command: "/host/bin/claude",
          args: ["--output-format", "stream-json"],
          cwd: "/tank/threads/thread-claude-machine/ws",
          env: {
            HOME: "/home/host-user",
            PATH: "/host/bin",
            T3_MCP_SERVER_URL: "http://127.0.0.1:3773/mcp",
          },
          signal: new AbortController().signal,
        },
      }),
    ).toEqual({
      threadId: ThreadId.make("thread-claude-machine"),
      command: "/host/bin/claude",
      args: ["--output-format", "stream-json"],
      cwd: "/tank/threads/thread-claude-machine/ws",
      env: {
        HOME: "/home/host-user",
        PATH: "/host/bin",
        T3_MCP_SERVER_URL: "http://127.0.0.1:3773/mcp",
      },
      extendEnv: false,
      forceKillAfter: CLAUDE_PROCESS_FORCE_KILL_AFTER,
    });
  });

  it("wires stdin/stdout, captures stderr, and emits exit", async () => {
    const fake = makeFakeHandle({ stdout: "sdk output\n", stderr: "diagnostic tail\n" });
    const stderr: Array<string> = [];
    const observedExits: Array<{
      readonly exitCode: number | null;
      readonly signal: string | null;
    }> = [];
    const process = new ClaudeSpawnedProcess({
      launch: Promise.resolve(fake.handle),
      signal: new AbortController().signal,
      onStderr: (chunk) => stderr.push(chunk),
      onExit: (exit) => observedExits.push(exit),
    });
    const stdout = readAll(process.stdout);
    const exited = waitForExit(process);

    process.stdin.end("sdk input\n");
    fake.exit(7);

    await expect(stdout).resolves.toBe("sdk output\n");
    await expect(exited).resolves.toEqual({ code: 7, signal: null });
    expect(fake.stdinChunks.join("")).toBe("sdk input\n");
    expect(stderr.join("")).toBe("diagnostic tail\n");
    expect(observedExits).toEqual([{ exitCode: 7, signal: null }]);
    expect(process.exitCode).toBe(7);
    expect(process.killed).toBe(false);
  });

  it("maps kill and abort to the Effect handle with force-kill escalation", async () => {
    const killed = makeFakeHandle();
    const killedProcess = new ClaudeSpawnedProcess({
      launch: Promise.resolve(killed.handle),
      signal: new AbortController().signal,
    });

    expect(killedProcess.kill("SIGKILL")).toBe(true);
    expect(killedProcess.kill("SIGTERM")).toBe(false);
    await expect(killed.killCalled).resolves.toEqual({
      killSignal: "SIGKILL",
      forceKillAfter: CLAUDE_PROCESS_FORCE_KILL_AFTER,
    });
    killed.exit(0);
    await expect(waitForExit(killedProcess)).resolves.toEqual({ code: 0, signal: null });

    const aborted = makeFakeHandle();
    const abortController = new AbortController();
    const abortedProcess = new ClaudeSpawnedProcess({
      launch: Promise.resolve(aborted.handle),
      signal: abortController.signal,
    });
    abortController.abort();

    await expect(aborted.killCalled).resolves.toEqual({
      killSignal: "SIGTERM",
      forceKillAfter: CLAUDE_PROCESS_FORCE_KILL_AFTER,
    });
    expect(abortedProcess.killed).toBe(true);
    aborted.exit(0);
    await expect(waitForExit(abortedProcess)).resolves.toEqual({ code: 0, signal: null });
  });

  it("emits process launch failures through the SDK error event", async () => {
    const cause = new Error("launcher unavailable");
    let settled = false;
    const process = new ClaudeSpawnedProcess({
      launch: Promise.reject(cause),
      signal: new AbortController().signal,
      onSettled: () => {
        settled = true;
      },
    });

    const error = await new Promise<Error>((resolve) => {
      process.once("error", resolve);
    });
    expect(error).toBe(cause);
    expect(settled).toBe(true);
  });
});
