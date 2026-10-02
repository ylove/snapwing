// Value codec for the state store (ADR 0011, type mapping). The store writes the same encoded value
// on both dialects and decodes what each driver hands back:
//
// | B 3 type    | write (both)            | read: Postgres (`pg`)        | read: SQLite (`better-sqlite3`) |
// | jsonb       | JSON.stringify(value)   | already parsed               | JSON text: JSON.parse            |
// | timestamptz | ISO 8601 UTC, ms, `Z`   | a Date: toISOString()        | the ISO string                   |
// | boolean     | 1 or 0                  | a boolean                    | a number: === 1                  |
// | numeric     | a number                | a string: Number()           | a number                         |
//
// Driver traps this exists for: `pg` sends a JS array parameter as a Postgres array literal, not
// JSON, so jsonb is always stringified first; `better-sqlite3` refuses to bind a JS boolean; `pg`
// returns numeric, bigint, and count(*) as strings.

import type { StateDialect } from '../contracts/state.ts';

export interface StateCodec {
  readonly dialect: StateDialect;

  /** Encodes a JSON value for a jsonb column. Rejects `undefined`, which has no JSON form. */
  json(value: unknown): string;
  /** Decodes a jsonb column. */
  fromJson(raw: unknown): unknown;
  /** Decodes a nullable jsonb column; null becomes `undefined`. */
  fromJsonOpt(raw: unknown): unknown;

  /** Encodes a timestamptz: ISO 8601 UTC with milliseconds and `Z`, always 24 characters. */
  timestamp(value: Date | string): string;
  /** Decodes a timestamptz column to the same ISO form. */
  fromTimestamp(raw: unknown): string;
  /** Decodes a nullable timestamptz column; null becomes `undefined`. */
  fromTimestampOpt(raw: unknown): string | undefined;

  /** Encodes a boolean column as 1 or 0 (both dialects accept it). */
  bool(value: boolean): 0 | 1;
  /** Decodes a boolean column. */
  fromBool(raw: unknown): boolean;

  /** Decodes a numeric, bigint, or count column. */
  fromNumber(raw: unknown): number;
}

export function isoTimestamp(value: Date | string): string {
  const d = typeof value === 'string' ? new Date(value) : value;
  const ms = d.getTime();
  if (Number.isNaN(ms)) {
    throw new TypeError(`not a timestamp: ${JSON.stringify(String(value))}`);
  }
  // toISOString truncates to milliseconds and always ends in Z; years 0..9999 give 24 characters.
  return d.toISOString();
}

export function createCodec(dialect: StateDialect): StateCodec {
  const fromJson = (raw: unknown): unknown => {
    if (dialect === 'sqlite') {
      if (typeof raw !== 'string') {
        throw new TypeError(`sqlite jsonb column holds ${typeof raw}, expected JSON text`);
      }
      return JSON.parse(raw) as unknown;
    }
    return raw;
  };
  const fromTimestamp = (raw: unknown): string => {
    if (raw instanceof Date || typeof raw === 'string') {
      return isoTimestamp(raw);
    }
    throw new TypeError(`timestamptz column holds ${typeof raw}`);
  };

  return {
    dialect,
    json(value) {
      const text = JSON.stringify(value);
      if (text === undefined) {
        throw new TypeError('jsonb value has no JSON form (undefined, a function, or a symbol)');
      }
      return text;
    },
    fromJson,
    fromJsonOpt: (raw) => (raw === null || raw === undefined ? undefined : fromJson(raw)),
    timestamp: isoTimestamp,
    fromTimestamp,
    fromTimestampOpt: (raw) => (raw === null || raw === undefined ? undefined : fromTimestamp(raw)),
    bool: (value) => (value ? 1 : 0),
    fromBool(raw) {
      if (typeof raw === 'boolean') {
        return raw;
      }
      if (raw === 0 || raw === 1) {
        return raw === 1;
      }
      throw new TypeError(`boolean column holds ${JSON.stringify(raw)}`);
    },
    fromNumber(raw) {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' || typeof raw === 'bigint' ? Number(raw) : Number.NaN;
      if (Number.isNaN(n)) {
        throw new TypeError(`numeric column holds ${JSON.stringify(String(raw))}`);
      }
      return n;
    },
  };
}
