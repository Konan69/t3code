import { assert, it } from "@effect/vitest";

import {
  findMigrationIdCollisions,
  parseMigrationManifest,
} from "./check-migration-id-collisions.ts";

const manifest = (...entries: ReadonlyArray<readonly [number, string]>) => `
const migrationEntries = [
${entries.map(([id, name]) => `  [${id}, "${name}", Migration${id}],`).join("\n")}
] as const;
`;

it("parses migration ids and permanent names from the static table", () => {
  assert.deepStrictEqual(
    parseMigrationManifest(manifest([44, "UpstreamMigration"], [900, "ForkMigration"])),
    [
      { id: 44, name: "UpstreamMigration" },
      { id: 900, name: "ForkMigration" },
    ],
  );
});

it("reports a fork-only migration that reuses an upstream id", () => {
  const upstream = parseMigrationManifest(manifest([44, "UpstreamMigration"]));
  const merged = parseMigrationManifest(
    manifest([44, "UpstreamMigration"], [44, "ForkMigration"], [900, "SafeForkMigration"]),
  );

  assert.deepStrictEqual(findMigrationIdCollisions(upstream, merged), [
    { id: 44, upstreamName: "UpstreamMigration", forkName: "ForkMigration" },
  ]);
});

it("allows shared upstream identities and fork migrations with reserved ids", () => {
  const upstream = parseMigrationManifest(
    manifest([44, "UpstreamMigration"], [45, "AnotherUpstreamMigration"]),
  );
  const merged = parseMigrationManifest(
    manifest([44, "UpstreamMigration"], [45, "AnotherUpstreamMigration"], [900, "ForkMigration"]),
  );

  assert.deepStrictEqual(findMigrationIdCollisions(upstream, merged), []);
});

it("hard-fails when a migration table cannot be parsed", () => {
  assert.throws(
    () => parseMigrationManifest("export const migrationManifest = [];"),
    /No migration entries were found in the migration table/,
  );
});
