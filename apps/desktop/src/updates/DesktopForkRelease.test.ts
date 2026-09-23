import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as HttpClient from "effect/unstable/http/HttpClient";
import * as HttpClientRequest from "effect/unstable/http/HttpClientRequest";
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse";

import * as DesktopWslEnvironment from "../wsl/DesktopWslEnvironment.ts";
import * as DesktopForkRelease from "./DesktopForkRelease.ts";

const upstreamTag = "v1.2.4-nightly.20260709.766";
const forkTag = "v1.2.4-nightly.20260709.766.1";
const configuration = Option.some({
  owner: "Konan69",
  repo: "t3code",
  branch: "local/fork-feed",
});

const response = (request: HttpClientRequest.HttpClientRequest, status: number, body?: unknown) =>
  HttpClientResponse.fromWeb(
    request,
    body === undefined ? new Response(null, { status }) : Response.json(body, { status }),
  );

function makeService(
  handler: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<HttpClientResponse.HttpClientResponse>,
  runCommand: DesktopWslEnvironment.DesktopWslEnvironmentTestStub["runCommand"] = () => ({
    exitCode: 0,
    stdout: "github-token\n",
    stderr: "",
    transportFailure: null,
  }),
) {
  return DesktopForkRelease.makeWithConfiguration(configuration).pipe(
    Effect.provide(
      Layer.merge(
        Layer.succeed(HttpClient.HttpClient, HttpClient.make(handler)),
        DesktopWslEnvironment.layerTest({ runCommand }),
      ),
    ),
  );
}

const readDispatchRequestId = (request: HttpClientRequest.HttpClientRequest): string =>
  request.body._tag === "Uint8Array"
    ? JSON.parse(new TextDecoder().decode(request.body.body)).inputs.request_id
    : "";

const ensureInput = (runUrls: string[]) => ({
  upstreamTag,
  distro: "Ubuntu",
  onRunStarted: (runUrl: string) =>
    Effect.sync(() => {
      runUrls.push(runUrl);
    }),
});

describe("DesktopForkRelease", () => {
  it.effect("returns an already-built release without dispatching", () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const commands: Array<readonly [string | null, string, ReadonlyArray<string>]> = [];
      const service = yield* makeService(
        (request) =>
          Effect.sync(() => {
            requests.push(request);
            return response(request, 200, { tag_name: forkTag });
          }),
        (distro, command, args) => {
          commands.push([distro, command, args]);
          return {
            exitCode: 0,
            stdout: "github-token\n",
            stderr: "",
            transportFailure: null,
          };
        },
      );

      const result = yield* service.ensureRelease(ensureInput([]));

      assert.deepEqual(result, {
        version: "1.2.4-nightly.20260709.766.1",
        tag: forkTag,
        alreadyBuilt: true,
      });
      assert.deepEqual(commands, [["Ubuntu", "gh", ["auth", "token", "--user", "Konan69"]]]);
      assert.deepEqual(
        requests.map((request) => request.method),
        ["GET"],
      );
      assert.equal(requests[0]?.headers.authorization, "Bearer github-token");
    }),
  );

  it.effect("dispatches, correlates, and waits for a successful release", () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const runUrls: string[] = [];
      let releaseLookups = 0;
      let requestId = "";
      let dispatchBody = "";
      const service = yield* makeService((request) =>
        Effect.sync(() => {
          requests.push(request);
          if (request.url.includes(`/releases/tags/${forkTag}`)) {
            releaseLookups += 1;
            return releaseLookups === 1
              ? response(request, 404)
              : response(request, 200, { tag_name: forkTag });
          }
          if (request.method === "POST") {
            requestId = readDispatchRequestId(request);
            dispatchBody =
              request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
            return response(request, 204);
          }
          if (request.url.includes("/actions/workflows/fork-release.yml/runs?")) {
            return response(request, 200, {
              workflow_runs: [
                {
                  id: 123,
                  status: "completed",
                  conclusion: "success",
                  html_url: "https://github.com/Konan69/t3code/actions/runs/123",
                  display_title: `Fork release ${upstreamTag} (${requestId})`,
                },
              ],
            });
          }
          return response(request, 500);
        }),
      );

      const result = yield* service.ensureRelease(ensureInput(runUrls));

      assert.isFalse(result.alreadyBuilt);
      assert.deepEqual(runUrls, ["https://github.com/Konan69/t3code/actions/runs/123"]);
      assert.include(dispatchBody, `"upstream_tag":"${upstreamTag}"`);
      assert.include(dispatchBody, '"branch":"local/fork-feed"');
      assert.deepEqual(
        requests.map((request) => request.method),
        ["GET", "POST", "GET", "GET"],
      );
    }),
  );

  it.effect("fails before GitHub requests when the WSL token is missing", () =>
    Effect.gen(function* () {
      const requests: HttpClientRequest.HttpClientRequest[] = [];
      const service = yield* makeService(
        (request) =>
          Effect.sync(() => {
            requests.push(request);
            return response(request, 500);
          }),
        () => ({
          exitCode: 1,
          stdout: "",
          stderr: "not logged in",
          transportFailure: null,
        }),
      );

      const error = yield* Effect.flip(service.ensureRelease(ensureInput([])));

      assert.equal(error._tag, "DesktopForkReleaseTokenMissingError");
      assert.deepEqual(requests, []);
    }),
  );

  it.effect("returns a typed error when workflow dispatch fails", () =>
    Effect.gen(function* () {
      const service = yield* makeService((request) =>
        Effect.succeed(request.method === "GET" ? response(request, 404) : response(request, 403)),
      );

      const error = yield* Effect.flip(service.ensureRelease(ensureInput([])));

      assert.equal(error._tag, "DesktopForkReleaseDispatchFailedError");
      assert.isNull(error.runUrl);
    }),
  );

  it.effect("returns the correlated run URL when the workflow fails", () =>
    Effect.gen(function* () {
      const runUrl = "https://github.com/Konan69/t3code/actions/runs/456";
      let requestId = "";
      const service = yield* makeService((request) => {
        if (request.url.includes(`/releases/tags/${forkTag}`)) {
          return Effect.succeed(response(request, 404));
        }
        if (request.method === "POST") {
          requestId = readDispatchRequestId(request);
          return Effect.succeed(response(request, 204));
        }
        return Effect.succeed(
          response(request, 200, {
            workflow_runs: [
              {
                id: 456,
                status: "completed",
                conclusion: "failure",
                html_url: runUrl,
                display_title: `Fork release ${upstreamTag} (${requestId})`,
              },
            ],
          }),
        );
      });

      const error = yield* Effect.flip(service.ensureRelease(ensureInput([])));

      assert.equal(error._tag, "DesktopForkReleaseRunFailedError");
      assert.equal(error.runUrl, runUrl);
    }),
  );
});
