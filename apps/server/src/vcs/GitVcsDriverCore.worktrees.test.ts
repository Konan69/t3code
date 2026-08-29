import { assert, describe, it } from "@effect/vitest";

import { parseGitWorktreePorcelain } from "./GitVcsDriverCore.ts";

describe("parseGitWorktreePorcelain", () => {
  it("keeps locked, prunable, and detached worktree registrations", () => {
    const stdout = [
      "worktree /repo",
      "HEAD aaaaaaaa",
      "branch refs/heads/main",
      "locked in-use",
      "",
      "worktree /stale",
      "HEAD bbbbbbbb",
      "branch refs/heads/feature/stale",
      "prunable gitdir file points to non-existent location",
      "",
      "worktree /detached",
      "HEAD cccccccc",
      "detached",
      "",
    ].join("\0");

    assert.deepStrictEqual(parseGitWorktreePorcelain(stdout), [
      { path: "/repo", refName: "main", locked: true, prunable: false },
      { path: "/stale", refName: "feature/stale", locked: false, prunable: true },
      { path: "/detached", refName: null, locked: false, prunable: false },
    ]);
  });
});
