// Chat rows for the pinned status message (main 12, B 7.1: "Slack and Teams edits to the pinned
// status message go through the same outbox with their own targets"). `statusFor` (status/loopback.ts)
// decides whether the event changes the message; this module turns its update into one
// `update-status` row per chat target the incident's thread lives on. Every row of an incident shares
// `batch_key` `status:{incident}`, so the chat projector keeps one message and edits it in place:
// the first row posts it (and pins it where the platform can), later ones edit it, and rows that pile up while the drain is
// paused collapse to the latest.
//
// The target is the platform the incident came from: a Slack thread gets `slack` rows, a Teams
// conversation `teams` rows (#8; Teams cannot pin, so its projector edits the one message in
// place). An incident from the CLI, Raycast, or an alert has no thread and gets no rows.

import type { StatusUpdate } from '../../../contracts/adapters.ts';
import type { IncidentEvent } from '../../../contracts/events.ts';
import type { ChannelSource } from '../../../contracts/incident.ts';
import type { OutboxItem, OutboxTarget } from '../../../contracts/state.ts';
import { statusFor } from '../../../status/loopback.ts';
import type { IncidentChange } from './index.ts';
import { rowsFor } from './row.ts';

export const UPDATE_STATUS_OP = 'update-status';

/** The chat target for each channel whose thread carries a status message. */
const CHAT_TARGETS: Readonly<Partial<Record<ChannelSource, OutboxTarget>>> = { slack: 'slack', teams: 'teams' };

/** The chat targets an incident from `source` posts its status message to. */
export function statusTargets(source: ChannelSource): OutboxTarget[] {
  const target = CHAT_TARGETS[source];
  return target === undefined ? [] : [target];
}

/** `batch_key` of every status row of an incident: one message, edited in place. */
export function statusBatchKey(incidentId: string): string {
  return `status:${incidentId}`;
}

/**
 * `update-status` payload: the whole message as it should now read. The projector finds the thread
 * and the message to edit from the incidents row (`channel_id`, `anchor_id`, `status_msg_id`).
 */
export interface UpdateStatusRow {
  status: StatusUpdate;
}

/** Chat rows for one event (see the file header). */
export function statusRows(event: IncidentEvent, change: IncidentChange): OutboxItem[] {
  if (!change.valid) return [];
  const status = statusFor(event, change.after, change.before, change.holdClaimerId);
  if (status === undefined) return [];
  const payload: UpdateStatusRow = { status };
  return statusTargets(change.after.source).flatMap((target) =>
    rowsFor(event, target, [{ op: UPDATE_STATUS_OP, payload: { ...payload }, batchKey: statusBatchKey(event.incidentId) }]),
  );
}
