// @effect-diagnostics nodeBuiltinImport:off
import * as NodeChildProcess from "node:child_process";

import { describe, expect, it } from "@effect/vitest";

import { AGENT_OOM_SCORE_ADJ, agentScopeCommand, unwrapAgentScopeCommand } from "./AgentScope.ts";
import * as HostProcess from "./HostProcess.ts";

describe.skipIf(HostProcess.Platform.defaultValue() !== "linux")("agentScopeCommand", () => {
  it("raises the OOM score and execs the command with its arguments in the same process", () => {
    const launch = agentScopeCommand({
      command: "/bin/sh",
      args: [
        "-c",
        'printf "%s\\n" "$$" "$(cat /proc/self/oom_score_adj)" "$@"',
        "agent",
        "a b",
        "$HOME",
      ],
    });
    const child = NodeChildProcess.spawnSync(launch.command, [...launch.args], {
      encoding: "utf8",
    });
    const [pid, score, ...args] = child.stdout.trimEnd().split("\n");
    expect(Number(pid)).toBe(child.pid);
    expect(Number(score)).toBe(AGENT_OOM_SCORE_ADJ);
    expect(args).toEqual(["a b", "$HOME"]);
  });
});

describe("unwrapAgentScopeCommand", () => {
  const original = { command: "/usr/bin/codex", args: ["app-server", "--", "a b"] };

  it("recovers the command from both wrapper forms", () => {
    expect(unwrapAgentScopeCommand(agentScopeCommand(original))).toEqual(original);
    expect(
      unwrapAgentScopeCommand(
        agentScopeCommand({
          ...original,
          scope: {
            systemdRun: "/usr/bin/systemd-run",
            slice: "t3code-agents.slice",
            unit: "t3code-codex-1234.scope",
            runtimeDir: "/run/user/1000",
            options: ["--property=OOMPolicy=stop", "--collect"],
          },
        }),
      ),
    ).toEqual(original);
  });

  it("leaves any other command unchanged", () => {
    const shell = { command: "/bin/sh", args: ["-c", "echo hi", "t3-agent", "x"] };
    expect(unwrapAgentScopeCommand(shell)).toBe(shell);
    expect(unwrapAgentScopeCommand(original)).toBe(original);
  });
});
