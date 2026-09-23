import { createRequire } from "node:module";

import { assert, it } from "@effect/vitest";

import { resolveForkReleaseMetadata } from "./resolve-fork-release.ts";

const desktopRequire = createRequire(new URL("../apps/desktop/package.json", import.meta.url));
const updaterRequire = createRequire(desktopRequire.resolve("electron-updater/package.json"));
const updaterSemver = updaterRequire("semver") as {
  readonly gt: (left: string, right: string) => boolean;
  readonly lt: (left: string, right: string) => boolean;
};

it("maps an upstream nightly to a deterministic fork nightly version", () => {
  assert.deepStrictEqual(resolveForkReleaseMetadata("v0.0.43-nightly.20260923.2150"), {
    upstreamTag: "v0.0.43-nightly.20260923.2150",
    version: "0.0.43-nightly.20260923.2150.1",
    tag: "v0.0.43-nightly.20260923.2150.1",
    name: "T3 Code Fork 0.0.43-nightly.20260923.2150.1",
  });
});

it("sorts strictly above its source build with electron-updater's semver implementation", () => {
  const upstreamVersion = "0.0.43-nightly.20260923.2150";
  const { version } = resolveForkReleaseMetadata(`v${upstreamVersion}`);

  assert.isTrue(updaterSemver.gt(version, upstreamVersion));
  assert.match(version, /-nightly\.\d{8}\.\d+\.1$/);
});

it("sorts below the next upstream nightly on the same date", () => {
  const fork = resolveForkReleaseMetadata("v0.0.43-nightly.20260923.2150").version;

  assert.isTrue(updaterSemver.lt(fork, "0.0.43-nightly.20260923.2151"));
});

it("sorts below an upstream nightly on the next date", () => {
  const fork = resolveForkReleaseMetadata("v0.0.43-nightly.20260923.2150").version;

  assert.isTrue(updaterSemver.lt(fork, "0.0.43-nightly.20260924.1"));
});

it("rejects non-nightly and malformed source tags", () => {
  assert.throws(() => resolveForkReleaseMetadata("v0.0.43"));
  assert.throws(() => resolveForkReleaseMetadata("v0.0.43-preview.20260923.2150"));
});
