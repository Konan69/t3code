import * as Effect from "effect/Effect";
import { MigrationError } from "effect/unstable/sql/Migrator";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";

export type MigrationEntry = readonly [
  id: number,
  name: string,
  migration: Effect.Effect<void, SqlError, SqlClient.SqlClient>,
];

const LEGACY_DELIBERATELY_SKIPPED_MIGRATIONS = [
  // This fork has always preserved existing user model defaults. Bootstrap this
  // name only for legacy installs so switching runners does not rewrite them.
  [44, "ClearAutomaticProjectModelDefaults"],
] as const;

/** Names identify migrations; ids only order them. Bootstrap and execution share
 * one transaction so a failed migration cannot leave partially tracked state. */
export const runMigrationsByName = Effect.fn("runMigrationsByName")(function* (
  entries: ReadonlyArray<MigrationEntry>,
  throughId?: number,
) {
  const ids = new Set<number>();
  const names = new Set<string>();
  for (const [id, name] of entries) {
    if (ids.has(id) || names.has(name)) {
      return yield* new MigrationError({
        kind: "Duplicates",
        message: ids.has(id)
          ? `Duplicate migration id: ${id}`
          : `Duplicate migration name: ${name}`,
      });
    }
    ids.add(id);
    names.add(name);
  }

  const sql = yield* SqlClient.SqlClient;
  return yield* sql.withTransaction(
    Effect.gen(function* () {
      yield* sql`
        CREATE TABLE IF NOT EXISTS t3_fork_migrations (
          name TEXT PRIMARY KEY NOT NULL,
          migration_id INTEGER NOT NULL,
          created_at DATETIME NOT NULL DEFAULT current_timestamp
        )
      `;

      const tracked = yield* sql`SELECT 1 FROM t3_fork_migrations LIMIT 1`;
      if (tracked.length === 0) {
        const legacyTable = yield* sql`
          SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'effect_sql_migrations'
        `;
        if (legacyTable.length > 0) {
          // Legacy ids can have been reused for different names, and the same
          // name can appear at multiple ids. Keep one record per name and never
          // write to the legacy table, whose primary key is still the id.
          yield* sql`
            INSERT INTO t3_fork_migrations (name, migration_id, created_at)
            SELECT name, MIN(migration_id), MIN(created_at)
            FROM effect_sql_migrations GROUP BY name
          `;
          const seeded = yield* sql`SELECT 1 FROM t3_fork_migrations LIMIT 1`;
          if (seeded.length > 0) {
            for (const [id, name] of LEGACY_DELIBERATELY_SKIPPED_MIGRATIONS) {
              yield* sql`
                INSERT OR IGNORE INTO t3_fork_migrations (name, migration_id)
                VALUES (${name}, ${id})
              `;
            }
          }
        }
      }

      const applied = yield* sql<{ readonly name: string }>`SELECT name FROM t3_fork_migrations`;
      const appliedNames = new Set(applied.map(({ name }) => name));
      const pending = entries
        .filter(
          ([id, name]) => (throughId === undefined || id <= throughId) && !appliedNames.has(name),
        )
        .toSorted(([a], [b]) => a - b);
      const executed: Array<readonly [number, string]> = [];
      for (const [id, name, migration] of pending) {
        yield* migration.pipe(
          Effect.catch((cause) =>
            Effect.die(
              new MigrationError({
                kind: "Failed",
                message: `Migration "${id}_${name}" failed`,
                cause,
              }),
            ),
          ),
          Effect.withSpan(`Migrator ${id}_${name}`),
        );
        yield* sql`
          INSERT INTO t3_fork_migrations (name, migration_id) VALUES (${name}, ${id})
        `;
        executed.push([id, name]);
      }
      return executed;
    }),
  );
});
