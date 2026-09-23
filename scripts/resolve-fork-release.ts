#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Config from "effect/Config";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

const UPSTREAM_NIGHTLY_TAG = /^v(?<core>\d+\.\d+\.\d+)-nightly\.(?<date>\d{8})\.(?<sequence>\d+)$/;
const UpstreamNightlyTag = Schema.String.check(Schema.isPattern(UPSTREAM_NIGHTLY_TAG));
const decodeUpstreamNightlyTag = Schema.decodeUnknownSync(UpstreamNightlyTag);
const FORK_SEQUENCE_SCALE = 1000n;

export interface ForkReleaseMetadata {
  readonly upstreamTag: string;
  readonly version: string;
  readonly tag: string;
  readonly name: string;
}

export function resolveForkReleaseMetadata(upstreamTag: string): ForkReleaseMetadata {
  decodeUpstreamNightlyTag(upstreamTag);
  const match = UPSTREAM_NIGHTLY_TAG.exec(upstreamTag);
  const core = match?.groups?.core;
  const date = match?.groups?.date;
  const sequence = match?.groups?.sequence;
  if (!core || !date || !sequence) {
    throw new Error(`Could not decode upstream nightly tag: ${upstreamTag}`);
  }

  // Reserve a deterministic numeric namespace for fork builds. It remains on
  // the nightly channel while sorting above the exact upstream source build.
  const forkSequence = BigInt(sequence) * FORK_SEQUENCE_SCALE + 1n;
  const version = `${core}-nightly.${date}.${forkSequence}`;
  return {
    upstreamTag,
    version,
    tag: `v${version}`,
    name: `T3 Code Fork ${version}`,
  };
}

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
