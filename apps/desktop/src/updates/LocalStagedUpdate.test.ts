import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import {
  parseLocalStagedUpdateStatus,
  reduceDesktopUpdateStateOnLocalStagedStatus,
} from "./LocalStagedUpdate.ts";
import { createInitialDesktopUpdateState } from "./updateMachine.ts";

const runtimeInfo = {
  hostArch: "x64",
  appArch: "x64",
  runningUnderArm64Translation: false,
} as const;
const initial = createInitialDesktopUpdateState("0.0.45", runtimeInfo, "nightly");
const checkedAt = "2026-10-06T10:00:00.000Z";

const status = (phase: string, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    phase,
    version: "0.0.45",
    message: `${phase} message`,
    updatedAt: checkedAt,
    ...extra,
  });

const reduce = (raw: string, runningCommit: string | null = "aaaaaaa") =>
  parseLocalStagedUpdateStatus(raw).pipe(
    Effect.map((parsed) =>
      reduceDesktopUpdateStateOnLocalStagedStatus(initial, parsed, checkedAt, runningCommit),
    ),
  );

describe("LocalStagedUpdate", () => {
  it.effect("shows a staged build as a downloaded update with its notes", () =>
    Effect.gen(function* () {
      const state = yield* reduce(status("ready", { commit: "bbbbbbb", notes: ["one", "two"] }));
      assert.equal(state.enabled, true);
      assert.equal(state.status, "downloaded");
      assert.equal(state.downloadedVersion, "0.0.45+bbbbbbb");
      assert.deepStrictEqual(state.releaseNotes, [
        { version: "0.0.45+bbbbbbb", items: ["one", "two"], totalItems: 2 },
      ]);
    }),
  );

  it.effect("shows nothing while a build is in progress", () =>
    Effect.gen(function* () {
      const state = yield* reduce(status("building", { commit: "bbbbbbb", notes: ["one"] }));
      assert.equal(state.status, "up-to-date");
      assert.equal(state.availableVersion, null);
      assert.deepStrictEqual(state.releaseNotes, []);
    }),
  );

  it.effect("is up to date once installed, or when the staged commit is the running one", () =>
    Effect.gen(function* () {
      assert.equal(
        (yield* reduce(status("installed", { commit: "bbbbbbb" }))).status,
        "up-to-date",
      );
      assert.equal((yield* reduce(status("ready", { commit: "aaaaaaa" }))).status, "up-to-date");
    }),
  );

  it.effect("keeps the change list of the build that is running", () =>
    Effect.gen(function* () {
      const running = yield* reduce(status("installed", { commit: "aaaaaaa", notes: ["one"] }));
      assert.equal(running.status, "up-to-date");
      assert.equal(running.downloadedVersion, null);
      assert.deepStrictEqual(running.releaseNotes, [
        { version: "0.0.45+aaaaaaa", items: ["one"], totalItems: 1 },
      ]);
      const other = yield* reduce(status("installed", { commit: "bbbbbbb", notes: ["one"] }));
      assert.deepStrictEqual(other.releaseNotes, []);
    }),
  );

  it.effect("reports a failed build and treats an unreadable file as no update", () =>
    Effect.gen(function* () {
      const failed = yield* reduce(status("failed"));
      assert.equal(failed.status, "error");
      assert.equal(failed.message, "failed message");
      assert.equal((yield* reduce("{not json")).status, "up-to-date");
      assert.isTrue(Option.isNone(yield* parseLocalStagedUpdateStatus(status("unknown"))));
    }),
  );
});
