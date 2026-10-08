// The outbox rows an event implies (B 4: "the outbox row exists or the event does not"), as a
// registry of per-target modules. `applyProjections` calls `outboxFor` for each event it folds, inside
// the append transaction, and enqueues what it returns; rebuild replays with `{ outbox: false }` and
// never calls it.
//
// A target module is a pure function of the event and the incident row before and after the event
// folded: ids, `createdAt`, and `nextAttempt` come from the event (`rowsFor` in row.ts), never the
// clock. A new target adds a file here and one line in `TARGETS`.
//
// The engine enqueues some rows itself, in the transaction that appends the event they belong to
// (`create-issue`, the In Progress transition, the dedupe link comment; engine/steps.ts). A module
// never repeats one of those.

import type { IncidentEvent } from '../../../contracts/events.ts';
import type { IncidentView, OutboxItem } from '../../../contracts/state.ts';
import type { NotifyContext } from '../../../notify/policy.ts';
import { githubRows } from './github.ts';
import { jiraRows } from './jira.ts';
import { notifyRows } from './notify.ts';
import { statusRows } from './status.ts';

/** What folding one event did to the incident row. */
export interface IncidentChange {
  /** The row before the event; undefined for the incident's `captured` event. */
  before: IncidentView | undefined;
  /** The row after the event. */
  after: IncidentView;
  /** False when the event did not fit the status it arrived in (the status was kept), or a correction was ignored. */
  valid: boolean;
  /**
   * `filed` only: the chat user id of the engineer whose claim holds the fixer at this point of the log
   * (A 2.1, `claimHold` over the events before `filed`). The first status post then reads ticket only.
   */
  holdClaimerId?: string;
  /**
   * What the notification policy needs (playbook, subscriptions, the open batch; notify/policy.ts).
   * Absent: no notification rows, which is the default (A 4.4: off beyond the pinned edit).
   */
  notify?: NotifyContext;
}

/** One target's rows for one event. */
export type TargetRows = (event: IncidentEvent, change: IncidentChange) => OutboxItem[];

/** Every target module, in the order their rows are enqueued. */
const TARGETS: readonly TargetRows[] = [
  jiraRows,
  statusRows,
  notifyRows,
  // The login was recorded on the event; projection never looks it up (rebuild stays pure).
  (event, change) => githubRows(event, change, event.type === 'comment' && event.payload.actorGithubLogin !== undefined ? { githubLogin: event.payload.actorGithubLogin } : {}),
];

/** The outbox items `event` implies, given what it did to the incident row. */
export function outboxFor(event: IncidentEvent, change: IncidentChange): OutboxItem[] {
  return TARGETS.flatMap((rows) => rows(event, change));
}
