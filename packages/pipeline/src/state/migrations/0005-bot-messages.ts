// 0005: `bot_messages` (A 1.3, #287). Every message Snapwing posted that a person can react to, with
// its target role, so a reaction resolves to `(intent, target role, reactor role)`. Folded from
// `bot-message-posted` events; keyed by platform, channel, and message id, because a Slack `ts` is
// unique only within its channel. Also indexes `incidents` by channel and anchor, the other half of
// the lookup (a reaction on the anchor message).
//
// No backfill: no event of this type exists before this migration.

import type { Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { createIndex, createTable } from './schema.ts';

export const name = '0005-bot-messages';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await createTable(db, dialect, 'bot_messages', {
    columns: {
      platform: { type: 'text', notNull: true, check: "platform in ('slack', 'teams')" },
      channel: { type: 'text', notNull: true },
      message_id: { type: 'text', notNull: true },
      workspace_id: { type: 'text', notNull: true },
      incident_id: { type: 'text', notNull: true, references: 'incidents.id' },
      role: { type: 'text', notNull: true },
      seq: { type: 'integer', notNull: true },
      posted_at: { type: 'timestamptz', notNull: true },
    },
    primaryKey: ['platform', 'channel', 'message_id'],
  });
  await createIndex(db, 'bot_messages', ['incident_id']);
  await createIndex(db, 'incidents', ['channel_id', 'anchor_id']);
}
