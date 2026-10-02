// 0004: `incidents.owner_ref` (#191, main 4.4, main 12). The resolved owner: the map handle the
// confidence stack named in the latest `resolved` event (`ownerId`), so the status message can
// say "assigned to @owner" before anyone is assigned in Jira. Nullable; the projection fills it.
//
// Rows already projected are backfilled from their latest `resolved` event. That ignores a
// `corrected` event aimed at it; `pnpm state rebuild` is exact.

import { sql, type Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { addColumn } from './schema.ts';

export const name = '0004-incident-owner-ref';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await addColumn(db, dialect, 'incidents', 'owner_ref', { type: 'text' });
  const ownerId = dialect === 'postgres' ? sql`e.payload ->> 'ownerId'` : sql`json_extract(e.payload, '$.ownerId')`;
  await sql`
    update incidents set owner_ref = (
      select ${ownerId} from incident_events e
      where e.incident_id = incidents.id and e.type = 'resolved'
      order by e.seq desc
      limit 1
    )
  `.execute(db);
}
