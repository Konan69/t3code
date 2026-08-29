import { ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { describe, expect } from "vite-plus/test";

import { makeAcpProcessLaunchInput } from "../provider/acp/AcpSessionRuntime.ts";
import { makeCodexProcessLaunchInput } from "../provider/Layers/CodexSessionRuntime.ts";
import { makePiProcessLaunchInput } from "../provider/Layers/PiAdapter.ts";
import { makeOpenCodeServerProcessLaunchInput } from "../provider/opencodeRuntime.ts";
import { makeHostProcessLauncher } from "./ProcessLauncher.ts";

function makeHandle() {
  return ChildProcessSpawner.makeHandle({
    pid: ChildProcessSpawner.ProcessId(42),
    exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
    isRunning: Effect.succeed(true),
    kill: () => Effect.void,
    unref: Effect.succeed(Effect.void),
    stdin: Sink.drain,
    stdout: Stream.empty,
    stderr: Stream.empty,
    all: Stream.empty,
    getInputFd: () => Sink.drain,
    getOutputFd: () => Stream.empty,
  });
}

type StandardCommand = {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly options: ChildProcess.CommandOptions;
};

const commandShape = (command: unknown): StandardCommand => {
  const standard = command as StandardCommand;
  return {
    command: standard.command,
    args: standard.args,
    options: standard.options,
  };
};

describe("HostProcessLauncher", () => {
  it("carries thread identity without adding it to the host command", () => {
    const threadId = ThreadId.make("0198-provider-thread");

    expect(
      makeCodexProcessLaunchInput({
        threadId,
        command: "codex",
        args: ["app-server"],
        cwd: "/workspace",
        env: {},
        extendEnv: true,
        shell: false,
      }).threadId,
    ).toBe(threadId);
    expect(
      makePiProcessLaunchInput({
        threadId,
        command: "pi",
        args: ["--mode", "rpc"],
        cwd: "/home/kixey/ws/packages/app",
        env: undefined,
        extendEnv: true,
        shell: false,
      }),
    ).toMatchObject({
      threadId,
      cwd: "/home/kixey/ws/packages/app",
    });
    expect(
      makeAcpProcessLaunchInput(
        { threadId, spawn: { command: "cursor-agent", args: ["acp"], cwd: "/workspace" } },
        { command: "cursor-agent", args: ["acp"], shell: false },
      ).threadId,
    ).toBe(threadId);
    expect(
      makeOpenCodeServerProcessLaunchInput({
        threadId,
        command: "opencode",
        args: ["serve"],
        hostPlatform: "linux",
        shell: false,
        environment: undefined,
      }).threadId,
    ).toBe(threadId);
  });

  it.effect("preserves every provider ChildProcess.make input and process handle", () => {
    const captured: Array<unknown> = [];
    const handle = makeHandle();
    const launcher = makeHostProcessLauncher(
      ChildProcessSpawner.make((command) => {
        captured.push(command);
        return Effect.succeed(handle);
      }),
    );
    const threadId = ThreadId.make("0198-provider-thread");
    const codexEnv = { PATH: "/opt/codex/bin", CODEX_HOME: "/home/kixey/.codex" };
    const piCwd = "C:\\Users\\kixey\\project";
    const acpEnv = { PATH: "/opt/grok/bin", GROK_OAUTH2_REFERRER: "t3code" };
    const openCodeEnv = { PATH: "/opt/opencode/bin", OPENCODE_CONFIG_CONTENT: '{"theme":"t3"}' };

    return Effect.gen(function* () {
      const handles = yield* Effect.all([
        launcher.launch(
          makeCodexProcessLaunchInput({
            threadId,
            command: "/opt/codex/bin/codex",
            args: ["app-server", "--enable", "responses_websockets_v2"],
            cwd: "/tank/project",
            env: codexEnv,
            extendEnv: false,
            shell: false,
          }),
        ),
        launcher.launch(
          makePiProcessLaunchInput({
            threadId,
            command: "pi.cmd",
            args: ["--mode", "rpc", "--no-session"],
            cwd: piCwd,
            env: undefined,
            extendEnv: true,
            shell: true,
          }),
        ),
        launcher.launch(
          makeAcpProcessLaunchInput(
            {
              threadId,
              spawn: {
                command: "grok",
                args: ["agent", "stdio"],
                cwd: "/tank/project",
                env: acpEnv,
              },
            },
            { command: "/opt/grok/bin/grok", args: ["agent", "stdio"], shell: false },
          ),
        ),
        launcher.launch(
          makeAcpProcessLaunchInput(
            {
              threadId,
              spawn: {
                command: "cursor-agent",
                args: ["acp"],
                cwd: "/tank/cursor-project",
              },
            },
            { command: "cursor-agent", args: ["acp"], shell: false },
          ),
        ),
        launcher.launch(
          makeOpenCodeServerProcessLaunchInput({
            threadId,
            command: "/opt/opencode/bin/opencode",
            args: ["serve", "--hostname=127.0.0.1", "--port=4096"],
            hostPlatform: "linux",
            shell: false,
            environment: openCodeEnv,
          }),
        ),
      ]);

      expect(handles.every((candidate) => candidate === handle)).toBe(true);
      expect(captured.map(commandShape)).toEqual(
        [
          ChildProcess.make(
            "/opt/codex/bin/codex",
            ["app-server", "--enable", "responses_websockets_v2"],
            {
              cwd: "/tank/project",
              env: codexEnv,
              extendEnv: false,
              forceKillAfter: "2 seconds",
              shell: false,
            },
          ),
          ChildProcess.make("pi.cmd", ["--mode", "rpc", "--no-session"], {
            shell: true,
            cwd: piCwd,
            env: undefined,
            extendEnv: true,
          }),
          ChildProcess.make("/opt/grok/bin/grok", ["agent", "stdio"], {
            cwd: "/tank/project",
            env: acpEnv,
            extendEnv: true,
            shell: false,
          }),
          ChildProcess.make("cursor-agent", ["acp"], {
            cwd: "/tank/cursor-project",
            shell: false,
          }),
          ChildProcess.make(
            "/opt/opencode/bin/opencode",
            ["serve", "--hostname=127.0.0.1", "--port=4096"],
            {
              detached: true,
              shell: false,
              env: openCodeEnv,
              extendEnv: false,
            },
          ),
        ].map(commandShape),
      );
    }).pipe(Effect.scoped);
  });
});
