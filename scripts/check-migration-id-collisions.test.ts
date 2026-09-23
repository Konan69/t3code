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

it("parses migration tuples reformatted across multiple lines", () => {
  const reformatted = `
const migrationEntries = [
  [
    44,
    "UpstreamMigration",
    Migration0044,
  ],
  [
    900,
    "ForkMigration",
    Migration0900,
  ],
] as const satisfies ReadonlyArray<MigrationEntry>;
`;

  assert.deepStrictEqual(parseMigrationManifest(reformatted), [
    { id: 44, name: "UpstreamMigration" },
    { id: 900, name: "ForkMigration" },
  ]);
});

it("rejects any migration entry that is not a static identity tuple", () => {
  assert.throws(
    () =>
      parseMigrationManifest(`
const migrationEntries = [
  [44, "UpstreamMigration", Migration0044],
  makeMigrationEntry(900, "ForkMigration"),
] as const;
`),
    /Migration entry 2 is not a static tuple/,
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
    /No migrationEntries table was found/,
  );
});
