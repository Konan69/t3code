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

  it.effect("compares the running build with the T3 team's releases", () =>
    Effect.gen(function* () {
      const raw = status("installed", {
        commit: "aaaaaaa",
        notes: ["fork change"],
        upstreamBase: { commit: "ccccccc", committedAt: "2026-10-06T09:33:40Z" },
      });
      const release = (version: string, createdAt: string, note: string) => ({
        version,
        createdAt,
        note,
      });
      const older = release("0.0.46-nightly.20261005.2702", "2026-10-05T23:30:00Z", "- old");
      const newer = release("0.0.46-nightly.20261006.2735", "2026-10-06T17:12:08Z", "- new thing");
      const stable = release("0.0.46", "2026-10-07T00:00:00Z", "- stable thing");
      const reduceWith = (releases: ReadonlyArray<typeof older> | null) =>
        parseLocalStagedUpdateStatus(raw).pipe(
          Effect.map((parsed) =>
            reduceDesktopUpdateStateOnLocalStagedStatus(initial, parsed, checkedAt, "aaaaaaa", {
              checkedAt: "2026-10-07T10:00:00.000Z",
              releases,
            }),
          ),
        );

      const behind = yield* reduceWith([stable, newer, older]);
      assert.equal(behind.status, "up-to-date");
      assert.equal(behind.availableVersion, null);
      assert.equal(behind.checkedAt, "2026-10-07T10:00:00.000Z");
      assert.deepStrictEqual(behind.releaseNotes, [
        { version: "0.0.46-nightly.20261006.2735", items: ["new thing"], totalItems: 1 },
      ]);
      assert.include(behind.message ?? "", "1 newer nightly build from the T3 team");

      const current = yield* reduceWith([older]);
      assert.equal(
        current.message,
        "Your build includes the latest nightly, 0.0.46-nightly.20261005.2702.",
      );
      assert.deepStrictEqual(current.releaseNotes, [
        { version: "0.0.45+aaaaaaa", items: ["fork change"], totalItems: 1 },
      ]);

      const offline = yield* reduceWith(null);
      assert.include(offline.message ?? "", "Could not reach GitHub");
      assert.equal(offline.releaseNotes.length, 1);
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
