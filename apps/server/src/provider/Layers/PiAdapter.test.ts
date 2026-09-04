import { ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { makePiLaunchArgs, readPiResumeCursor } from "./PiAdapter.ts";

const sessionId = "123e4567-e89b-42d3-a456-426614174000";

describe("PiAdapter session persistence", () => {
  it("launches pi with an explicit session id", () => {
    const args = makePiLaunchArgs({
      sessionId,
      launchArgs: ["--model", "anthropic/claude-sonnet-4"],
      mcpArgs: ["-e", "/tmp/t3-code-mcp.mjs"],
    });

    expect(args).toContain("--session-id");
    expect(args[args.indexOf("--session-id") + 1]).toBe(sessionId);
    expect(args).not.toContain("--no-session");
  });

  it("decodes a valid persisted resume cursor", () => {
    expect(
      readPiResumeCursor({
        threadId: "thread-pi-resume",
        sessionId,
        cwd: "/tmp/project",
      }),
    ).toEqual({
      threadId: ThreadId.make("thread-pi-resume"),
      sessionId,
      cwd: "/tmp/project",
    });
  });

  it("rejects malformed persisted resume cursors", () => {
    expect(
      readPiResumeCursor({
        threadId: "thread-pi-resume",
        sessionId: "not-a-uuid",
        cwd: "/tmp/project",
      }),
    ).toBeUndefined();
    expect(
      readPiResumeCursor({
        threadId: "thread-pi-resume",
        sessionId,
        cwd: "   ",
      }),
    ).toBeUndefined();
  });
});
