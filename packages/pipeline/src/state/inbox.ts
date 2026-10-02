// Webhook inbox (B 1, B 8): delivery dedupe. Stub until #19.

import type { StateContext } from './context.ts';
import { NotImplementedError } from './errors.ts';

/** See `StatePort.seenWebhook`. */
export async function seenWebhook(_ctx: StateContext, _source: string, _deliveryId: string, _ttlSec: number): Promise<boolean> {
  throw new NotImplementedError('seenWebhook');
}
