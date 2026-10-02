// The `incidents` projection (B 3, B 5): one row per incident or child work item, folded from its
// event log. `foldIncident` is the pure reducer; the rest maps the row to and from the table.
//
// What each event writes (every field not listed keeps its value):
// - `captured` creates the row: kind, parent, reporter, source, channel, anchor, `opened_at`.
//   Events for an incident with no row (no `captured` yet) fold to nothing.
// - `resolved`: surface, component, repo (the resolution replaces all three, absent ones included).
//   A later `resolved` (a clarify answer that named the surface or component, ADR 0015) replaces them again.
// - `scope-changed`, `dedupe-decided`, `clarify-answered` (ADR 0015): nothing but `last_seq` and
//   `updated_at`. What they change reaches the row through the events they lead to: a Link is
//   followed by `linked-to-existing`, a clarify answer that names a map entry by a second `resolved`.
// - `planned`: summary, priority, autonomy level, and the component when the plan names one.
// - `filed`, `linked-to-existing`: Jira key. `pr-opened`, `fixer-done`: PR number and branch.
// - `level-changed`, and `released` with a `restoredLevel`: autonomy level.
// - `jira-priority-changed`, `jira-assignee-changed`: priority and assignee (B 7.3, the human wins).
// - `status-message-posted`: `status_msg_id` (A 4.3, the pinned status message).
// - `waiting-changed`: `waiting_on`, with `since` from the event's `occurredAt`; absent clears it.
//   Any status change also clears it: the wait it described is over (ADR 0014).
// - `monitoring-started`, `monitoring-stopped`: `monitored` (A 4.5). Entering a terminal status
//   clears it, and a start on a terminal incident is ignored.
// - `corrected` (B 4, ADR 0014): refolds the log with the correction merged into the event at
//   `correctsSeq` and writes only the data columns whose value that changes. Statuses move on the
//   events as recorded, so a correction never changes `status` or `closed_at`.
// - Every event: `status` from `nextStatus` (B 5, #11), `last_seq`, and `updated_at` (the event's
//   `recordedAt`). Entering a terminal status sets `closed_at` to the event's `occurredAt`.
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
  /** False when the event did not fit the status it arrived in (`isValidTransition`), or a correction was ignored. */
  valid: boolean;
  /** Why a `corrected` event was ignored. Unset for a status misfit. */
  problem?: string;
}

/**
 * Folds one event into the row. Pure: no clock, no I/O. `log` is the incident's event log; only a
 * `corrected` event reads it (the events with a lower seq), so other callers may omit it.
 */
export function foldIncident(prev: IncidentView | undefined, e: IncidentEvent, log: readonly IncidentEvent[] = []): IncidentFold {
  if (prev !== undefined && e.type === 'corrected') {
    return foldCorrection(prev, e, log);
  }
  return step(prev, e, e);
}

/**
 * One fold step. The status moves on `statusEvent`; the data columns come from `dataEvent`, which is
 * the same event or, during a correction refold, its corrected form.
 */
function step(prev: IncidentView | undefined, statusEvent: IncidentEvent, dataEvent: IncidentEvent): IncidentFold {
  if (prev === undefined) {
    if (dataEvent.type !== 'captured') {
      return { view: undefined, valid: false };
    }
    const p = dataEvent.payload;
    const opened: IncidentView = {
      id: dataEvent.incidentId,
      workspaceId: dataEvent.workspaceId,
      ...(p.parentId !== undefined ? { parentId: p.parentId } : {}),
      kind: p.kind,
      lastSeq: dataEvent.seq,
      status: INITIAL_STATUS,
      reporterId: p.reporter.id,
      source: p.source,
      channelId: p.channelId,
      ...(p.anchorId !== undefined ? { anchorId: p.anchorId } : {}),
      monitored: false,
      openedAt: dataEvent.occurredAt,
      updatedAt: dataEvent.recordedAt,
    };
    return { view: opened, valid: true };
  }

  const e = statusEvent;
  const valid = isValidTransition(prev.status, e);
  const status = nextStatus(prev.status, e);
  let next: IncidentView = { ...applyFields(prev, dataEvent), status, lastSeq: Math.max(prev.lastSeq, e.seq), updatedAt: e.recordedAt };
  if (status !== prev.status) {
    next = withOpt(next, 'waitingOn', undefined);
  }
  if (isTerminalStatus(status)) {
    next = { ...next, monitored: false };
  }
  if (!isTerminalStatus(prev.status) && isTerminalStatus(status)) {
    next = { ...next, closedAt: e.occurredAt };
  }
  return { view: next, valid };
}

/** The optional fields an event may clear. */
type ClearableField = 'surfaceId' | 'componentId' | 'repo' | 'assigneeId' | 'waitingOn';

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
    case 'status-message-posted':
      return { ...v, statusMsgId: e.payload.messageId };
    case 'waiting-changed': {
      const w = e.payload.waitingOn;
      const waitingOn: IncidentWaitingOn | undefined =
        w === undefined ? undefined : { kind: w.kind, ...(w.who !== undefined ? { who: w.who } : {}), since: e.occurredAt };
      return withOpt(v, 'waitingOn', waitingOn);
    }
    case 'monitoring-started':
      return isTerminalStatus(v.status) ? v : { ...v, monitored: true };
    case 'monitoring-stopped':
      return { ...v, monitored: false };
    default:
      return v;
  }
}

// Corrections (B 4, ADR 0014) ---------------------------------------------------------------------

