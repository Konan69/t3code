/**
 * Fork-only update source. The fork ships with no update feed, so the stock
 * updater is disabled; a build made on this machine is staged by
 * `~/t3code-staging/rebuild-boat.sh` and installed by `apply-boat.sh` once the
 * app has closed. Those scripts publish their progress as a small JSON status
 * file, and this module turns that file into the update state the app already
 * renders, so "Check for updates" shows the local build instead of nothing.
 *
 * The update button also starts that pipeline: the app drops a request file
 * beside the status file, `update-watch.sh` picks it up and runs
 * `update-boat.sh`, which merges the newest upstream release into the fork,
 * builds it and stages it. That run reports itself as phase "updating".
 */
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { normalizeDesktopUpdateReleaseNotes } from "./releaseNotes.ts";
import { isUpstreamReleaseOnChannel, type UpstreamReleasesSnapshot } from "./UpstreamReleases.ts";

export const LOCAL_STAGED_UPDATE_DIRECTORY = "t3code-updater";
export const LOCAL_STAGED_UPDATE_FILE = "status.json";
/** Written by the app to ask the pipeline for a build of the newest upstream release. */
export const LOCAL_STAGED_UPDATE_REQUEST_FILE = "request.json";
/** Written by the app before it quits to install: the installer reopens the app. */
export const LOCAL_STAGED_UPDATE_RELAUNCH_FILE = "relaunch.json";
// A version with a build suffix was made on this machine; see `localStagedUpdateVersion`.
const LOCAL_BUILD_TARGET_SUFFIX = "+fork";

/** The label of a fork build of an upstream release that does not exist yet. */
export const localBuildTargetVersion = (upstreamVersion: string): string =>
  `${upstreamVersion}${LOCAL_BUILD_TARGET_SUFFIX}`;

// rebuild-boat.sh already caps the list; the popover and the settings row scroll.
const MAX_NOTES = 40;

export const LocalStagedUpdateStatus = Schema.Struct({
  phase: Schema.Literals(["building", "updating", "ready", "installing", "installed", "failed"]),
  version: Schema.String,
  message: Schema.String,
  updatedAt: Schema.String,
  // The commit the staged build was made from; absent while nothing is staged.
  commit: Schema.optional(Schema.String),
  // The upstream release a requested update is building; set while that run
  // is "updating" and kept when it ends "failed".
  target: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.Array(Schema.String)),
  // The newest upstream commit merged into that build.
  upstreamBase: Schema.optional(
    Schema.Struct({ commit: Schema.String, committedAt: Schema.String }),
  ),
});
export type LocalStagedUpdateStatus = typeof LocalStagedUpdateStatus.Type;

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalStagedUpdateStatus));
const decodeCommit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ t3codeCommitHash: Schema.optional(Schema.String) })),
);

const LocalUpdateRequest = Schema.Struct({
  action: Schema.Literal("update"),
  // The release the button offered; the pipeline builds the newest one it finds.
  target: Schema.NullOr(Schema.String),
  requestedAt: Schema.String,
});
/** The text of `request.json`. */
export const encodeLocalUpdateRequest = Schema.encodeSync(
  Schema.fromJsonString(LocalUpdateRequest),
);
/** The text of `relaunch.json`. */
export const encodeLocalRelaunchRequest = Schema.encodeSync(
  Schema.fromJsonString(Schema.Struct({ requestedAt: Schema.String })),
);

/** Decodes the status file's text; anything unreadable counts as no status. */
export const parseLocalStagedUpdateStatus = (
  raw: string,
): Effect.Effect<Option.Option<LocalStagedUpdateStatus>> => decodeStatus(raw).pipe(Effect.option);

/** The commit stamped into the running app's package.json by the local build. */
export const parseRunningCommit = (packageJson: string): Effect.Effect<string | null> =>
  decodeCommit(packageJson).pipe(
    Effect.map((metadata) => metadata.t3codeCommitHash?.trim() || null),
    Effect.orElseSucceed(() => null),
  );

/** True when two states would render the same. */
export function isSameLocalStagedUpdateState(
  left: DesktopUpdateState,
  right: DesktopUpdateState,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.status === right.status &&
    left.checkedAt === right.checkedAt &&
    left.omittedReleaseCount === right.omittedReleaseCount &&
    left.availableVersion === right.availableVersion &&
    left.downloadedVersion === right.downloadedVersion &&
    left.message === right.message &&
    left.errorContext === right.errorContext &&
    left.releaseNotes.length === right.releaseNotes.length &&
    left.releaseNotes.every(
      (note, index) =>
        note.version === right.releaseNotes[index]?.version &&
        note.totalItems === right.releaseNotes[index]?.totalItems &&
        note.items.join("\n") === right.releaseNotes[index]?.items.join("\n"),
    )
  );
}

