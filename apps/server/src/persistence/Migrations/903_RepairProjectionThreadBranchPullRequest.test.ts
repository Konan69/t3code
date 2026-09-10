import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";

import { migrationManifest, runMigrations } from "../Migrations.ts";
import machineBindings from "./900_ProjectionMachineBindings.ts";
import machineWorkspaceRoot from "./901_ProjectionMachineProjectWorkspaceRoot.ts";
import repairAutoPull from "./902_RepairProjectionProjectsAutoPull.ts";
import repairBranchPullRequest from "./903_RepairProjectionThreadBranchPullRequest.ts";
import repairActiveOrderKey from "./904_RepairProjectionThreadsActiveOrderKey.ts";
import repairPullRequests from "./905_RepairProjectionThreadPullRequests.ts";

it.effect("repairs fork ids 48–50 while retaining machine bindings and legacy pull requests", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 47 });
    yield* machineBindings;
    yield* machineWorkspaceRoot;
    yield* repairAutoPull;
    for (const [id, name] of [
      [48, "ProjectionMachineBindings"],
      [49, "ProjectionMachineProjectWorkspaceRoot"],
      [50, "RepairProjectionProjectsAutoPull"],
    ] as const) {
      yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (${id}, ${name})`;
    }
    yield* sql`
      INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, machine_mode, auto_pull, created_at, updated_at)
      VALUES ('project-1', 'Project', '/repo', '[]', 'thread', 1, '2026-01-01', '2026-01-01')
    `;
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, created_at, updated_at,
        machine_id, machine_name, machine_state, machine_project_workspace_root,
        machine_host_workspace_root, machine_guest_workspace_root, linked_pull_request_json
      ) VALUES (
        'thread-1', 'project-1', 'Thread', '{"instanceId":"codex","model":"gpt-5.4"}', '2026-01-01', '2026-01-01',
        'machine-1', 'thread-machine-1', 'running', '/repo', '/tank/thread-1/ws', '/guest/ws',
        '{"projectId":"project-1","repository":"acme/web","number":42,"url":"https://github.com/acme/web/pull/42"}'
      )
    `;
    const before = yield* sql<{ readonly name: string }>`PRAGMA table_info(projection_threads)`;
    assert.ok(!before.some(({ name }) => name === "branch_pull_request_json"));
    assert.ok(!before.some(({ name }) => name === "active_order_key"));

    const applied = yield* runMigrations();
    assert.deepStrictEqual(
      applied.map(([id]) => id),
      [900, 901, 902, 903, 904, 905],
    );
    const rows = yield* sql`
      SELECT machine_id, machine_project_workspace_root, machine_host_workspace_root,
        machine_guest_workspace_root, branch_pull_request_json, active_order_key
      FROM projection_threads
    `;
    assert.deepStrictEqual(rows, [
      {
        machine_id: "machine-1",
        machine_project_workspace_root: "/repo",
        machine_host_workspace_root: "/tank/thread-1/ws",
        machine_guest_workspace_root: "/guest/ws",
        branch_pull_request_json: null,
        active_order_key: null,
      },
    ]);
    const links =
      yield* sql`SELECT host, repository, number, source FROM projection_thread_pull_requests`;
    assert.deepStrictEqual(links, [
      { host: "github.com", repository: "acme/web", number: 42, source: "manual" },
    ]);
    const projects = yield* sql`SELECT machine_mode, auto_pull FROM projection_projects`;
    assert.deepStrictEqual(projects, [{ machine_mode: "thread", auto_pull: 1 }]);
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);

it.effect("fresh databases run both migration ranges and repairs preserve existing values", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const applied = yield* runMigrations();
    assert.deepStrictEqual(applied, migrationManifest);
    const ids = migrationManifest.map(([id]) => id);
    assert.ok(ids.every((id, index) => index === 0 || id > ids[index - 1]!));
    yield* sql`
      INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json, created_at, updated_at, branch_pull_request_json, active_order_key, linked_pull_request_json)
      VALUES ('thread-1', 'project-1', 'Thread', '{"instanceId":"codex","model":"gpt-5.4"}', '2026-01-01', '2026-01-01', '{"number":42}', 'gm',
        '{"projectId":"project-1","repository":"acme/web","number":42,"url":"https://github.com/acme/web/pull/42"}')
    `;
    yield* repairPullRequests;
    yield* sql`UPDATE projection_thread_pull_requests SET source = 'agent', snapshot_json = '{"state":"open"}'`;
    yield* repairBranchPullRequest;
    yield* repairActiveOrderKey;
    yield* repairPullRequests;
    const threads =
      yield* sql`SELECT branch_pull_request_json, active_order_key FROM projection_threads`;
    assert.deepStrictEqual(threads, [
      { branch_pull_request_json: '{"number":42}', active_order_key: "gm" },
    ]);
    const links = yield* sql`SELECT source, snapshot_json FROM projection_thread_pull_requests`;
    assert.deepStrictEqual(links, [{ source: "agent", snapshot_json: '{"state":"open"}' }]);
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
