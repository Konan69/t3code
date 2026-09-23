import { createRequire } from "node:module";

import { assert, it } from "@effect/vitest";

import { resolveForkReleaseMetadata } from "./resolve-fork-release.ts";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const updaterRequire = createRequire(desktopRequire.resolve("electron-updater/package.json"));
const updaterSemver = updaterRequire("semver") as {
  readonly gt: (left: string, right: string) => boolean;
};

it("maps an upstream nightly to a deterministic fork nightly version", () => {
  assert.deepStrictEqual(resolveForkReleaseMetadata("v0.0.43-nightly.20260923.2150"), {
    upstreamTag: "v0.0.43-nightly.20260923.2150",
    version: "0.0.43-nightly.20260923.2150001",
    tag: "v0.0.43-nightly.20260923.2150001",
    name: "T3 Code Fork 0.0.43-nightly.20260923.2150001",
  });
});

it("sorts strictly above its source build with electron-updater's semver implementation", () => {
  const upstreamVersion = "0.0.43-nightly.20260923.2150";
  const { version } = resolveForkReleaseMetadata(`v${upstreamVersion}`);

  assert.isTrue(updaterSemver.gt(version, upstreamVersion));
  assert.match(version, /-nightly\.\d{8}\.\d+$/);
});

it("preserves ordering between consecutive upstream nightlies", () => {
  const older = resolveForkReleaseMetadata("v0.0.43-nightly.20260923.2150").version;
  const newer = resolveForkReleaseMetadata("v0.0.43-nightly.20260923.2151").version;

  assert.isTrue(updaterSemver.gt(newer, older));
});

it("rejects non-nightly and malformed source tags", () => {
  assert.throws(() => resolveForkReleaseMetadata("v0.0.43"));
  assert.throws(() => resolveForkReleaseMetadata("v0.0.43-preview.20260923.2150"));
});
