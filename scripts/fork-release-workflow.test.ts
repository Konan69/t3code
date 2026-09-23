// @effect-diagnostics nodeBuiltinImport:off - Verifies release workflow safety invariants as source configuration.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

const repositoryRoot = NodePath.resolve(import.meta.dirname, "..");
const readWorkflow = (name: string) =>
  NodeFS.readFileSync(NodePath.join(repositoryRoot, ".github/workflows", name), "utf8");

describe("fork release workflow", () => {
  it("forces the fork Windows build unsigned even when signing secrets are inherited", () => {
    const forkRelease = readWorkflow("fork-release.yml");
    const releaseDesktop = readWorkflow("release-desktop.yml");

    expect(forkRelease).toMatch(
      /desktop_win_x64:[\s\S]*?uses: \.\/\.github\/workflows\/release-desktop\.yml[\s\S]*?unsigned: true/,
    );
    expect(releaseDesktop).toContain(
      "if: inputs.desktop_artifact && inputs.platform == 'win' && !inputs.unsigned",
    );
    expect(releaseDesktop).toContain('if [[ "${{ inputs.unsigned }}" == "true" ]]; then');
    expect(releaseDesktop).toContain("Windows signing explicitly disabled for this build.");
  });
});
