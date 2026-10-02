// The `incidents` projection (B 3, B 5): one row per incident or child work item, folded from its
// event log. `foldIncident` is the pure reducer; the rest maps the row to and from the table.
//
// What each event writes (every field not listed keeps its value):
// - `captured` creates the row: kind, parent, reporter, source, channel, anchor, `opened_at`.
//   Events for an incident with no row (no `captured` yet) fold to nothing.
// - `resolved`: surface, component, repo (the resolution replaces all three, absent ones included).
// - `planned`: summary, priority, autonomy level, and the component when the plan names one.
// - `filed`, `linked-to-existing`: Jira key. `pr-opened`, `fixer-done`: PR number and branch.
// - `level-changed`, and `released` with a `restoredLevel`: autonomy level.
// - `jira-priority-changed`, `jira-assignee-changed`: priority and assignee (B 7.3, the human wins).
// - Every event: `status` from `nextStatus` (B 5, #11), `last_seq`, and `updated_at` (the event's
//   `recordedAt`). Entering a terminal status sets `closed_at` to the event's `occurredAt`.
// `waiting_on`, `status_msg_id`, and `monitored` have no event in the catalog yet; they keep their
// defaults until the status and monitoring events (A 4) land. `corrected` events do not refold
// fields yet (#87).
//
// Deterministic: timestamps come from the events, never the clock.

import type { Selectable } from 'kysely';
import type { AutonomyLevel, IncidentEvent } from '../../contracts/events.ts';
import type { ChannelSource } from '../../contracts/incident.ts';
import type { IncidentKind, IncidentStatus, IncidentView, IncidentWaitingOn } from '../../contracts/state.ts';
import { INITIAL_STATUS, isTerminalStatus, isValidTransition, LIFECYCLE_STATUSES, nextStatus } from '../../lifecycle/machine.ts';
import type { StateContext } from '../context.ts';
import type { IncidentsTable } from '../db.ts';

export interface IncidentFold {
  /** The row after the event; undefined while the incident has no `captured` event. */
  view: IncidentView | undefined;
  /** False when the event did not fit the status it arrived in (`isValidTransition`). */
  valid: boolean;
}

/** Folds one event into the row. Pure: no clock, no I/O. */
export function foldIncident(prev: IncidentView | undefined, e: IncidentEvent): IncidentFold {
  if (prev === undefined) {
    if (e.type !== 'captured') {
      return { view: undefined, valid: false };
    }
    const p = e.payload;
    const opened: IncidentView = {
      id: e.incidentId,
      workspaceId: e.workspaceId,
      ...(p.parentId !== undefined ? { parentId: p.parentId } : {}),
      kind: p.kind,
      lastSeq: e.seq,
      status: INITIAL_STATUS,
      reporterId: p.reporter.id,
      source: p.source,
      channelId: p.channelId,
      ...(p.anchorId !== undefined ? { anchorId: p.anchorId } : {}),
      monitored: false,
      openedAt: e.occurredAt,
      updatedAt: e.recordedAt,
    };
    return { view: opened, valid: true };
  }

  const valid = isValidTransition(prev.status, e);
  const status = nextStatus(prev.status, e);
  let next: IncidentView = { ...applyFields(prev, e), status, lastSeq: Math.max(prev.lastSeq, e.seq), updatedAt: e.recordedAt };
  if (!isTerminalStatus(prev.status) && isTerminalStatus(status)) {
    next = { ...next, closedAt: e.occurredAt };
  }
  return { view: next, valid };
}

/** The optional fields an event may clear. */
type ClearableField = 'surfaceId' | 'componentId' | 'repo' | 'assigneeId';

/** Sets `key` to `value`, or removes it when `value` is undefined (absent, never `undefined`). */
function withOpt<K extends ClearableField>(view: IncidentView, key: K, value: IncidentView[K] | undefined): IncidentView {
  const next = { ...view };
  if (value === undefined) {
    delete next[key];
  } else {
    next[key] = value;
  }
  return next;
}

function applyFields(v: IncidentView, e: IncidentEvent): IncidentView {
  switch (e.type) {
    case 'resolved': {
      let next = withOpt(v, 'surfaceId', e.payload.surfaceId);
      next = withOpt(next, 'componentId', e.payload.componentId);
      return withOpt(next, 'repo', e.payload.repo);
    }
    case 'planned': {
      const next: IncidentView = { ...v, summary: e.payload.summary, priority: e.payload.priority, autonomyLevel: e.payload.autonomyLevel };
      return e.payload.componentId !== undefined ? { ...next, componentId: e.payload.componentId } : next;
    }
    case 'filed':
      return { ...v, jiraKey: e.payload.jiraKey };
    case 'linked-to-existing':
      return { ...v, jiraKey: e.payload.issueKey };
    case 'pr-opened':
    case 'fixer-done':
      return { ...v, prNumber: e.payload.prNumber, branch: e.payload.branch };
    case 'level-changed':
      return { ...v, autonomyLevel: e.payload.to };
    case 'released':
      return e.payload.scope === 'claim' && e.payload.restoredLevel !== undefined ? { ...v, autonomyLevel: e.payload.restoredLevel } : v;
    case 'jira-priority-changed':
      return { ...v, priority: e.payload.to };
    case 'jira-assignee-changed':
      return withOpt(v, 'assigneeId', e.payload.to);
    default:
      return v;
  }
}

