// 0006: `capture_tokens` (main 15.3, 15.4, 16, ADR 0007, #374). The per-user bearer tokens Raycast
// and the CLI send. A row holds the SHA-256 of the token, never the token: the plaintext is shown
// once when it is issued. One row per token, so a person may hold several (a laptop, a script) and a
// leaked one is revoked alone. A revoked row stays (with `revoked_at`) as the audit of who held what.
//
// Not a projection: nothing in the event log writes it, so `state rebuild` leaves it alone. No foreign
// key to `workspaces`, like `linked_identities`: `person` is a map handle, checked by the caller.

import type { Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { createTable } from './schema.ts';

export const name = '0006-capture-tokens';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await createTable(db, dialect, 'capture_tokens', {
    columns: {
      id: { type: 'text', primaryKey: true },
      workspace_id: { type: 'text', notNull: true },
      person: { type: 'text', notNull: true },
      label: { type: 'text' },
      token_hash: { type: 'text', notNull: true, unique: true },
      issued_at: { type: 'timestamptz', notNull: true, default: 'now' },
      last_used_at: { type: 'timestamptz' },
      revoked_at: { type: 'timestamptz' },
    },
  });
}
