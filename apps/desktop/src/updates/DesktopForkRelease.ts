import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Data from "effect/Data";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";

import { resolveForkReleaseMetadata } from "@t3tools/shared/forkRelease";
import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";

declare const __T3CODE_BUILD_DESKTOP_FORK_REPOSITORY__: string | undefined;
declare const __T3CODE_BUILD_DESKTOP_FORK_BRANCH__: string | undefined;

const GITHUB_API_URL = "https://api.github.com";
const GITHUB_USER = "Konan69";
const WORKFLOW_FILE = "fork-release.yml";
const TOKEN_TIMEOUT = Duration.seconds(30);
const POLL_INTERVAL = Duration.seconds(5);
const RUN_DISCOVERY_POLL_LIMIT = 120;
const RUN_COMPLETION_POLL_LIMIT = 2880;
const RELEASE_POLL_LIMIT = 120;

const ForkReleaseConfigurationSchema = Schema.Struct({
  owner: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
  repo: Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+$/)),
  branch: Schema.String.check(Schema.isMinLength(1)),
});

export interface ForkReleaseConfiguration {
  readonly owner: string;
  readonly repo: string;
  readonly branch: string;
}

const decodeForkReleaseConfiguration = Schema.decodeUnknownSync(ForkReleaseConfigurationSchema);

export function resolveForkReleaseConfiguration(
  repository: string | undefined,
  branch: string | undefined,
): Option.Option<ForkReleaseConfiguration> {
  const normalizedRepository = repository?.trim() ?? "";
  const normalizedBranch = branch?.trim() ?? "";
  if (!normalizedRepository && !normalizedBranch) return Option.none();
  if (!normalizedRepository || !normalizedBranch) {
    throw new Error(
      "Fork desktop updates require both T3CODE_DESKTOP_FORK_REPOSITORY and T3CODE_DESKTOP_FORK_BRANCH at build time.",
    );
  }
  const [owner, repo, ...rest] = normalizedRepository.split("/");
  if (!owner || !repo || rest.length > 0) {
    throw new Error(`Invalid fork desktop update repository: ${normalizedRepository}`);
  }
  return Option.some(decodeForkReleaseConfiguration({ owner, repo, branch: normalizedBranch }));
}

export class DesktopForkReleaseTokenMissingError extends Schema.TaggedError<DesktopForkReleaseTokenMissingError>()(
  "DesktopForkReleaseTokenMissingError",
  {
    upstreamTag: Schema.String,
    runUrl: Schema.NullOr(Schema.String),
  },
) {
  override get message(): string {
    return `GitHub CLI authentication for ${GITHUB_USER} is required in WSL before this fork update can be built.`;
  }
}

export class DesktopForkReleaseDispatchFailedError extends Schema.TaggedError<DesktopForkReleaseDispatchFailedError>()(
  "DesktopForkReleaseDispatchFailedError",
  {
    upstreamTag: Schema.String,
    runUrl: Schema.NullOr(Schema.String),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The fork release workflow could not be dispatched.";
  }
}

class GitHubResponseError extends Data.TaggedError("GitHubResponseError")<{
  readonly message: string;
}> {}

export class DesktopForkReleaseRunFailedError extends Schema.TaggedError<DesktopForkReleaseRunFailedError>()(
  "DesktopForkReleaseRunFailedError",
  {
    upstreamTag: Schema.String,
    runUrl: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return "The fork release workflow did not publish the requested update.";
  }
}

export const DesktopForkReleaseError = Schema.Union([
  DesktopForkReleaseTokenMissingError,
  DesktopForkReleaseDispatchFailedError,
  DesktopForkReleaseRunFailedError,
]);
export type DesktopForkReleaseError = typeof DesktopForkReleaseError.Type;

export interface EnsureForkReleaseInput {
  readonly upstreamTag: string;
  readonly distro: string | null;
  readonly onRunStarted: (runUrl: string) => Effect.Effect<void>;
}

export interface EnsureForkReleaseResult {
  readonly version: string;
  readonly tag: string;
  readonly alreadyBuilt: boolean;
}

export class DesktopForkRelease extends Context.Service<
  DesktopForkRelease,
  {
    readonly configuration: Option.Option<ForkReleaseConfiguration>;
    readonly ensureRelease: (
      input: EnsureForkReleaseInput,
    ) => Effect.Effect<EnsureForkReleaseResult, DesktopForkReleaseError>;
  }
>()("@t3tools/desktop/updates/DesktopForkRelease") {}

const Release = Schema.Struct({
  tag_name: Schema.String,
  assets: Schema.Array(Schema.Struct({ name: Schema.String })),
});
const decodeRelease = Schema.decodeUnknownEffect(Schema.fromJsonString(Release));

