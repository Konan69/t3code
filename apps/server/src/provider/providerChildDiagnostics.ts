import type { ThreadId } from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";

export const PROVIDER_STDERR_BUFFER_BYTES = 64 * 1024;
export const PROVIDER_EXIT_REASON_STDERR_BYTES = 2 * 1024;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function lastUtf8Bytes(value: string, maxBytes: number): string {
  const bytes = encoder.encode(value);
  if (bytes.length <= maxBytes) {
    return value;
  }
  return decoder.decode(bytes.slice(bytes.length - maxBytes));
}

export interface ProviderStderrBuffer {
  readonly append: (chunk: string) => void;
  readonly read: () => string;
}

export function makeProviderStderrBuffer(
  maxBytes = PROVIDER_STDERR_BUFFER_BYTES,
): ProviderStderrBuffer {
  let tail = "";
  return {
    append: (chunk) => {
      tail = lastUtf8Bytes(`${tail}${chunk}`, maxBytes);
    },
    read: () => tail,
  };
}

export interface ProviderProcessExit {
  readonly exitCode: number | null;
  readonly signal: string | null;
}

export const observeProviderProcessExit = <E>(
  exitCode: Effect.Effect<number, E>,
): Effect.Effect<ProviderProcessExit, never> =>
  exitCode.pipe(
    Effect.matchCause({
      onFailure: (cause) => {
        const detail = Cause.pretty(cause);
        const signal = /signal:\s*'([^']+)'/i.exec(detail)?.[1] ?? null;
        return { exitCode: null, signal };
      },
      onSuccess: (code) => ({ exitCode: Number(code), signal: null }),
    }),
  );

export interface ProviderChildExitDetail {
  readonly provider: string;
  readonly threadId?: ThreadId | undefined;
  readonly exitCode: number | null;
  readonly signal: string | null;
  readonly stderr: string;
}

export function formatProviderChildExitReason(input: ProviderChildExitDetail): string {
  const signal = input.signal ?? "unknown";
  const stderrTail = lastUtf8Bytes(input.stderr.trimEnd(), PROVIDER_EXIT_REASON_STDERR_BYTES);
  const exitCode = input.exitCode === null ? "unknown" : String(input.exitCode);
  const base = `${input.provider} process exited unexpectedly (exit code ${exitCode}, signal ${signal}).`;
  return stderrTail ? `${base}\nstderr tail:\n${stderrTail}` : base;
}

export const logUnexpectedProviderChildExit = (input: ProviderChildExitDetail) =>
  Effect.logWarning("Provider child process exited unexpectedly.", {
    provider: input.provider,
    ...(input.threadId !== undefined ? { threadId: input.threadId } : {}),
    exitCode: input.exitCode,
    signal: input.signal,
    stderrTail: input.stderr,
  });
