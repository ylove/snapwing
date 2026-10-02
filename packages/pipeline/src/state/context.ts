// What every state function takes first, and the transaction helper they share. A leaf module so
// events.ts, projections, and the other stores can import it without an import cycle through
// store.ts and db.ts.

import type { Kysely } from 'kysely';
import type { StateDialect } from '../contracts/state.ts';
import type { StateCodec } from './codec.ts';
import type { Database } from './db.ts';

/**
 * `db` is the root handle or a transaction; functions never open their own connection. `now` is the
 * application clock: timestamps the store returns or orders by are written from it, never left to
 * `default now()` (ADR 0011).
 */
export interface StateContext {
  readonly db: Kysely<Database>;
  readonly dialect: StateDialect;
  readonly codec: StateCodec;
  readonly now: () => Date;
}

/**
 * Runs `fn` in a transaction: joins the one `ctx` is already in, otherwise opens one that commits
 * when `fn` resolves and rolls back when it throws. Inside `fn`, use the context it is given; on
 * SQLite the root handle waits for the transaction's one connection, so using it there deadlocks.
 */
export async function inTransaction<T>(ctx: StateContext, fn: (tx: StateContext) => Promise<T>): Promise<T> {
  if (ctx.db.isTransaction) {
    return fn(ctx);
  }
  return ctx.db.transaction().execute((trx) => fn({ ...ctx, db: trx }));
}
