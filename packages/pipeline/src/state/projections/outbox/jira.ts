// Jira rows for lifecycle events (B 7.2 field map). The rows B 7.2 asks for that the engine does not
// enqueue itself: the engine writes `create-issue` (with the labels, custom fields, and level known at
// plan time), the In Progress transition after `filed`, and the dedupe link comment. Here:
//
// - `Agent Status` (`update-fields`): whenever its one line changes, which is every status change
//   (the status leads the line) plus a new PR number or a new wait. `filed` writes the first line.
// - Labels (`add-labels`): `human-claimed` on `claimed`, `needs-clarification` on `clarified`,
//   `fixer-failed` on `fixer-failed`, `prompt-failed` on a `planned` with no implementation request.
//   Before filing, `needs-clarification` and `prompt-failed` are in the create payload already, so
//   only a filed incident gets them here (a `planned` after `filed` is a re-plan no step appends
//   yet; it does not fit the status, and the label is still added, since the prompt did fail).
// - Status (`transition`): `merged` to in-review, or to done when autopilot merged (level 3, main
//   11.3); `closed` to done; `stopped` to backlog; `reverted` back out of done, to in-progress at level
//   1 or above (the revert PR is agent work) and to backlog at level 0 (main 11.3). Only when the event
//   moved the status there. The target is logical (`jira/statuses.ts`, #268): the projector resolves
//   it to the project's own status by category, so a To Do project and a Backlog project both work.
// - `Autonomy Level` (`update-fields`): whenever the level changes after filing (`level-changed`, or
//   a claim release that restores it).
// - Comments (`add-comment`, batched per 7.1): a stop names who stopped it (main 4.6); a degradation
//   says why: `fixer-failed` (main 10.4), a merge held at a gate (main 11.3), a lowered level (except
//   the degrade fixer/job.ts records after a fixer failure, which that comment already explains); a
//   level 3 merge links the merged PR (main 11.3) and a revert links the revert PR. A PR link is built
//   from the incident's repo and the PR number (the events carry only the number), and is left out
//   when the incident has no repo. A person is named by `actor.name` when the event carries one, else
//   by the platform user id (the log stores only the id, so a replayed event names the id).
//
// Rows go only to an issue the incident filed itself: none before `filed` (there is no key; the create
// payload carries the state at plan time) and none for an incident linked to someone else's issue.
// A `claimed`, `fixer-failed`, or status event that did not fit its status (the status was kept) adds
// no label, transition, or comment.
//
// Field writes carry one field each and `batch_key` `field:{incident}:{field}` (`jiraFieldBatchKey`),
// so the inbound sync can drop a pending agent write when a human edits that field (B 7.3); a
// transition is a write of the `status` field. Payloads name custom fields as create-issue does
// (`customFields` by name); the projector maps names to ids (#113).

import type { EventActor, IncidentEvent } from '../../../contracts/events.ts';
import type { IncidentView, OutboxItem } from '../../../contracts/state.ts';
import { BUDGET_EXCEEDED, FIXER_FAILED_REASON_PREFIX } from '../../../fixer/job.ts';
import type { JiraLogicalStatus } from '../../../jira/statuses.ts';
import { CUSTOM_FIELD_AUTONOMY_LEVEL, LABEL_NEEDS_CLARIFICATION, LABEL_PROMPT_FAILED } from '../../../jira/synthesis.ts';
import type { IncidentChange } from './index.ts';
import { rowsFor, type RowSpec } from './row.ts';

export const CUSTOM_FIELD_AGENT_STATUS = 'Agent Status';

export const LABEL_HUMAN_CLAIMED = 'human-claimed';
export const LABEL_FIXER_FAILED = 'fixer-failed';

/**
 * The logical targets B 7.2 transitions to (#268). A `transition` row carries one of these, never a
 * status name; the projector maps it to the project's status by category (`jira/statuses.ts`).
 */
export const JIRA_BACKLOG: JiraLogicalStatus = 'backlog';
export const JIRA_IN_PROGRESS: JiraLogicalStatus = 'in-progress';
export const JIRA_IN_REVIEW: JiraLogicalStatus = 'in-review';
export const JIRA_DONE: JiraLogicalStatus = 'done';

/**
 * The fields agent writes name in `jiraFieldBatchKey`: the ones these rows write, plus `priority` and
 * `assignee`, which B 7.2 has the agent write (on `escalated`, `claimed`, `planned`) and a human may
 * edit (B 7.3); the inbound sync drops a pending write to any of them.
 */
