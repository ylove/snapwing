// Webhook inbox (B 1, B 8): delivery dedupe. Every inbound webhook passes through `seenWebhook`
// before any processing; a duplicate is acknowledged and dropped by the caller.

import type { StateContext } from './context.ts';
import { expiryAfter } from './kv.ts';

/**
 * See `StatePort.seenWebhook`. True if `(source, deliveryId)` was seen and its row has not expired
 * (`expires_at > now`). Otherwise records it, or renews an expired row, with `expires_at = now +
 * ttlSec` and returns false. One statement (an upsert whose update applies only to an expired row),
 * so of two concurrent calls exactly one sees false. `ttlSec` must be greater than 0 (B 8 uses 7 days).
 */
export async function seenWebhook(ctx: StateContext, source: string, deliveryId: string, ttlSec: number): Promise<boolean> {
  const expiresAt = expiryAfter(ctx, ttlSec, 'seenWebhook');
  const now = ctx.codec.timestamp(ctx.now());
  const result = await ctx.db
    .insertInto('webhook_inbox')
    .values({ source, delivery_id: deliveryId, received_at: now, expires_at: expiresAt })
    .onConflict((oc) =>
      oc
        .columns(['source', 'delivery_id'])
        .doUpdateSet({ received_at: now, expires_at: expiresAt })
        .where('webhook_inbox.expires_at', '<=', now),
    )
    .executeTakeFirst();
  return Number(result.numInsertedOrUpdatedRows ?? 0n) === 0;
}
