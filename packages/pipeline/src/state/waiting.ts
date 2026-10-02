// Off-port read of the `incidents.waiting_on` projection (B 3) for the reconciler (B 8): which open
// incidents have been waiting since strictly before a cutoff. `findIncidents` orders by `updatedAt`
// and cannot filter on the wait, so this reads the table directly, like `readStoreMetrics`.
//
// `waiting_on.since` lives inside the jsonb value, which SQLite and Postgres query differently, so the
// filter on it runs here over the rows that wait at all (open incidents only, a small set).

import type { IncidentWaitingOn } from '../contracts/state.ts';
import { TERMINAL_STATUSES } from '../lifecycle/machine.ts';
import type { OpenedState, StatePort } from '../ports/state.ts';
import { StateStore } from './store.ts';

export interface StaleWait {
  readonly incidentId: string;
  readonly waitingOn: IncidentWaitingOn;
}

/**
 * Open (non-terminal) incidents whose `waiting_on.since` is strictly before `before`, oldest wait first
 * (then id), at most `limit`.
 */
export async function findStaleWaits(state: StatePort | OpenedState, before: Date, limit: number): Promise<StaleWait[]> {
  if (!(state instanceof StateStore)) {
    throw new TypeError('findStaleWaits needs the store openState returned');
  }
  if (!Number.isSafeInteger(limit) || limit < 1) {
    throw new TypeError(`findStaleWaits: limit must be a positive integer, got ${String(limit)}`);
  }
  const ctx = state.ctx;
  const rows = await ctx.db
    .selectFrom('incidents')
    .select(['id', 'waiting_on'])
    .where('waiting_on', 'is not', null)
    .where('status', 'not in', [...TERMINAL_STATUSES])
    .execute();
  const cutoff = before.getTime();
  const stale: StaleWait[] = [];
  for (const row of rows) {
    const waitingOn = ctx.codec.fromJsonOpt(row.waiting_on) as IncidentWaitingOn | undefined;
    if (waitingOn === undefined || !(Date.parse(waitingOn.since) < cutoff)) continue;
    stale.push({ incidentId: row.id, waitingOn });
  }
  stale.sort((a, b) => Date.parse(a.waitingOn.since) - Date.parse(b.waitingOn.since) || (a.incidentId < b.incidentId ? -1 : a.incidentId > b.incidentId ? 1 : 0));
  return stale.slice(0, limit);
}
