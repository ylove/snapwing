// 0009: `run_credentials` (#273). One row per runner container run (a fixer or a review run) that
// holds a fixer API or model proxy token: whether those tokens are revoked, and what the run has spent
// with them (model requests and tokens through the model proxy, artifacts and their bytes through the
// fixer API). The first use or the revocation, whichever comes first, creates the row.
//
// Not a projection: nothing in the event log writes it, so `state rebuild` leaves it alone.

import type { Kysely } from 'kysely';
import type { StateDialect } from '../../contracts/state.ts';
import { createTable } from './schema.ts';

export const name = '0009-run-credentials';

export async function up(db: Kysely<unknown>, dialect: StateDialect): Promise<void> {
  await createTable(db, dialect, 'run_credentials', {
    columns: {
      run_id: { type: 'text', primaryKey: true },
      model_requests: { type: 'integer', notNull: true, default: 0 },
      input_tokens: { type: 'bigint', notNull: true, default: 0 },
      output_tokens: { type: 'bigint', notNull: true, default: 0 },
      artifacts: { type: 'integer', notNull: true, default: 0 },
      artifact_bytes: { type: 'bigint', notNull: true, default: 0 },
      revoked_at: { type: 'timestamptz' },
      created_at: { type: 'timestamptz', notNull: true, default: 'now' },
    },
  });
}
