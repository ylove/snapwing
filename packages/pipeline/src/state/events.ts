// Event log (B 1, B 4): append, read, readSince. Stubs until #17.

import type { IncidentEvent, NewEvent } from '../contracts/state.ts';
import type { StateContext } from './context.ts';
import { NotImplementedError } from './errors.ts';

/** See `StatePort.append`. Runs in one transaction with `applyProjections` (projections/index.ts). */
export async function append(_ctx: StateContext, _incidentId: string, _events: NewEvent[], _expectedSeq: number): Promise<{ seq: number }> {
  throw new NotImplementedError('append');
}

/** See `StatePort.read`. */
export async function read(_ctx: StateContext, _incidentId: string, _fromSeq?: number): Promise<IncidentEvent[]> {
  throw new NotImplementedError('read');
}

/** See `StatePort.readSince`. */
export async function readSince(_ctx: StateContext, _cursor: string, _limit: number): Promise<{ events: IncidentEvent[]; cursor: string }> {
  throw new NotImplementedError('readSince');
}
