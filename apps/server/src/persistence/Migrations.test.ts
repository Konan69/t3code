import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import { type MigrationEntry, runMigrationsByName } from "./NameBasedMigrator.ts";
import repairSettlement from "./Migrations/046_RepairAutomaticSettlementTimestamps.ts";
import projectIcon from "./Migrations/047_ProjectionProjectIcon.ts";
import machineBindings from "./Migrations/900_ProjectionMachineBindings.ts";
import machineWorkspaceRoot from "./Migrations/901_ProjectionMachineProjectWorkspaceRoot.ts";
import repairAutoPull from "./Migrations/902_RepairProjectionProjectsAutoPull.ts";

const createLegacyTable = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE effect_sql_migrations (
      migration_id INTEGER PRIMARY KEY NOT NULL,
      name TEXT NOT NULL,
      created_at DATETIME NOT NULL DEFAULT current_timestamp
    )
  `;
});

for (const legacyTableExists of [false, true]) {
  it.effect(
    `runs every migration on a fresh database (legacy table exists: ${legacyTableExists})`,
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        if (legacyTableExists) yield* createLegacyTable;
        const executed = yield* runMigrations();
        assert.deepStrictEqual(executed, migrationManifest);
        assert.ok(executed.some(([, name]) => name === "ClearAutomaticProjectModelDefaults"));
        assert.deepStrictEqual(yield* runMigrations(), []);
        const tracked =
          yield* sql`SELECT name, migration_id FROM t3_fork_migrations ORDER BY migration_id`;
        assert.deepStrictEqual(
          tracked,
          migrationManifest.map(([migration_id, name]) => ({ name, migration_id })),
        );
        if (legacyTableExists) {
          assert.deepStrictEqual(yield* sql`SELECT * FROM effect_sql_migrations`, []);
        } else {
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM sqlite_master WHERE name = 'effect_sql_migrations'`,
            [],
          );
        }
      }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect("recovers upstream migrations from legacy reused ids and preserves model defaults", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 43 });
    yield* createLegacyTable;
    yield* sql`INSERT INTO effect_sql_migrations SELECT migration_id, name, created_at FROM t3_fork_migrations`;
    yield* sql`DROP TABLE t3_fork_migrations`;
    yield* machineBindings;
    yield* machineWorkspaceRoot;
    yield* repairAutoPull;
    yield* repairSettlement;
    yield* projectIcon;
    for (const [id, name] of [
      [44, "ProjectionMachineBindings"],
      [45, "ProjectionMachineProjectWorkspaceRoot"],
      [46, "RepairAutomaticSettlementTimestamps"],
      [47, "ProjectionProjectIcon"],
      [48, "ProjectionMachineBindings"],
      [49, "ProjectionMachineProjectWorkspaceRoot"],
      [50, "RepairProjectionProjectsAutoPull"],
    ] as const) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
    const legacy = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
    assert.equal(legacy.length, 50);
    const model = '{"instanceId":"codex","model":"gpt-5.4"}';
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, default_model_selection_json, auto_pull, created_at, updated_at)
      VALUES ('project-1', 'Project', '/repo', '[]', ${model}, 1, '2026-01-01', '2026-01-01')
    `;
    const payload = '{"defaultModelSelection":{"instanceId":"codex","model":"gpt-5.4"}}';
    yield* sql`
      INSERT INTO orchestration_events (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json)
      VALUES ('event-1', 'project', 'project-1', 1, 'project.created', '2026-01-01', 'user', ${payload}, '{}')
    `;
    assert.deepStrictEqual(yield* runMigrations(), [
      [45, "ProjectionProjectsAutoPull"],
      [48, "ProjectionThreadBranchPullRequest"],
      [49, "ProjectionThreadsActiveOrderKey"],
      [50, "ProjectionThreadPullRequests"],
    ]);
    assert.deepStrictEqual(
      yield* sql`SELECT default_model_selection_json, auto_pull FROM projection_projects`,
      [{ default_model_selection_json: model, auto_pull: 1 }],
    );
    assert.deepStrictEqual(yield* sql`SELECT payload_json FROM orchestration_events`, [
      { payload_json: payload },
    ]);
    const columns = yield* sql<{ name: string }>`PRAGMA table_info(projection_threads)`;
    assert.ok(columns.some(({ name }) => name === "branch_pull_request_json"));
    assert.ok(columns.some(({ name }) => name === "active_order_key"));
    assert.deepStrictEqual(yield* sql`SELECT * FROM projection_thread_pull_requests`, []);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(
      yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
      legacy,
    );
    const counts =
      yield* sql`SELECT COUNT(*) AS total, COUNT(DISTINCT name) AS distinct_names FROM t3_fork_migrations`;
    assert.deepStrictEqual(counts, [{ total: 53, distinct_names: 53 }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("runs lower ids after legacy id 905 and after fork tracking has been initialized", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* createLegacyTable;
    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (905, 'OldRepair')`;
    assert.deepStrictEqual(yield* runMigrationsByName([[51, "NextUpstream", Effect.void]]), [
      [51, "NextUpstream"],
    ]);
    // A nonempty fork table must never be bootstrapped again from frozen legacy state.
    yield* sql`DELETE FROM t3_fork_migrations WHERE name = 'ClearAutomaticProjectModelDefaults'`;
    assert.deepStrictEqual(
      yield* runMigrationsByName([
        [900, "NewFork", Effect.void],
        [52, "LaterUpstream", Effect.void],
        [44, "ClearAutomaticProjectModelDefaults", Effect.void],
        [51, "NextUpstream", Effect.die("already applied")],
      ]),
      [
        [44, "ClearAutomaticProjectModelDefaults"],
        [52, "LaterUpstream"],
        [900, "NewFork"],
      ],
    );
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

for (const [label, entries, message] of [
  [
    "ids",
    [
      [1, "First", Effect.void],
      [1, "Second", Effect.void],
    ],
    "Duplicate migration id: 1",
  ],
  [
    "names",
    [
      [1, "Same", Effect.void],
      [2, "Same", Effect.void],
    ],
    "Duplicate migration name: Same",
  ],
] as const satisfies ReadonlyArray<readonly [string, ReadonlyArray<MigrationEntry>, string]>) {
  it.effect(`rejects duplicate ${label} even outside the requested id range`, () =>
    Effect.gen(function* () {
      const error = yield* runMigrationsByName(entries, 0).pipe(Effect.flip);
      assert.equal(error._tag, "MigrationError");
      if (error._tag === "MigrationError") {
        assert.equal(error.kind, "Duplicates");
        assert.equal(error.message, message);
      }
      const sql = yield* SqlClient.SqlClient;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 't3_fork_migrations'`,
        [],
      );
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
  );
}

it.effect(
  "rolls back migration writes and bootstrap when a migration fails, then permits retry",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* createLegacyTable;
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (900, 'OldFork')`;
      const createTable = sql`CREATE TABLE migration_test (value TEXT)`.pipe(Effect.asVoid);
      yield* runMigrationsByName([
        [1, "CreateTable", createTable],
        [2, "Fail", sql`INSERT INTO missing_table VALUES ('fail')`.pipe(Effect.asVoid)],
      ]).pipe(Effect.exit);
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name IN ('migration_test', 't3_fork_migrations')`,
        [],
      );
      assert.deepStrictEqual(yield* runMigrationsByName([[1, "CreateTable", createTable]]), [
        [1, "CreateTable"],
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
