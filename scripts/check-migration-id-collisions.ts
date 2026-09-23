#!/usr/bin/env node

import * as NodeRuntime from "@effect/platform-node/NodeRuntime";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Console from "effect/Console";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import * as TypeScript from "typescript-legacy";

export interface MigrationIdentity {
  readonly id: number;
  readonly name: string;
}

export interface MigrationIdCollision {
  readonly id: number;
  readonly upstreamName: string;
  readonly forkName: string;
}

const MigrationTableSource = Schema.NonEmptyString;
const decodeMigrationTableSource = Schema.decodeUnknownSync(MigrationTableSource);

function unwrapExpression(expression: TypeScript.Expression): TypeScript.Expression {
  let current = expression;
  while (
    TypeScript.isAsExpression(current) ||
    TypeScript.isSatisfiesExpression(current) ||
    TypeScript.isParenthesizedExpression(current)
  ) {
    current = current.expression;
  }
  return current;
}

export function parseMigrationManifest(source: string): ReadonlyArray<MigrationIdentity> {
  const decodedSource = decodeMigrationTableSource(source);
  const sourceFile = TypeScript.createSourceFile(
    "Migrations.ts",
    decodedSource,
    TypeScript.ScriptTarget.Latest,
    true,
    TypeScript.ScriptKind.TS,
  );
  const declaration = sourceFile.statements
    .filter(TypeScript.isVariableStatement)
    .flatMap((statement) => Array.from(statement.declarationList.declarations))
    .find(
      (candidate) =>
        TypeScript.isIdentifier(candidate.name) && candidate.name.text === "migrationEntries",
    );
  if (declaration?.initializer === undefined) {
    throw new Error("No migrationEntries table was found.");
  }

  const initializer = unwrapExpression(declaration.initializer);
  if (!TypeScript.isArrayLiteralExpression(initializer) || initializer.elements.length === 0) {
    throw new Error("No migration entries were found in the migration table.");
  }

  return initializer.elements.map((element, index) => {
    const tuple = unwrapExpression(element);
    if (!TypeScript.isArrayLiteralExpression(tuple) || tuple.elements.length < 2) {
      throw new Error(`Migration entry ${index + 1} is not a static tuple.`);
    }
    const idElement = tuple.elements[0];
    const nameElement = tuple.elements[1];
    if (idElement === undefined || nameElement === undefined) {
      throw new Error(`Migration entry ${index + 1} is missing its id or name.`);
    }
    const id = unwrapExpression(idElement);
    const name = unwrapExpression(nameElement);
    if (!TypeScript.isNumericLiteral(id) || !TypeScript.isStringLiteral(name)) {
      throw new Error(`Migration entry ${index + 1} must have a numeric id and string name.`);
    }
    return { id: Number(id.text), name: name.text };
  });
}

export function findMigrationIdCollisions(
  upstreamEntries: ReadonlyArray<MigrationIdentity>,
  mergedEntries: ReadonlyArray<MigrationIdentity>,
): ReadonlyArray<MigrationIdCollision> {
  const upstreamNames = new Set(upstreamEntries.map(({ name }) => name));
  const upstreamById = new Map(upstreamEntries.map((entry) => [entry.id, entry.name] as const));

  return mergedEntries.flatMap((entry) => {
    if (upstreamNames.has(entry.name)) return [];
    const upstreamName = upstreamById.get(entry.id);
    return upstreamName === undefined
      ? []
      : [{ id: entry.id, upstreamName, forkName: entry.name } satisfies MigrationIdCollision];
  });
}

const run = Effect.fn("checkMigrationIdCollisions.run")(function* (args: ReadonlyArray<string>) {
  if (args.length !== 2) {
    return yield* Effect.die(
      new Error(
        "Usage: node scripts/check-migration-id-collisions.ts <upstream-Migrations.ts> <merged-Migrations.ts>",
      ),
    );
  }
  const [upstreamPath, mergedPath] = args;
  if (!upstreamPath || !mergedPath) {
    return yield* Effect.die(new Error("Both migration table paths are required."));
  }

  const fs = yield* FileSystem.FileSystem;
  const [upstreamSource, mergedSource] = yield* Effect.all(
    [fs.readFileString(upstreamPath), fs.readFileString(mergedPath)],
    { concurrency: 2 },
  );
  const collisions = findMigrationIdCollisions(
    parseMigrationManifest(upstreamSource),
    parseMigrationManifest(mergedSource),
  );
  if (collisions.length === 0) {
    yield* Console.log("Fork migration ids do not collide with upstream migration ids.");
    return;
  }

  const details = collisions
    .map(({ id, upstreamName, forkName }) => `  ${id}: upstream=${upstreamName}, fork=${forkName}`)
    .join("\n");
  return yield* Effect.die(new Error(`Fork migration id collision(s):\n${details}`));
});

if (import.meta.main) {
  run(process.argv.slice(2)).pipe(Effect.provide(NodeServices.layer), NodeRuntime.runMain);
}