/**
 * Columns a correction never writes: identity, and the bookkeeping every event updates. `status` and
 * `closed_at` follow the events as recorded.
 */
const NOT_CORRECTABLE: ReadonlySet<string> = new Set<keyof IncidentView>(['id', 'workspaceId', 'lastSeq', 'status', 'openedAt', 'closedAt', 'updatedAt']);

type CorrectedEvent = IncidentEvent<'corrected'>;

type JsonKind = 'null' | 'array' | 'object' | 'string' | 'number' | 'boolean' | 'other';

function jsonKind(value: unknown): JsonKind {
  if (value === null) {
    return 'null';
  }
  if (Array.isArray(value)) {
    return 'array';
  }
  const t = typeof value;
  return t === 'object' || t === 'string' || t === 'number' || t === 'boolean' ? t : 'other';
}

/** Why correction `c` cannot apply to `target` (the original event at `correctsSeq`), or undefined when it can. */
function correctionProblem(c: CorrectedEvent, target: IncidentEvent | undefined): string | undefined {
  const { correctsSeq, fields } = c.payload;
  if (!Number.isSafeInteger(correctsSeq) || correctsSeq < 1 || correctsSeq >= c.seq) {
    return `correctsSeq ${String(correctsSeq)} is not an earlier seq`;
  }
  if (target === undefined) {
    return `seq ${correctsSeq} is not in the log`;
  }
  if (target.type === 'corrected') {
    return `seq ${correctsSeq} is itself a correction; correct the original seq again`;
  }
  if (jsonKind(fields) !== 'object') {
    return 'fields is not an object';
  }
  const original = target.payload as unknown as Record<string, unknown>;
  for (const [key, value] of Object.entries(fields)) {
    if (value !== null && Object.hasOwn(original, key) && jsonKind(original[key]) !== jsonKind(value)) {
      return `field ${JSON.stringify(key)} would change from ${jsonKind(original[key])} to ${jsonKind(value)}`;
    }
  }
  return undefined;
}

/** `target` with the correction's fields merged into its payload; a `null` field removes the key. */
function mergeCorrection(target: IncidentEvent, c: CorrectedEvent): IncidentEvent {
  const payload: Record<string, unknown> = { ...(target.payload as unknown as Record<string, unknown>) };
  for (const [key, value] of Object.entries(c.payload.fields)) {
    if (value === null) {
      delete payload[key];
    } else {
      payload[key] = value;
    }
  }
  // The type checks in `correctionProblem` keep the merged payload the shape of `target.type`.
  return { ...target, payload } as unknown as IncidentEvent;
}

/**
 * Refolds `log` (seq order, corrections included) from nothing, with each applicable correction in
 * `corrections` merged into the event it corrects, stacking in order. Statuses move on the events
 * as recorded; data columns come from the corrected forms.
 */
function refold(log: readonly IncidentEvent[], corrections: readonly CorrectedEvent[]): IncidentView | undefined {
  const original = new Map(log.map((e) => [e.seq, e]));
  const merged = new Map<number, IncidentEvent>();
  for (const c of corrections) {
    const target = original.get(c.payload.correctsSeq);
    if (target !== undefined && correctionProblem(c, target) === undefined) {
      merged.set(c.payload.correctsSeq, mergeCorrection(merged.get(c.payload.correctsSeq) ?? target, c));
    }
  }
  let view: IncidentView | undefined;
  for (const e of log) {
    if (e.type !== 'corrected') {
      view = step(view, e, merged.get(e.seq) ?? e).view;
    }
  }
  return view;
}

/** Column values as the row stores them: primitives, or the `waiting_on` object built in one key order. */
function sameValue(a: unknown, b: unknown): boolean {
  return a === b || (typeof a === 'object' && typeof b === 'object' && JSON.stringify(a) === JSON.stringify(b));
}

/**
 * A `corrected` event: refold the log before it without and with this correction, and write onto
 * `prev` only the data columns whose value differs. A later event that overwrote a column keeps its
 * value, because both refolds replay it.
 */
function foldCorrection(prev: IncidentView, c: CorrectedEvent, log: readonly IncidentEvent[]): IncidentFold {
  const before = log.filter((e) => e.seq < c.seq).sort((a, b) => a.seq - b.seq);
  const bookkept: IncidentView = { ...prev, lastSeq: Math.max(prev.lastSeq, c.seq), updatedAt: c.recordedAt };
  const problem = correctionProblem(c, before.find((e) => e.seq === c.payload.correctsSeq));
  if (problem !== undefined) {
    return { view: bookkept, valid: false, problem };
  }
  const earlier = before.filter((e): e is CorrectedEvent => e.type === 'corrected');
  const without = refold(before, earlier);
  const withIt = refold(before, [...earlier, c]);
  if (without === undefined || withIt === undefined) {
    return { view: bookkept, valid: true };
  }
  const from = without as unknown as Record<string, unknown>;
  const to = withIt as unknown as Record<string, unknown>;
  const next = { ...bookkept } as unknown as Record<string, unknown>;
  for (const key of new Set([...Object.keys(from), ...Object.keys(to)])) {
    if (NOT_CORRECTABLE.has(key) || sameValue(from[key], to[key])) {
      continue;
    }
    if (Object.hasOwn(to, key)) {
      next[key] = to[key];
    } else {
      delete next[key];
    }
  }
  return { view: next as unknown as IncidentView, valid: true };
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
