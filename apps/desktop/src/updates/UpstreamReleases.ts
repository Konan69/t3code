/**
 * Fork-only. The fork has no update feed, but "Check for updates" should still
 * say where this build stands against the T3 team's releases. This asks GitHub
 * for the upstream release list; LocalStagedUpdate.ts compares it with the
 * upstream commit the running build was made from.
 */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

// One page of 100 is the API's maximum and covers weeks of nightlies; a build
// further behind than that under-counts the newer releases.
const UPSTREAM_RELEASES_URL = "https://api.github.com/repos/pingdotgg/t3code/releases?per_page=100";

const GitHubReleases = Schema.Array(
  Schema.Struct({
    tag_name: Schema.String,
    created_at: Schema.String,
    draft: Schema.Boolean,
    body: Schema.NullOr(Schema.String),
  }),
);
const decodeReleases = Schema.decodeUnknownEffect(GitHubReleases);

export interface UpstreamRelease {
  readonly version: string;
  /** When the released commit was made; GitHub reports it as `created_at`. */
  readonly createdAt: string;
  readonly note: string | null;
}

/**
 * The last answer from GitHub. `releases` is null when no request has
 * succeeded yet; `checkedAt` is the time of the last request that did, or of
 * the first failure. `failed` is true when the latest request did not succeed.
 */
export interface UpstreamReleasesSnapshot {
  readonly checkedAt: string;
  readonly releases: ReadonlyArray<UpstreamRelease> | null;
  readonly failed: boolean;
}

/** Whether a release version belongs to the channel; preview cuts belong to neither. */
export function isUpstreamReleaseOnChannel(
  version: string,
  channel: "latest" | "nightly",
): boolean {
  return channel === "nightly"
    ? /^[^-+]+-nightly\.\d{8}\.\d+$/.test(version)
    : /^[^-+]+$/.test(version);
}

export const fetchUpstreamReleases = (
  http: HttpClient.HttpClient,
): Effect.Effect<ReadonlyArray<UpstreamRelease> | null> =>
  Effect.gen(function* () {
    const response = yield* http.execute(
      HttpClientRequest.get(UPSTREAM_RELEASES_URL).pipe(
        HttpClientRequest.setHeader("accept", "application/vnd.github+json"),
        HttpClientRequest.setHeader("user-agent", "t3code-boat"),
      ),
    );
    if (response.status < 200 || response.status >= 300) return null;
    const releases = yield* decodeReleases(yield* response.json);
    return releases
      .filter((release) => !release.draft)
      .map((release) => ({
        version: release.tag_name.replace(/^v/, ""),
        createdAt: release.created_at,
        note: release.body,
      }));
  }).pipe(
    Effect.scoped,
    Effect.timeout("20 seconds"),
    Effect.orElseSucceed(() => null),
    Effect.withSpan("desktop.updates.fetchUpstreamReleases"),
  );
