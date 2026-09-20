import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { runMigrations } from "../Migrations.ts";
import repairAutoPull from "./902_RepairProjectionProjectsAutoPull.ts";

it.effect("repairs a missing auto_pull column and preserves an existing preference on rerun", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 44 });
    yield* repairAutoPull;
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, auto_pull, created_at, updated_at)
      VALUES ('project-1', 'Project', '/repo', '[]', 1, '2026-01-01', '2026-01-01')
    `;
    yield* repairAutoPull;
    assert.deepStrictEqual(yield* sql`SELECT auto_pull FROM projection_projects`, [
      { auto_pull: 1 },
    ]);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);
