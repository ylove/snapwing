// 0002: `incident_events.tx_order`, the key `readSince` pages on (ADR 0013). It orders events
// by the transaction that appended them: on Postgres the writing transaction's 64-bit id (the
// column default, `pg_current_xact_id()`), on SQLite a counter that append bumps once per
// transaction (state/events.ts). Rows already in the log are numbered -n .. -1 in the order
// `readSince` gave them before, (recorded_at, incident_id, seq), so every later append sorts after
// them on both dialects. Cursors issued before this migration are rejected as foreign.

import { sql, type Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { addColumn, createIndex } from './schema.ts';

export const name = '0002-event-tx-order';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await addColumn(db, dialect, 'incident_events', 'tx_order', { type: 'bigint', notNull: true, default: 0 });
  await sql`
    update incident_events set tx_order = r.pos
    from (
      select incident_id, seq, row_number() over (order by recorded_at, incident_id, seq) - count(*) over () - 1 as pos
      from incident_events
    ) as r
    where incident_events.incident_id = r.incident_id and incident_events.seq = r.seq
  `.execute(db);
  if (dialect === 'postgres') {
    // xid8 has no cast to bigint; through text is exact, and an xid8 stays below 2^63.
    await sql`alter table incident_events alter column tx_order set default (pg_current_xact_id()::text::bigint)`.execute(db);
  }
  await createIndex(db, 'incident_events', ['tx_order', 'incident_id', 'seq']);
}
