import { ThreadId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { describe, expect, it } from "vite-plus/test";

import { processLaunchLogFields } from "../process/ProcessLauncher.ts";
import {
  formatProviderChildExitReason,
  makeProviderStderrBuffer,
  observeProviderProcessExit,
} from "./providerChildDiagnostics.ts";

describe("provider child diagnostics", () => {
  it("retains only the configured stderr tail", () => {
    const buffer = makeProviderStderrBuffer(8);
    buffer.append("first-");
    buffer.append("second");

    expect(buffer.read()).toBe("t-second");
  });

  it("formats exit metadata with only the last 2 KB of stderr", () => {
    const reason = formatProviderChildExitReason({
      provider: "pi",
      threadId: ThreadId.make("thread-1"),
      exitCode: 127,
      signal: null,
      stderr: `discarded-start-${"x".repeat(3_000)}fatal: command not found`,
    });

    expect(reason).toContain("pi process exited unexpectedly (exit code 127, signal unknown)");
    expect(reason).toContain("fatal: command not found");
    expect(reason).not.toContain("discarded-start");
    expect(
      new TextEncoder().encode(reason.split("stderr tail:\n")[1] ?? "").length,
    ).toBeLessThanOrEqual(2 * 1024);
  });

  it("retains a terminating signal when the exit-code effect fails", async () => {
    const exit = await Effect.runPromise(
      observeProviderProcessExit(
        Effect.die("Process interrupted due to receipt of signal: 'SIGKILL'"),
      ),
    );

    expect(exit).toEqual({ exitCode: null, signal: "SIGKILL" });
  });

  it("logs spawn environment keys without values", () => {
    const fields = processLaunchLogFields({
      threadId: ThreadId.make("thread-1"),
      command: "pi",
      args: ["--mode", "rpc"],
      cwd: "/repo",
      env: { PATH: "/secret/path", API_TOKEN: "secret" },
    });

    expect(fields).toEqual({
      threadId: ThreadId.make("thread-1"),
      command: "pi",
      args: ["--mode", "rpc"],
      cwd: "/repo",
      envKeys: ["API_TOKEN", "PATH"],
    });
    expect(JSON.stringify(fields)).not.toContain("secret");
  });
});
