// Outbox (B 1, B 7.1): every external write goes through it. Stubs until #19.

import type { OutboxItem, OutboxTarget } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import { NotImplementedError } from './errors.ts';

/** See `StatePort.enqueueOutbox`. */
export async function enqueueOutbox(_ctx: StateContext, _item: OutboxItem): Promise<void> {
  throw new NotImplementedError('enqueueOutbox');
}

/** See `StatePort.drainOutbox`. */
export async function drainOutbox(_ctx: StateContext, _target: OutboxTarget, _limit: number): Promise<OutboxItem[]> {
  throw new NotImplementedError('drainOutbox');
}

/** See `StatePort.ackOutbox`. */
export async function ackOutbox(_ctx: StateContext, _ids: string[]): Promise<void> {
  throw new NotImplementedError('ackOutbox');
}
