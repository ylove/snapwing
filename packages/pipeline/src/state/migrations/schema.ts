// Dialect-neutral table and index helpers for migrations (ADR 0011). A migration declares columns
// with B 3 types; this file picks the per-dialect column type, default, and check, so one migration
// creates the same table on SQLite and Postgres.

import { sql, type ColumnDefinitionBuilder, type CreateTableBuilder, type Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';

/** B 3 column types. */
export type ColumnType = 'text' | 'integer' | 'smallint' | 'bigint' | 'numeric' | 'boolean' | 'jsonb' | 'timestamptz';

export interface ColumnSpec {
  type: ColumnType;
  notNull?: boolean;
  primaryKey?: boolean;
  unique?: boolean;
  /** `now` is B 3's `default now()`. */
  default?: 'now' | number | boolean;
  /** `table.column`. */
  references?: string;
  /** A check over this column, as static SQL written in the migration (never user input). */
  check?: string;
}

export interface TableSpec {
  columns: Readonly<Record<string, ColumnSpec>>;
  /** Composite primary key, named `{table}_pkey` on both dialects. */
  primaryKey?: readonly string[];
}

/** SQLite's `now()`: ISO 8601 UTC with milliseconds and `Z`, the same form the codec writes. */
const SQLITE_NOW = sql`(strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))`;

function dataType(dialect: StateDialect, type: ColumnType): 'text' | 'integer' | 'smallint' | 'bigint' | 'numeric' | 'real' | 'boolean' | 'jsonb' | 'timestamptz' {
  if (dialect === 'postgres') {
    return type;
  }
  switch (type) {
    case 'text':
    case 'jsonb':
    case 'timestamptz':
      return 'text';
    case 'integer':
    case 'smallint':
    case 'bigint':
    case 'boolean':
      return 'integer';
    case 'numeric':
      return 'real';
  }
}

function column(dialect: StateDialect, name: string, spec: ColumnSpec, c: ColumnDefinitionBuilder): ColumnDefinitionBuilder {
  let b = c;
  if (spec.primaryKey === true) {
    b = b.primaryKey();
  }
  if (spec.notNull === true) {
    b = b.notNull();
  }
  if (spec.unique === true) {
    b = b.unique();
  }
  if (spec.default !== undefined) {
    if (spec.default === 'now') {
      b = b.defaultTo(dialect === 'postgres' ? sql`now()` : SQLITE_NOW);
    } else if (typeof spec.default === 'boolean' && dialect === 'sqlite') {
      b = b.defaultTo(spec.default ? 1 : 0);
    } else {
      b = b.defaultTo(spec.default);
    }
  }
  if (spec.references !== undefined) {
    b = b.references(spec.references);
  }
  const checks: string[] = [];
  if (spec.check !== undefined) {
    checks.push(spec.check);
  }
  if (dialect === 'sqlite' && spec.type === 'jsonb') {
    checks.push(`json_valid(${name})`);
  }
  if (dialect === 'sqlite' && spec.type === 'boolean') {
    checks.push(`${name} in (0, 1)`);
  }
  if (checks.length > 0) {
    b = b.check(sql.raw(checks.map((x) => `(${x})`).join(' and ')));
  }
  return b;
}

export async function createTable(db: Kysely<unknown>, dialect: StateDialect, name: string, spec: TableSpec): Promise<void> {
  let t = db.schema.createTable(name) as CreateTableBuilder<string, string>;
  for (const [col, colSpec] of Object.entries(spec.columns)) {
    t = t.addColumn(col, dataType(dialect, colSpec.type), (c) => column(dialect, col, colSpec, c));
  }
  if (spec.primaryKey !== undefined) {
    t = t.addPrimaryKeyConstraint(`${name}_pkey`, [...spec.primaryKey]);
  }
  await t.execute();
}

/**
 * Adds one column to an existing table. SQLite only adds a `notNull` column that has a `default`;
 * a migration that wants another default for new rows changes it afterwards (Postgres only).
 */
export async function addColumn(db: Kysely<unknown>, dialect: StateDialect, table: string, name: string, spec: ColumnSpec): Promise<void> {
  await db.schema
    .alterTable(table)
    .addColumn(name, dataType(dialect, spec.type), (c) => column(dialect, name, spec, c))
    .execute();
}

/** The index name both dialects use: `{table}_{columns}_idx` (ADR 0011). */
export function indexName(table: string, columns: readonly string[]): string {
  return `${table}_${columns.join('_')}_idx`;
}

export async function createIndex(db: Kysely<unknown>, table: string, columns: readonly string[]): Promise<void> {
  await db.schema.createIndex(indexName(table, columns)).on(table).columns([...columns]).execute();
}
