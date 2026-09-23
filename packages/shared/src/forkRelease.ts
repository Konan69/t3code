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

  const forkSequence = BigInt(sequence) * FORK_SEQUENCE_SCALE + 1n;
  const version = `${core}-nightly.${date}.${forkSequence}`;
  return {
    upstreamTag,
    version,
    tag: `v${version}`,
    name: `T3 Code Fork ${version}`,
  };
}
