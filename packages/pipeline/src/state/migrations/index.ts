// The one migration set (ADR 0011): a static, ordered list run by Kysely's Migrator on both
// dialects. Forward-only: there is no `down`. Add a migration by adding `NNNN-name.ts` and listing
// it in MIGRATIONS; never edit one that has shipped.
//
// Locking (B 10): on Postgres the migrator takes a session advisory lock and runs every pending
// migration in one transaction (transactional DDL), so two instances starting at once do not race.
// On SQLite Kysely takes no lock (one connection) and opens no transaction, so each migration body
// runs inside its own explicit transaction here and a failure leaves no partial schema.

import { sql, type Kysely } from 'kysely';
import { Migrator, type Migration, type MigrationProvider } from 'kysely/migration';
import type { StateDialect } from '../../contracts/state.ts';
import { StateMigrationError } from '../errors.ts';
import * as m0001 from './0001-initial.ts';

export interface StateMigration {
  readonly name: string;
  up(db: Kysely<unknown>, dialect: StateDialect): Promise<void>;
}

export const MIGRATIONS: readonly StateMigration[] = Object.freeze([m0001]);

/** Kysely's bookkeeping tables, in the same schema as the state tables. */
export const MIGRATION_TABLE = 'kysely_migration';
export const MIGRATION_LOCK_TABLE = 'kysely_migration_lock';

function provider(dialect: StateDialect, migrations: readonly StateMigration[]): MigrationProvider {
  return {
    getMigrations() {
      const out: Record<string, Migration> = {};
      for (const m of migrations) {
        if (Object.hasOwn(out, m.name)) {
          throw new Error(`duplicate migration name ${m.name}`);
        }
        out[m.name] = {
          up:
            dialect === 'sqlite'
              ? (db: Kysely<unknown>) => db.transaction().execute((trx) => m.up(trx, dialect))
              : (db: Kysely<unknown>) => m.up(db, dialect),
        };
      }
      return Promise.resolve(out);
    },
  };
}

/**
 * Runs every pending migration, in order. Resolves to the names it applied (empty when the schema is
 * current); rejects with `StateMigrationError` naming the migration that failed.
 */
export async function migrateState<DB>(
  db: Kysely<DB>,
  dialect: StateDialect,
  migrations: readonly StateMigration[] = MIGRATIONS,
): Promise<string[]> {
  const raw = db as unknown as Kysely<unknown>;
  // On Postgres, keep Kysely's tables in the connection's current schema. Without this its
  // existence check matches a `kysely_migration` in any schema of the database.
  let migrationTableSchema: string | undefined;
  if (dialect === 'postgres') {
    const { rows } = await sql<{ schema: string | null }>`select current_schema() as schema`.execute(raw);
    const schema = rows[0]?.schema;
    if (schema === null || schema === undefined) {
      throw new StateMigrationError(undefined, new Error('the connection has no current schema (check search_path)'));
    }
    migrationTableSchema = schema;
  }
  const migrator = new Migrator({
    db: raw,
    provider: provider(dialect, migrations),
    migrationTableName: MIGRATION_TABLE,
    migrationLockTableName: MIGRATION_LOCK_TABLE,
    ...(migrationTableSchema === undefined ? {} : { migrationTableSchema }),
  });
  for (let attempt = 1; ; attempt++) {
    const { error, results } = await migrator.migrateToLatest();
    if (error === undefined) {
      return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
    }
    // Kysely checks for its own tables with an introspection query over every schema in the
    // database, which calls pg_get_serial_sequence per column; a different schema dropped while it
    // runs fails the query with 3F000 (parallel test files each drop their own schema). Nothing has
    // been migrated at that point, so the run is retried.
    if (attempt < OTHER_SCHEMA_DROPPED_RETRIES && otherSchemaDropped(error, migrationTableSchema)) {
      continue;
    }
    const failed = results?.find((r) => r.status === 'Error');
    throw new StateMigrationError(failed?.migrationName, error);
  }
}

const OTHER_SCHEMA_DROPPED_RETRIES = 5;

function otherSchemaDropped(error: unknown, ownSchema: string | undefined): boolean {
  if (ownSchema === undefined || !(error instanceof Error) || (error as { code?: unknown }).code !== '3F000') {
    return false;
  }
  const dropped = /schema "([^"]+)" does not exist/.exec(error.message)?.[1];
  return dropped !== undefined && dropped !== ownSchema;
}
