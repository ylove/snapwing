// How a reconciled event is recognized (B 8, B 10): one of the four types the reconciler emits, with
// `reconciled: true` in its payload. Kept apart from the job so `/metrics` can count corrections
// without loading the reconciler.

import type { EventType, IncidentEvent } from '../contracts/events.ts';

/** The events the reconciler emits when a webhook never arrived. */
export const RECONCILED_EVENT_TYPES = ['ci-green', 'ci-red', 'merged', 'jira-transitioned'] as const satisfies readonly EventType[];

export type ReconciledEventType = (typeof RECONCILED_EVENT_TYPES)[number];

/** True for a payload the reconciler marked. Accepts a decoded payload of any event type. */
export function isReconciledPayload(payload: unknown): boolean {
  return typeof payload === 'object' && payload !== null && (payload as { reconciled?: unknown }).reconciled === true;
}

/** True for an event the reconciler emitted. */
export function isReconciled(event: IncidentEvent): event is IncidentEvent<ReconciledEventType> {
  return (RECONCILED_EVENT_TYPES as readonly string[]).includes(event.type) && isReconciledPayload(event.payload);
}
