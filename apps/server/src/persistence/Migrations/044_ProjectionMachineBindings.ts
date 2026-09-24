import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const projectColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;
  if (!projectColumns.some((column) => column.name === "machine_mode")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN machine_mode TEXT NOT NULL DEFAULT 'off'
    `;
  }

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "machine_id")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN machine_id TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "machine_name")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN machine_name TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "machine_state")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN machine_state TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "machine_host_workspace_root")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN machine_host_workspace_root TEXT`;
  }
  if (!threadColumns.some((column) => column.name === "machine_guest_workspace_root")) {
    yield* sql`ALTER TABLE projection_threads ADD COLUMN machine_guest_workspace_root TEXT`;
  }
});