/** The staged build's label: the app version alone repeats across rebuilds. */
export function localStagedUpdateVersion(status: LocalStagedUpdateStatus): string {
  const commit = status.commit?.trim();
  return commit ? `${status.version}+${commit}` : status.version;
}

/**
 * The update state for a staging status. `runningCommit` is the commit of the
 * app that is running: a staged build made from that same commit is already
 * installed, whatever the file's phase still says. That build keeps its change
 * list, so the app can still show what the running build brought.
 *
 * `upstream` is the T3 team's release list. When the running build's upstream
 * base is known, the state also says whether newer releases exist on the
 * followed channel and lists their notes, and offers a fork build of the
 * newest one: nothing is downloaded, the build is made on this machine once
 * the update button asks for it.
 */
export function reduceDesktopUpdateStateOnLocalStagedStatus(
  state: DesktopUpdateState,
  status: Option.Option<LocalStagedUpdateStatus>,
  checkedAt: string,
  runningCommit: string | null,
  upstream: UpstreamReleasesSnapshot | null = null,
): DesktopUpdateState {
  const base: DesktopUpdateState = {
    ...state,
    enabled: true,
    status: "up-to-date",
    availableVersion: null,
    downloadedVersion: null,
    releaseNotes: [],
    omittedReleaseCount: 0,
    downloadPercent: null,
    checkedAt,
    message: null,
    errorContext: null,
    canRetry: false,
  };
  if (Option.isNone(status)) return base;

  const { phase, message, notes = [], commit } = status.value;
  const isRunning = commit !== undefined && runningCommit !== null && commit === runningCommit;
  const version = localStagedUpdateVersion(status.value);
  const releaseNotes =
    notes.length === 0
      ? []
      : [{ version, items: notes.slice(0, MAX_NOTES), totalItems: notes.length }];
  // A build nobody asked for is never shown: nothing is offered until it is staged.
  if (phase === "building") return base;
  // A requested update is this fork's download. It is checked before the
  // running-build test below: the file still names the running commit until
  // the new build is staged.
  const target = status.value.target?.trim();
  if (target && (phase === "updating" || phase === "failed")) {
    const requested = { ...base, availableVersion: localBuildTargetVersion(target) };
    return phase === "updating"
      ? { ...requested, status: "downloading", message }
      : { ...requested, status: "error", errorContext: "download", canRetry: true, message };
  }
  if (phase === "installed" || isRunning) {
    if (!isRunning) return base;
    const installed = { ...base, releaseNotes };
    const upstreamBase = status.value.upstreamBase;
    if (upstream === null || upstreamBase === undefined) return installed;
    if (upstream.releases === null) {
      return {
        ...installed,
        checkedAt: upstream.checkedAt,
        message: "Could not reach GitHub to compare with the T3 team's releases.",
      };
    }
    const onChannel = upstream.releases.filter((release) =>
      isUpstreamReleaseOnChannel(release.version, state.channel),
    );
    const latest = onChannel[0];
    if (latest === undefined) return { ...installed, checkedAt: upstream.checkedAt };
    const stale = upstream.failed ? " GitHub could not be reached on the last check." : "";
    const baseTime = Date.parse(upstreamBase.committedAt);
    const newer = onChannel.filter((release) => Date.parse(release.createdAt) > baseTime);
    const channelName = state.channel === "nightly" ? "nightly" : "stable release";
    const newerNoun =
      state.channel === "nightly"
        ? `nightly build${newer.length === 1 ? "" : "s"}`
        : `stable release${newer.length === 1 ? "" : "s"}`;
    if (newer.length === 0) {
      return {
        ...installed,
        checkedAt: upstream.checkedAt,
        message: `Your build includes the latest ${channelName}, ${latest.version}.${stale}`,
      };
    }
    const upcoming = normalizeDesktopUpdateReleaseNotes(newer, latest.version, state.channel);
    return {
      ...installed,
      status: "available",
      availableVersion: localBuildTargetVersion(latest.version),
      checkedAt: upstream.checkedAt,
      releaseNotes: upcoming.releaseNotes,
      omittedReleaseCount: upcoming.omittedReleaseCount,
      message: `${newer.length} newer ${newerNoun} from the T3 team, latest ${latest.version}. Not in your build yet.${stale}`,
    };
  }
  switch (phase) {
    case "ready":
    case "installing":
      return {
        ...base,
        status: "downloaded",
        availableVersion: version,
        downloadedVersion: version,
        downloadPercent: 100,
        releaseNotes,
        message,
      };
    case "updating":
      // Without a target there is nothing to name; treat it as a silent build.
      return base;
    case "failed":
      return { ...base, status: "error", errorContext: "download", message };
  }
}
