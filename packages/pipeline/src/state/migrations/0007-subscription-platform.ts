// 0007: `subscriptions.platform`. The chat platform a person subscribed from (`slack` or `teams`), so
// a DM notification goes where they are rather than to the incident's platform. Nullable: a row with
// none keeps the old target (the incident's platform), and a standing row written before this
// migration has no way to know it.
//
// Incident-scoped rows are backfilled from their incident's platform, which is what the projection
// writes for them, so a rebuild right after this migration finds nothing to change. Standing rows
// (scope `surface` and `all`) stay null until the person subscribes again.

import { sql, type Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { addColumn } from './schema.ts';

export const name = '0007-subscription-platform';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await addColumn(db, dialect, 'subscriptions', 'platform', { type: 'text', check: "platform in ('slack', 'teams')" });
  await sql`
    update subscriptions set platform = (
      select i.source from incidents i
      where i.id = subscriptions.scope_id and i.source in ('slack', 'teams')
    )
    where scope_kind = 'incident'
  `.execute(db);
}
