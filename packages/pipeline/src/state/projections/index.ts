// Projections (B 3, B 4): incidents, claims, subscriptions, escalation scores. Stubs until #18.

import type { Claim, IncidentEvent, IncidentQuery, IncidentView, Subscription } from '../../contracts/state.ts';
import type { StateContext } from '../context.ts';
import { NotImplementedError } from '../errors.ts';

/**
 * Folds `events` into the projection tables inside the append transaction (`tx`). A no-op until
 * #18, so #17's append can call it already.
 */
export async function applyProjections(_tx: StateContext, _events: readonly IncidentEvent[]): Promise<void> {}

/** See `StatePort.getIncident`. */
export async function getIncident(_ctx: StateContext, _incidentId: string): Promise<IncidentView | null> {
  throw new NotImplementedError('getIncident');
}

/** See `StatePort.findIncidents`. */
export async function findIncidents(_ctx: StateContext, _q: IncidentQuery): Promise<IncidentView[]> {
  throw new NotImplementedError('findIncidents');
}

/** See `StatePort.getClaims`. */
export async function getClaims(_ctx: StateContext, _incidentId: string): Promise<Claim[]> {
  throw new NotImplementedError('getClaims');
}

/** See `StatePort.getSubscriptions`. */
export async function getSubscriptions(_ctx: StateContext, _incidentId: string): Promise<Subscription[]> {
  throw new NotImplementedError('getSubscriptions');
}
