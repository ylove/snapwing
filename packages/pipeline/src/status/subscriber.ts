// The engine's `status` dependency (main 12): subscribing the reporter to the status loopback records
// the subscription and posts nothing. The status message itself comes from the outbox: `filed` and
// every later lifecycle event that changes the message imply an `update-status` row
// (`state/projections/outbox/status.ts`), which the chat projector posts and edits.
//
// The subscription is a `comment` event with intent `watch` by the reporter, recorded by the agent on
// their behalf; the `subscriptions` projection folds it into an incident-scoped `thread` row (A 1.6),
// so a rebuild restores it. The engine appends it in the transaction that ends its after-filed step,
// with the step's own events, so no second writer races the step for the next seq.
//
// A note (why the incident was filed the way it was: an unresolved surface, a tap that timed out)
// rides on one more `update-status` row with the `filed` copy plus the note. It is enqueued after the
// `filed` row, under the same batch key, so the message ends up saying it.

import type { NewEvent } from '../contracts/events.ts';
import type { CanonicalIncidentPayload } from '../contracts/incident.ts';
import type { OutboxItem } from '../contracts/state.ts';
import type { StatusSubscriber, StatusSubscription } from '../engine/deps.ts';
import { statusBatchKey, statusTargets, UPDATE_STATUS_OP, type UpdateStatusRow } from '../state/projections/outbox/status.ts';
import { ulid } from '../util/ulid.ts';
import { makeStatusUpdate } from './copy.ts';

export interface StatusSubscriberOptions {
  /** The install's workspace, stamped on the event and rows. */
  workspaceId: string;
  clock: () => Date;
}

/** A `StatusSubscriber` that records the subscription instead of posting (see the file header). */
export function createStatusSubscriber(options: StatusSubscriberOptions): StatusSubscriber {
  return {
    subscribe(payload: CanonicalIncidentPayload, issueKey: string, note?: string): Promise<StatusSubscription> {
      const targets = statusTargets(payload.source);
      if (targets.length === 0) return Promise.resolve({ events: [], outbox: [] });
      const now = options.clock();
      const at = now.toISOString();
      const incidentId = payload.eventId;
      const platform = payload.source === 'teams' ? 'teams' : 'slack';
      const watch: NewEvent<'comment'> = {
        workspaceId: options.workspaceId,
        incidentId,
        type: 'comment',
        v: 1,
        source: 'agent',
        actor: { id: payload.reporter.id, role: payload.reporter.role },
        occurredAt: at,
        payload: { intent: 'watch', platform, signalSource: 'message', confidence: 1, raw: 'status loopback' },
      };
      const outbox: OutboxItem[] = [];
      if (note !== undefined && note.trim() !== '') {
        const row: UpdateStatusRow = { status: makeStatusUpdate('filed', { issueKey, note }) };
        for (const target of targets) {
          outbox.push({
            id: ulid(now.getTime()),
            workspaceId: options.workspaceId,
            target,
            incidentId,
            op: UPDATE_STATUS_OP,
            payload: { ...row },
            batchKey: statusBatchKey(incidentId),
            attempts: 0,
            nextAttempt: at,
            createdAt: at,
          });
        }
      }
      return Promise.resolve({ events: [watch], outbox });
    },
  };
}
