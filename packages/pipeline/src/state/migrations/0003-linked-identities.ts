// 0003: `linked_identities` (main 11.2, ADR 0007, #153). A chat user's linked GitHub account, so a
// `Merge` tap acts as that human. The token columns hold sealed values (AES-256-GCM under
// `SNAPWING_ENCRYPTION_KEY`, util/seal.ts), never a token. No foreign key to `workspaces`: a link is
// made from an OAuth callback, which may come before the install's first config load.

import type { Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { createTable } from './schema.ts';

export const name = '0003-linked-identities';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await createTable(db, dialect, 'linked_identities', {
    columns: {
      workspace_id: { type: 'text', notNull: true },
      chat: { type: 'text', notNull: true, check: "chat in ('slack', 'teams')" },
      chat_user_id: { type: 'text', notNull: true },
      github_login: { type: 'text', notNull: true },
      github_user_id: { type: 'bigint', notNull: true },
      access_token: { type: 'text', notNull: true },
      access_token_expires_at: { type: 'timestamptz' },
      refresh_token: { type: 'text' },
      refresh_token_expires_at: { type: 'timestamptz' },
      linked_at: { type: 'timestamptz', notNull: true, default: 'now' },
      updated_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
    primaryKey: ['workspace_id', 'chat', 'chat_user_id'],
  });
}
