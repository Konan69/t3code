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

  it("rebuilds a fork release unless every required asset is present", () => {
    const forkRelease = readWorkflow("fork-release.yml");

    expect(forkRelease).toContain("name: Check for a complete fork release");
    expect(forkRelease).toContain("'nightly.yml'");
    expect(forkRelease).toContain(
      "const installer = `T3-Code-${process.env.FORK_VERSION}-x64.exe`",
    );
    expect(forkRelease).toContain("`${installer}.blockmap`");
    expect(forkRelease).toContain("`t3-${process.env.FORK_VERSION}-linux-x64.tar.gz`");
    expect(forkRelease).toContain(
      "const missingAssets = requiredAssets.filter((asset) => !publishedAssets.has(asset))",
    );
    expect(forkRelease).toContain("if (missingAssets.length === 0)");
    expect(forkRelease).toContain(
      "Fork release is incomplete; rebuilding missing assets: ${missingAssets.join(', ')}",
    );
  });
});