// Table mapping -----------------------------------------------------------------------------------

type IncidentRow = Selectable<IncidentsTable>;

const STATUS_SET: ReadonlySet<string> = new Set<string>(LIFECYCLE_STATUSES);

function toStatus(raw: string, id: string): IncidentStatus {
  if (!STATUS_SET.has(raw)) {
    throw new TypeError(`incidents ${id}: unknown status ${JSON.stringify(raw)}`);
  }
  return raw as IncidentStatus;
}

function toAutonomyLevel(raw: number, id: string): AutonomyLevel {
  if (raw !== 0 && raw !== 1 && raw !== 2 && raw !== 3) {
    throw new TypeError(`incidents ${id}: autonomy_level ${raw} is not 0..3`);
  }
  return raw;
}

export function rowToIncident(ctx: StateContext, r: IncidentRow): IncidentView {
  const closedAt = ctx.codec.fromTimestampOpt(r.closed_at);
  const waitingOn = ctx.codec.fromJsonOpt(r.waiting_on) as IncidentWaitingOn | undefined;
  return {
    id: r.id,
    workspaceId: r.workspace_id,
    ...(r.parent_id !== null ? { parentId: r.parent_id } : {}),
    kind: r.kind as IncidentKind,
    lastSeq: ctx.codec.fromNumber(r.last_seq),
    status: toStatus(r.status, r.id),
    ...(r.surface_id !== null ? { surfaceId: r.surface_id } : {}),
    ...(r.component_id !== null ? { componentId: r.component_id } : {}),
    ...(r.repo !== null ? { repo: r.repo } : {}),
    ...(r.jira_key !== null ? { jiraKey: r.jira_key } : {}),
    ...(r.pr_number !== null ? { prNumber: ctx.codec.fromNumber(r.pr_number) } : {}),
    ...(r.branch !== null ? { branch: r.branch } : {}),
    ...(r.priority !== null ? { priority: r.priority } : {}),
    ...(r.autonomy_level !== null ? { autonomyLevel: toAutonomyLevel(ctx.codec.fromNumber(r.autonomy_level), r.id) } : {}),
    ...(r.assignee_id !== null ? { assigneeId: r.assignee_id } : {}),
    ...(r.reporter_id !== null ? { reporterId: r.reporter_id } : {}),
    source: r.source as ChannelSource,
    ...(r.channel_id !== null ? { channelId: r.channel_id } : {}),
    ...(r.anchor_id !== null ? { anchorId: r.anchor_id } : {}),
    ...(r.status_msg_id !== null ? { statusMsgId: r.status_msg_id } : {}),
    ...(r.summary !== null ? { summary: r.summary } : {}),
    ...(waitingOn !== undefined ? { waitingOn } : {}),
    monitored: ctx.codec.fromBool(r.monitored),
    openedAt: ctx.codec.fromTimestamp(r.opened_at),
    ...(closedAt !== undefined ? { closedAt } : {}),
    updatedAt: ctx.codec.fromTimestamp(r.updated_at),
  };
}

function incidentToRow(ctx: StateContext, v: IncidentView) {
  return {
    id: v.id,
    workspace_id: v.workspaceId,
    parent_id: v.parentId ?? null,
    kind: v.kind,
    last_seq: v.lastSeq,
    status: v.status,
    surface_id: v.surfaceId ?? null,
    component_id: v.componentId ?? null,
    repo: v.repo ?? null,
    jira_key: v.jiraKey ?? null,
    pr_number: v.prNumber ?? null,
    branch: v.branch ?? null,
    priority: v.priority ?? null,
    autonomy_level: v.autonomyLevel ?? null,
    assignee_id: v.assigneeId ?? null,
    reporter_id: v.reporterId ?? null,
    source: v.source,
    channel_id: v.channelId ?? null,
    anchor_id: v.anchorId ?? null,
    status_msg_id: v.statusMsgId ?? null,
    summary: v.summary ?? null,
    waiting_on: v.waitingOn !== undefined ? ctx.codec.json(v.waitingOn) : null,
    monitored: ctx.codec.bool(v.monitored),
    opened_at: ctx.codec.timestamp(v.openedAt),
    closed_at: v.closedAt !== undefined ? ctx.codec.timestamp(v.closedAt) : null,
    updated_at: ctx.codec.timestamp(v.updatedAt),
  };
}

export async function loadIncident(ctx: StateContext, incidentId: string): Promise<IncidentView | undefined> {
  const row = await ctx.db.selectFrom('incidents').selectAll().where('id', '=', incidentId).executeTakeFirst();
  return row === undefined ? undefined : rowToIncident(ctx, row);
}

/** Inserts the row when `existed` is false, otherwise rewrites it. */
export async function writeIncident(ctx: StateContext, v: IncidentView, existed: boolean): Promise<void> {
  const row = incidentToRow(ctx, v);
  if (existed) {
    const { id, ...rest } = row;
    await ctx.db.updateTable('incidents').set(rest).where('id', '=', id).execute();
  } else {
    await ctx.db.insertInto('incidents').values(row).execute();
  }
}
