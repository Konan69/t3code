import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

const layer = it.layer(Layer.mergeAll(NodeSqliteClient.layerMemory()));

layer("044_ProjectionMachineBindings", (it) => {
  it.effect("adds default-off project mode and optional thread binding columns", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;

      yield* runMigrations({ toMigrationInclusive: 43 });
      yield* sql`
        INSERT INTO projection_projects (
          project_id, title, workspace_root, scripts_json, created_at, updated_at
        ) VALUES (
          'project-1', 'Project', '/repo', '[]',
          '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z'
        )
      `;
      yield* runMigrations({ toMigrationInclusive: 44 });

      const projectColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_projects)
      `;
      const threadColumns = yield* sql<{ readonly name: string }>`
        PRAGMA table_info(projection_threads)
      `;
      assert.ok(projectColumns.some((column) => column.name === "machine_mode"));
      for (const name of [
        "machine_id",
        "machine_name",
        "machine_state",
        "machine_host_workspace_root",
        "machine_guest_workspace_root",
      ]) {
        assert.ok(threadColumns.some((column) => column.name === name));
      }

      const rows = yield* sql<{ readonly machineMode: string }>`
        SELECT machine_mode AS "machineMode" FROM projection_projects
      `;
      assert.deepStrictEqual(rows, [{ machineMode: "off" }]);
    }),
  );
});