export function requiredForkReleaseAssetNames(version: string): ReadonlyArray<string> {
  const installer = `T3-Code-${version}-x64.exe`;
  return ["nightly.yml", installer, `${installer}.blockmap`, `t3-${version}-linux-x64.tar.gz`];
}
const WorkflowRun = Schema.Struct({
  id: Schema.Number,
  status: Schema.String,
  conclusion: Schema.NullOr(Schema.String),
  html_url: Schema.String,
  display_title: Schema.String,
});
const WorkflowRuns = Schema.Struct({ workflow_runs: Schema.Array(WorkflowRun) });
const decodeWorkflowRuns = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRuns));
const decodeWorkflowRun = Schema.decodeUnknownEffect(Schema.fromJsonString(WorkflowRun));

const buildHeaders = (token?: string) => ({
  Accept: "application/vnd.github+json",
  "X-GitHub-Api-Version": "2022-11-28",
  "User-Agent": "t3code-desktop-fork-updater",
  ...(token === undefined ? {} : { Authorization: `Bearer ${token}` }),
});

/** @public Service construction is part of the canonical Effect module API. */
export const makeWithConfiguration = (configuration: Option.Option<ForkReleaseConfiguration>) =>
  Effect.gen(function* () {
    const httpClient = yield* HttpClient.HttpClient;
    const wsl = yield* DesktopWslEnvironment.DesktopWslEnvironment;
    const requestSequence = yield* Ref.make(0);

    const ensureRelease = Effect.fn("desktop.forkRelease.ensureRelease")(function* (
      input: EnsureForkReleaseInput,
    ) {
      const config = Option.getOrThrow(configuration);
      const metadata = resolveForkReleaseMetadata(input.upstreamTag);
      const releaseUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/releases/tags/${encodeURIComponent(metadata.tag)}`;
      const workflowUrl = `${GITHUB_API_URL}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/workflows/${WORKFLOW_FILE}`;

      const execute = (request: HttpClientRequest.HttpClientRequest, token?: string) =>
        httpClient.execute(request.pipe(HttpClientRequest.setHeaders(buildHeaders(token))));

      const releaseIsReady = (token?: string) =>
        execute(HttpClientRequest.get(releaseUrl), token).pipe(
          Effect.mapError(
            (cause) =>
              new GitHubResponseError({
                message: `GitHub release lookup failed: ${String(cause)}`,
              }),
          ),
          Effect.flatMap((response) => {
            if (response.status === 404) return Effect.succeed(false);
            if (response.status !== 200) {
              return Effect.fail(
                new GitHubResponseError({
                  message: `GitHub release lookup returned ${response.status}.`,
                }),
              );
            }
            return response.text.pipe(
              Effect.flatMap(decodeRelease),
              Effect.mapError(
                (cause) =>
                  new GitHubResponseError({
                    message: `GitHub release response was invalid: ${String(cause)}`,
                  }),
              ),
              Effect.map((release) => {
                if (release.tag_name !== metadata.tag) return false;
                const assets = new Set(release.assets.map(({ name }) => name));
                return requiredForkReleaseAssetNames(metadata.version).every((name) =>
                  assets.has(name),
                );
              }),
            );
          }),
        );

      const tokenResult = yield* wsl.runCommand(
        input.distro,
        "gh",
        ["auth", "token", "--user", GITHUB_USER],
        TOKEN_TIMEOUT,
      );
      const token = tokenResult.stdout.trim();
      if (
        tokenResult.exitCode !== 0 ||
        tokenResult.transportFailure !== null ||
        token.length === 0
      ) {
        return yield* new DesktopForkReleaseTokenMissingError({
          upstreamTag: input.upstreamTag,
          runUrl: null,
        });
      }

      const existing = yield* releaseIsReady(token).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopForkReleaseDispatchFailedError({
              upstreamTag: input.upstreamTag,
              runUrl: null,
              cause,
            }),
        ),
      );
      if (existing) {
        return { version: metadata.version, tag: metadata.tag, alreadyBuilt: true };
      }

      const now = yield* Clock.currentTimeMillis;
      const sequence = yield* Ref.getAndUpdate(requestSequence, (value) => value + 1);
      const requestId = `desktop-${now}-${sequence}`;
      const expectedTitle = `Fork release ${input.upstreamTag} (${requestId})`;
      const dispatchResponse = yield* execute(
        HttpClientRequest.post(`${workflowUrl}/dispatches`).pipe(
          HttpClientRequest.bodyJsonUnsafe({
            ref: config.branch,
            inputs: {
              upstream_tag: input.upstreamTag,
              branch: config.branch,
              request_id: requestId,
            },
          }),
        ),
        token,
      ).pipe(
        Effect.mapError(
          (cause) =>
            new DesktopForkReleaseDispatchFailedError({
              upstreamTag: input.upstreamTag,
              runUrl: null,
              cause,
            }),
        ),
      );
      if (dispatchResponse.status !== 204) {
        return yield* new DesktopForkReleaseDispatchFailedError({
          upstreamTag: input.upstreamTag,
          runUrl: null,
          cause: new Error(`GitHub workflow dispatch returned ${dispatchResponse.status}.`),
        });
      }

      let run: typeof WorkflowRun.Type | undefined;
      for (let attempt = 0; attempt < RUN_DISCOVERY_POLL_LIMIT; attempt += 1) {
        const response = yield* execute(
          HttpClientRequest.get(
            `${workflowUrl}/runs?event=workflow_dispatch&branch=${encodeURIComponent(config.branch)}&per_page=50`,
          ),
          token,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopForkReleaseDispatchFailedError({
                upstreamTag: input.upstreamTag,
                runUrl: null,
                cause,
              }),
          ),
        );
        if (response.status !== 200) {
          return yield* new DesktopForkReleaseDispatchFailedError({
            upstreamTag: input.upstreamTag,
            runUrl: null,
            cause: new Error(`GitHub workflow run lookup returned ${response.status}.`),
          });
        }
        const runs = yield* response.text.pipe(
          Effect.flatMap(decodeWorkflowRuns),
          Effect.mapError(
            (cause) =>
              new DesktopForkReleaseDispatchFailedError({
                upstreamTag: input.upstreamTag,
                runUrl: null,
                cause,
              }),
          ),
        );
        run = runs.workflow_runs.find((candidate) => candidate.display_title === expectedTitle);
        if (run !== undefined) break;
        yield* Effect.sleep(POLL_INTERVAL);
      }
      if (run === undefined) {
        return yield* new DesktopForkReleaseDispatchFailedError({
          upstreamTag: input.upstreamTag,
          runUrl: null,
          cause: new Error("The dispatched workflow run did not appear."),
        });
      }

      let currentRun = run;
      yield* input.onRunStarted(currentRun.html_url);
      for (let attempt = 0; attempt < RUN_COMPLETION_POLL_LIMIT; attempt += 1) {
        if (currentRun.status === "completed") break;
        yield* Effect.sleep(POLL_INTERVAL);
        const currentRunUrl = currentRun.html_url;
        const response = yield* execute(
          HttpClientRequest.get(
            `${GITHUB_API_URL}/repos/${encodeURIComponent(config.owner)}/${encodeURIComponent(config.repo)}/actions/runs/${currentRun.id}`,
          ),
          token,
        ).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopForkReleaseRunFailedError({
                upstreamTag: input.upstreamTag,
                runUrl: currentRunUrl,
                cause,
              }),
          ),
        );
        if (response.status !== 200) {
          return yield* new DesktopForkReleaseRunFailedError({
            upstreamTag: input.upstreamTag,
            runUrl: currentRunUrl,
            cause: new Error(`GitHub workflow run lookup returned ${response.status}.`),
          });
        }
        currentRun = yield* response.text.pipe(
          Effect.flatMap(decodeWorkflowRun),
          Effect.mapError(
            (cause) =>
              new DesktopForkReleaseRunFailedError({
                upstreamTag: input.upstreamTag,
                runUrl: currentRunUrl,
                cause,
              }),
          ),
        );
      }
      if (currentRun.status !== "completed") {
        return yield* new DesktopForkReleaseRunFailedError({
          upstreamTag: input.upstreamTag,
          runUrl: currentRun.html_url,
          cause: new Error("Timed out waiting for the fork release workflow."),
        });
      }
      if (currentRun.conclusion !== "success") {
        return yield* new DesktopForkReleaseRunFailedError({
          upstreamTag: input.upstreamTag,
          runUrl: currentRun.html_url,
          cause: new Error(
            `Fork release workflow concluded with ${currentRun.conclusion ?? "no conclusion"}.`,
          ),
        });
      }

      for (let attempt = 0; attempt < RELEASE_POLL_LIMIT; attempt += 1) {
        const published = yield* releaseIsReady(token).pipe(
          Effect.mapError(
            (cause) =>
              new DesktopForkReleaseRunFailedError({
                upstreamTag: input.upstreamTag,
                runUrl: currentRun.html_url,
                cause,
              }),
          ),
        );
        if (published) {
          return { version: metadata.version, tag: metadata.tag, alreadyBuilt: false };
        }
        yield* Effect.sleep(POLL_INTERVAL);
      }
      return yield* new DesktopForkReleaseRunFailedError({
        upstreamTag: input.upstreamTag,
        runUrl: currentRun.html_url,
        cause: new Error("The fork release did not appear after the workflow completed."),
      });
    });

    return DesktopForkRelease.of({ configuration, ensureRelease });
  });

export const make = makeWithConfiguration(
  resolveForkReleaseConfiguration(
    typeof __T3CODE_BUILD_DESKTOP_FORK_REPOSITORY__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_DESKTOP_FORK_REPOSITORY__,
    typeof __T3CODE_BUILD_DESKTOP_FORK_BRANCH__ === "undefined"
      ? undefined
      : __T3CODE_BUILD_DESKTOP_FORK_BRANCH__,
  ),
);

export const layer = Layer.effect(DesktopForkRelease, make);
