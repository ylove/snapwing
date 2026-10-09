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
import * as m0002 from './0002-event-tx-order.ts';
import * as m0003 from './0003-linked-identities.ts';
import * as m0004 from './0004-incident-owner-ref.ts';
import * as m0005 from './0005-bot-messages.ts';
import * as m0006 from './0006-capture-tokens.ts';
import * as m0007 from './0007-subscription-platform.ts';
import * as m0008 from './0008-linked-identity-unique-account.ts';

export interface StateMigration {
  readonly name: string;
  up(db: Kysely<unknown>, dialect: StateDialect): Promise<void>;
}

export const MIGRATIONS: readonly StateMigration[] = Object.freeze([m0001, m0002, m0003, m0004, m0005, m0006, m0007, m0008]);

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
  const { error, results } = await migrator.migrateToLatest();
  if (error === undefined) {
    return (results ?? []).filter((r) => r.status === 'Success').map((r) => r.migrationName);
  }
  const failed = results?.find((r) => r.status === 'Error');
  throw new StateMigrationError(failed?.migrationName, error);
}