export type JiraField = 'status' | 'priority' | 'assignee' | typeof CUSTOM_FIELD_AGENT_STATUS | typeof CUSTOM_FIELD_AUTONOMY_LEVEL;

const FIELD_SLUGS: Readonly<Record<JiraField, string>> = {
  status: 'status',
  priority: 'priority',
  assignee: 'assignee',
  [CUSTOM_FIELD_AGENT_STATUS]: 'agent-status',
  [CUSTOM_FIELD_AUTONOMY_LEVEL]: 'autonomy-level',
};

/** `batch_key` of an agent write to `field` of the incident's issue (B 7.3 drops it on a human edit). */
export function jiraFieldBatchKey(incidentId: string, field: JiraField): string {
  return `field:${incidentId}:${FIELD_SLUGS[field]}`;
}

/** `batch_key` of the engine's `create-issue` row, so a Stop before filing can drop it unsent (#206). */
export function jiraCreateBatchKey(incidentId: string): string {
  return `create-issue:${incidentId}`;
}

/** `batch_key` of a comment; rows sharing it within 60 s become one comment (B 7.1). */
export function jiraCommentBatchKey(incidentId: string): string {
  return `comment:${incidentId}`;
}

// Payloads (the projector validates them, #140) ---------------------------------------------------

/** `update-fields`: exactly one custom field, by name. */
export interface UpdateFieldsRow {
  issueKey: string;
  customFields: Partial<Record<typeof CUSTOM_FIELD_AGENT_STATUS | typeof CUSTOM_FIELD_AUTONOMY_LEVEL, string | number>>;
}

/** `add-labels`: appended to the issue's labels. */
export interface AddLabelsRow {
  issueKey: string;
  labels: string[];
}

/** `transition`: a logical target, the same shape as the engine's in-progress row. */
export interface TransitionRow {
  issueKey: string;
  to: JiraLogicalStatus;
  /** A resolution name sent with the transition, e.g. "Won't Do" (#193). */
  resolution?: string;
}

/** `add-comment`: plain text, the same shape as the engine's comment row. */
export interface AddCommentRow {
  issueKey: string;
  text: string;
}

// Agent Status ----------------------------------------------------------------------------------

/**
 * The one-line Agent Status (B 7.2): the lifecycle status, then the PR, then what runs or is
 * awaited, joined by ` · ` so JQL `"Agent Status" ~ "fixing"` finds it. For example
 * `ci · PR #418 · CI running · waiting on ci`.
 */
export function agentStatusLine(incident: IncidentView): string {
  const parts: string[] = [incident.status];
  if (incident.prNumber !== undefined) parts.push(`PR #${String(incident.prNumber)}`);
  if (incident.status === 'ci' || incident.status === 'ci-retry') parts.push('CI running');
  if (incident.waitingOn !== undefined) parts.push(`waiting on ${incident.waitingOn.kind}`);
  return parts.join(' · ');
}

/** True when the incident's Jira key is an issue it filed (not one it was linked to). */
function ownsIssue(incident: IncidentView | undefined): incident is IncidentView & { jiraKey: string } {
  return incident?.jiraKey !== undefined && incident.status !== 'linked-to-existing';
}

// The module ------------------------------------------------------------------------------------

