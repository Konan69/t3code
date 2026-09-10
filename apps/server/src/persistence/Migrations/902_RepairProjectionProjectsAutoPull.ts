import * as Effect from "effect/Effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

/**
 * Repairs databases whose migration ids 44 and 45 were consumed by this
 * fork's machine-binding migrations before upstream claimed the same ids.
 * Those databases record 45 as applied, so upstream's
 * `045_ProjectionProjectsAutoPull` never runs and every project query fails
 * on the missing `auto_pull` column. Re-applies the same idempotent change.
 */
export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{ readonly name: string }>`
    PRAGMA table_info(projection_projects)
  `;

  if (!columns.some((column) => column.name === "auto_pull")) {
    yield* sql`
      ALTER TABLE projection_projects
      ADD COLUMN auto_pull INTEGER NOT NULL DEFAULT 0
    `;
  }
});
