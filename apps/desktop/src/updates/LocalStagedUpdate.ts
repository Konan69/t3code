/**
 * Fork-only update source. The fork ships with no update feed, so the stock
 * updater is disabled; a build made on this machine is staged by
 * `~/t3code-staging/rebuild-boat.sh` and installed by `apply-boat.sh` once the
 * app has closed. Those scripts publish their progress as a small JSON status
 * file, and this module turns that file into the update state the app already
 * renders, so "Check for updates" shows the local build instead of nothing.
 */
import type { DesktopUpdateState } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

export const LOCAL_STAGED_UPDATE_DIRECTORY = "t3code-updater";
export const LOCAL_STAGED_UPDATE_FILE = "status.json";

const MAX_NOTES = 8;

export const LocalStagedUpdateStatus = Schema.Struct({
  phase: Schema.Literals(["building", "ready", "installing", "installed", "failed"]),
  version: Schema.String,
  message: Schema.String,
  updatedAt: Schema.String,
  // The commit the staged build was made from; absent while nothing is staged.
  commit: Schema.optional(Schema.String),
  notes: Schema.optional(Schema.Array(Schema.String)),
});
export type LocalStagedUpdateStatus = typeof LocalStagedUpdateStatus.Type;

const decodeStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalStagedUpdateStatus));
const decodeCommit = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Struct({ t3codeCommitHash: Schema.optional(Schema.String) })),
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

/** True when two states would render the same; `checkedAt` alone is not a change. */
export function isSameLocalStagedUpdateState(
  left: DesktopUpdateState,
  right: DesktopUpdateState,
): boolean {
  return (
    left.enabled === right.enabled &&
    left.status === right.status &&
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
 * installed, whatever the file's phase still says.
 */
export function reduceDesktopUpdateStateOnLocalStagedStatus(
  state: DesktopUpdateState,
  status: Option.Option<LocalStagedUpdateStatus>,
  checkedAt: string,
  runningCommit: string | null,
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
  if (phase === "installed" || (isRunning && phase !== "building")) return base;

  const version = localStagedUpdateVersion(status.value);
  const releaseNotes =
    notes.length === 0
      ? []
      : [{ version, items: notes.slice(0, MAX_NOTES), totalItems: notes.length }];
  switch (phase) {
    case "building":
      return { ...base, status: "downloading", availableVersion: version, releaseNotes, message };
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
    case "failed":
      return { ...base, status: "error", errorContext: "download", message };
  }
}
