import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const threadColumns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_threads)
  `;
  if (!threadColumns.some((column) => column.name === "machine_project_workspace_root")) {
    yield* sql`
      ALTER TABLE projection_threads
      ADD COLUMN machine_project_workspace_root TEXT
    `;
  }
});