/** Jira rows for one event (see the file header). */
export function jiraRows(event: IncidentEvent, change: IncidentChange): OutboxItem[] {
  const { before, after, valid } = change;
  if (!ownsIssue(after)) return [];
  const issueKey = after.jiraKey;
  const incidentId = event.incidentId;
  const specs: RowSpec[] = [];
  const moved = (to: IncidentView['status']): boolean => valid && after.status === to && before?.status !== to;
  const field = (name: typeof CUSTOM_FIELD_AGENT_STATUS | typeof CUSTOM_FIELD_AUTONOMY_LEVEL, value: string | number): void => {
    const payload: UpdateFieldsRow = { issueKey, customFields: { [name]: value } };
    specs.push({ op: 'update-fields', payload: { ...payload }, batchKey: jiraFieldBatchKey(incidentId, name) });
  };
  const transition = (to: JiraLogicalStatus): void => {
    const payload: TransitionRow = { issueKey, to };
    specs.push({ op: 'transition', payload: { ...payload }, batchKey: jiraFieldBatchKey(incidentId, 'status') });
  };
  const label = (name: string): void => {
    const payload: AddLabelsRow = { issueKey, labels: [name] };
    specs.push({ op: 'add-labels', payload: { ...payload } });
  };
  const comment = (text: string): void => {
    const payload: AddCommentRow = { issueKey, text };
    specs.push({ op: 'add-comment', payload: { ...payload }, batchKey: jiraCommentBatchKey(incidentId) });
  };
  // The issue existed before this event; false on `filed`, which writes the first status line.
  const known = ownsIssue(before) && before.jiraKey === issueKey;

  // Workflow first, so a status line or comment never lands on an issue in its old column.
  if (moved('merged') && event.type === 'merged') transition(event.payload.levelAtMergeTime === 3 ? JIRA_DONE : JIRA_IN_REVIEW);
  if (moved('closed')) transition(JIRA_DONE);
  if (moved('stopped')) transition(JIRA_BACKLOG);
  if (moved('reverted') && event.type === 'reverted') transition(after.autonomyLevel === 0 ? JIRA_BACKLOG : JIRA_IN_PROGRESS);

  const line = agentStatusLine(after);
  if (!known || agentStatusLine(before) !== line) field(CUSTOM_FIELD_AGENT_STATUS, line);
  if (known && after.autonomyLevel !== undefined && after.autonomyLevel !== before.autonomyLevel) field(CUSTOM_FIELD_AUTONOMY_LEVEL, after.autonomyLevel);

  switch (event.type) {
    case 'claimed':
      if (valid) label(LABEL_HUMAN_CLAIMED);
      break;
    case 'clarified':
      if (known) label(LABEL_NEEDS_CLARIFICATION);
      break;
    case 'planned':
      if (known && event.payload.implementationRequest === undefined) label(LABEL_PROMPT_FAILED);
      break;
    case 'fixer-failed':
      if (valid) {
        label(LABEL_FIXER_FAILED);
        const p = event.payload;
        const why = p.reason === BUDGET_EXCEEDED ? 'it ran out of its time budget' : clause(p.reason);
        comment(`The fixer gave up after ${plural(p.attempts, 'attempt')}: ${why}. A human takes it from here.`);
      }
      break;
    case 'held':
      if (event.payload.kind === 'gate') comment(`Merge held at a gate: ${clause(event.payload.reason)}.`);
      break;
    case 'level-changed':
      // The degrade after a fixer failure (fixer/job.ts) is explained by the fixer-failed comment.
      if (known && event.payload.to < event.payload.from && !event.payload.reason.startsWith(FIXER_FAILED_REASON_PREFIX)) {
        const by = event.actor === undefined ? '' : ` by ${actorLabel(event.actor)}`;
        comment(`Autonomy level lowered${by} from ${String(event.payload.from)} to ${String(event.payload.to)}: ${clause(event.payload.reason)}.`);
      }
      break;
    default:
      break;
  }
  if (moved('merged') && event.type === 'merged' && event.payload.levelAtMergeTime === 3) {
    comment(`Merged ${prLink(after.repo, event.payload.prNumber)} on autopilot. Ticket done.`);
  }
  if (moved('reverted') && event.type === 'reverted') {
    const p = event.payload;
    const revert = p.revertPrNumber === undefined ? 'A revert' : `Revert ${prLink(after.repo, p.revertPrNumber)}`;
    const reason = clause(p.reason ?? '');
    comment(`${revert} of PR #${String(p.prNumber)} reopens this ticket${reason === '' ? '' : `: ${reason}`}.`);
  }
  if (moved('stopped') && event.type === 'stopped') {
    const by = event.actor === undefined ? 'Stopped' : `Stopped by ${actorLabel(event.actor)}`;
    const reason = clause(event.payload.reason ?? '');
    const why = reason === '' ? '' : `: ${reason}`;
    comment(`${by}${why}. Ticket back in the backlog.`);
  }
  return rowsFor(event, 'jira', specs);
}

/** A person by display name when the event carries one, else by platform user id. */
function actorLabel(actor: EventActor): string {
  const name = actor.name?.trim();
  return name === undefined || name === '' ? actor.id : name;
}

/** `PR #n` followed by its GitHub URL when the repo is known (the events carry only the number). */
function prLink(repo: string | undefined, prNumber: number): string {
  const ref = `PR #${String(prNumber)}`;
  // The workspace map writes `github.com/owner/name`; the URL wants `owner/name` (#240).
  const slug = repo?.replace(/^(?:https?:\/\/)?github\.com\//i, '').replace(/\/+$/, '');
  return slug === undefined || slug === '' ? ref : `${ref} (https://github.com/${slug}/pull/${String(prNumber)})`;
}

/** `text` without surrounding space or a closing period, to sit inside a sentence. */
function clause(text: string): string {
  return text.trim().replace(/[.\s]+$/, '');
}

function plural(n: number, word: string): string {
  return `${String(n)} ${word}${n === 1 ? '' : 's'}`;
}
