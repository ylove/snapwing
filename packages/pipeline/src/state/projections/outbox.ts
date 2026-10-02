// The outbox rows an event implies (B 4: "the outbox row exists or the event does not"). Out of
// scope for #18: the Jira projector (B 7, phase 3) fills this hook. `applyProjections` already
// enqueues whatever it returns in the append transaction, so filling it changes nothing else.
// Like every projection, it must be pure: ids, `createdAt`, and `nextAttempt` come from the event.

import type { IncidentEvent } from '../../contracts/events.ts';
import type { OutboxItem } from '../../contracts/state.ts';

/** The outbox items `event` implies. None yet. */
export function outboxFor(_event: IncidentEvent): OutboxItem[] {
  return [];
}
