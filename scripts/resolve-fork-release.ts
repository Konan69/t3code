#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { resolveForkReleaseMetadata } from "@t3tools/shared/forkRelease";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";

export { resolveForkReleaseMetadata } from "@t3tools/shared/forkRelease";

const run = Effect.fn("resolveForkRelease.run")(function* (args: ReadonlyArray<string>) {
  const githubOutputIndex = args.indexOf("--github-output");
  const writeGithubOutput = githubOutputIndex !== -1;
  const positional = args.filter((arg) => arg !== "--github-output");
  if (positional.length !== 1 || !positional[0]) {
    return yield* Effect.die(
      new Error(
        "Usage: node scripts/resolve-fork-release.ts <upstream-nightly-tag> [--github-output]",
      ),
    );
  }

  const metadata = resolveForkReleaseMetadata(positional[0]);
  const output = [
    `upstream_tag=${metadata.upstreamTag}`,
    `version=${metadata.version}`,
    `tag=${metadata.tag}`,
    `name=${metadata.name}`,
  ].join("\n");

  if (writeGithubOutput) {
    const fs = yield* FileSystem.FileSystem;
    const githubOutput = yield* Config.NonEmptyString("GITHUB_OUTPUT");
    yield* fs.writeFileString(githubOutput, `${output}\n`, { flag: "a" });
  } else {
    yield* Console.log(output);
  }
});

if (import.meta.main) {
  run(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
