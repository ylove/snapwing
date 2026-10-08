// Incidents projection, part two (B 3, B 4, A 4.3, A 4.5, ADR 0014): `corrected` events refold
// the columns their correction changes, and the status message, waiting-on, and monitoring events
// fold into `status_msg_id`, `waiting_on`, and `monitored`. Runs on the dialect `SNAPWING_DB`
// selects; CI runs it once per dialect.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { IncidentView } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { StateContext } from '../../src/state/context.ts';
import { foldIncident } from '../../src/state/projections/index.ts';
import { rebuild } from '../../src/state/rebuild.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ0000000000000000000001';
const INC = '01JZ00000000000000000000A1';
const REPORTER = { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' } as const;
const DANA = 'U-FAKE-DANA';

// One database and one handle per file, opened once; tables are emptied between tests.
let tdb: TestDatabase;
let state: OpenedState;
let ctx: StateContext;
let clock: () => Date = () => new Date();

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => clock() });
  if (!(state instanceof StateStore)) {
    throw new Error('openState did not return a StateStore');
  }
  ctx = state.ctx;
});

afterAll(async () => {
  await tdb.drop();
});

let minute = 0;

beforeEach(() => {
  clock = () => new Date('2026-10-01T12:00:00.000Z');
  minute = 0;
});

afterEach(async () => {
  vi.restoreAllMocks();
  await clearProjections();
  await ctx.db.deleteFrom('incident_events').execute();
  await ctx.db.deleteFrom('outbox').execute();
});

async function clearProjections(): Promise<void> {
  await ctx.db.deleteFrom('claims').execute();
  await ctx.db.deleteFrom('escalation_scores').execute();
  await ctx.db.deleteFrom('subscriptions').execute();
  await ctx.db.deleteFrom('incidents').execute();
}

// Event builders ----------------------------------------------------------------------------------

/** `occurredAt` one minute after the previous event's, from 09:00. */
function nextTime(): string {
  return new Date(Date.parse('2026-10-01T09:00:00.000Z') + minute++ * 60_000).toISOString();
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], extra: { occurredAt?: string } = {}): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId: INC,
    type,
    v: 1,
    source: 'agent',
    occurredAt: extra.occurredAt ?? nextTime(),
    payload,
  } as unknown as NewEvent<T>;
}

function correct(correctsSeq: number, fields: Record<string, unknown>, reason = 'fix the record'): NewEvent<'corrected'> {
  return ev('corrected', { correctsSeq, fields, reason });
}

/** Seqs 1..6: captured, context-assembled, resolved (3), dedupe-checked, planned (5), filed (6). */
function toFiled(): NewEvent[] {
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:T-FAKE:C-FAKE:${INC}`,
      source: 'slack',
      reporter: REPORTER,
      anchorText: 'Checkout says 500',
      anchorId: '1727773199.000100',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 4, excludedCount: 1 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: 2,
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
  ];
}

/** Seqs 7..10 after `toFiled`: fixer-started, pr-opened, review-passed, ci-green; leaves the incident `mergeable`. */
function toMergeable(): NewEvent[] {
  return [
    ev('fixer-started', { runId: '01JZ00000000000000000000R1', harness: 'claude-code', attempt: 1 }),
    ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' }),
    ev('review-passed', { prNumber: 77 }),
    ev('ci-green', { prNumber: 77, headSha: 'fakesha1' }),
  ];
}

async function appendAll(events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

async function incident(): Promise<IncidentView> {
  const v = await state.getIncident(INC);
  if (v === null) {
    throw new Error('no incident row');
  }
  return v;
}

/** The row without the bookkeeping every event updates. */
function data(v: IncidentView): Omit<IncidentView, 'lastSeq' | 'updatedAt'> {
  const { lastSeq: _seq, updatedAt: _at, ...rest } = v;
  return rest;
}

/** Rebuilds the incident from its log in batches of `batchSize`, and reads the row back. */
async function rebuilt(batchSize: number): Promise<IncidentView> {
  await rebuild(state, { incidentId: INC }, { batchSize });
  return incident();
}

// corrected ---------------------------------------------------------------------------------------

describe(`corrected events refold the incidents row (${TEST_DIALECT})`, () => {
  it('changes only the column the correction changes, and stamps last_seq and updated_at', async () => {
    await state.append(INC, toFiled(), 0);
    const before = await incident();

    clock = () => new Date('2026-10-01T13:00:00.000Z');
    await appendAll([correct(3, { surfaceId: 'cart' }, 'wrong surface')]);

    const after = await incident();
    expect(data(after)).toEqual({ ...data(before), surfaceId: 'cart' });
    expect(after).toMatchObject({ status: 'filed', lastSeq: 7, updatedAt: '2026-10-01T13:00:00.000Z' });
  });

  it('touches no data column when the corrected field feeds none (planned.labels)', async () => {
    await state.append(INC, toFiled(), 0);
    const before = await incident();
    await appendAll([correct(5, { labels: ['snapwing', 'checkout'] })]);
    expect(data(await incident())).toEqual(data(before));
  });

  it('removes an optional column when the field is null', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([correct(3, { componentId: null })]);
    const after = await incident();
    expect('componentId' in after).toBe(false);
    expect(after).toMatchObject({ surfaceId: 'web', repo: 'fake-org/web' });
  });

  it('keeps a later event that already overwrote the column (the human priority in Jira wins)', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'High', to: 'Highest' })]);
    await appendAll([correct(5, { priority: 'Low', summary: 'Checkout total is blank' })]);
    expect(await incident()).toMatchObject({ priority: 'Highest', summary: 'Checkout total is blank' });

    // Correcting the Jira edit itself does change the column.
    await appendAll([correct(7, { to: 'Medium' })]);
    expect((await incident()).priority).toBe('Medium');
  });

  it('stacks corrections of one seq in log order', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([correct(3, { surfaceId: 'cart' })]);
    await appendAll([correct(3, { repo: 'fake-org/cart' })]);
    expect(await incident()).toMatchObject({ surfaceId: 'cart', repo: 'fake-org/cart', componentId: 'checkout' });
    await appendAll([correct(3, { surfaceId: 'payments' })]);
    expect(await incident()).toMatchObject({ surfaceId: 'payments', repo: 'fake-org/cart' });
  });

  it('corrects the columns `captured` opened the row with', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([correct(1, { channelId: 'C-FAKE-OTHER', anchorId: null })]);
    const after = await incident();
    expect(after).toMatchObject({ channelId: 'C-FAKE-OTHER', openedAt: '2026-10-01T09:00:00.000Z', status: 'filed' });
    expect('anchorId' in after).toBe(false);
  });

  it('never changes the status: a gate hold corrected to an environment hold stays held', async () => {
    await state.append(INC, [...toFiled(), ...toMergeable()], 0);
    await appendAll([ev('held', { kind: 'gate', reason: 'level 2 needs approval' })]);
    expect((await incident()).status).toBe('held');
    await appendAll([correct(11, { kind: 'environment', env: 'staging', expiresAt: '2026-10-01T14:00:00Z' })]);
    expect((await incident()).status).toBe('held');
  });

  it('never changes closed_at, and corrects data on a closed incident', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([ev('closed', { reason: 'fixed' }, { occurredAt: '2026-10-01T10:00:00.000Z' })]);
    await appendAll([correct(6, { jiraKey: 'WEB-1043' })]);
    expect(await incident()).toMatchObject({ status: 'closed', closedAt: '2026-10-01T10:00:00.000Z', jiraKey: 'WEB-1043' });
  });

  it('ignores and logs a correction it cannot apply, and still stamps last_seq', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await state.append(INC, toFiled(), 0);
    const before = await incident();
    await appendAll([
      correct(9, { surfaceId: 'later' }),
      correct(42, { surfaceId: 'missing' }),
      correct(3, { surfaceId: 42 }),
      correct(3, { surfaceId: 'cart' }),
      correct(10, { surfaceId: 'correcting-a-correction' }),
    ]);
    const after = await incident();
    expect(data(after)).toEqual({ ...data(before), surfaceId: 'cart' });
    expect(after.lastSeq).toBe(11);
    const messages = warn.mock.calls.map((c) => String(c[0]));
    expect(messages).toHaveLength(4);
    expect(messages[0]).toContain('seq 7: correction ignored: correctsSeq 9 is not an earlier seq');
    expect(messages[1]).toContain('seq 8: correction ignored: correctsSeq 42 is not an earlier seq');
    expect(messages[2]).toContain('field "surfaceId" would change from string to number');
    expect(messages[3]).toContain('seq 10 is itself a correction');
  });

  it('a correction later in the same batch as the event it corrects', async () => {
    await state.append(INC, [...toFiled(), correct(5, { priority: 'Highest' })], 0);
    expect(await incident()).toMatchObject({ priority: 'Highest', lastSeq: 7, status: 'filed' });
  });

  it('rebuilds to the same row whatever the batch size', async () => {
    await state.append(INC, [...toFiled(), correct(3, { surfaceId: 'cart' })], 0);
    await appendAll([ev('jira-priority-changed', { jiraKey: 'WEB-1042', to: 'Highest' }), correct(5, { priority: 'Low', summary: 'Blank total' })]);
    await appendAll([ev('waiting-changed', { waitingOn: { kind: 'human', who: DANA } }), correct(10, { waitingOn: { kind: 'review' } })]);
    const live = await incident();
    expect(live).toMatchObject({ surfaceId: 'cart', priority: 'Highest', summary: 'Blank total', waitingOn: { kind: 'review', since: '2026-10-01T09:09:00.000Z' } });
    expect(await rebuilt(1)).toEqual(live);
    expect(await rebuilt(5)).toEqual(live);
    expect(await rebuilt(100)).toEqual(live);
  });

  it('the pure fold leaves a correction with no log as a logged no-op', () => {
    const prev: IncidentView = {
      id: INC,
      workspaceId: WS,
      kind: 'incident',
      lastSeq: 3,
      status: 'resolved',
      surfaceId: 'web',
      source: 'slack',
      monitored: false,
      openedAt: '2026-10-01T09:00:00.000Z',
      updatedAt: '2026-10-01T09:00:00.000Z',
    };
    const e = { ...correct(3, { surfaceId: 'cart' }), seq: 4, recordedAt: '2026-10-01T10:00:00.000Z' } as IncidentEvent;
    const fold = foldIncident(prev, e);
    expect(fold).toMatchObject({ valid: false, problem: 'seq 3 is not in the log' });
    expect(fold.view).toEqual({ ...prev, lastSeq: 4, updatedAt: '2026-10-01T10:00:00.000Z' });
  });
});

// status message, waiting on, monitoring ----------------------------------------------------------

describe(`status message, waiting-on, and monitoring columns (${TEST_DIALECT})`, () => {
  it('status-message-posted sets status_msg_id; a repost replaces it', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([ev('status-message-posted', { messageId: '1727773200.000200' })]);
    expect((await incident()).statusMsgId).toBe('1727773200.000200');
    await appendAll([ev('status-message-posted', { messageId: '1727773300.000300' })]);
    expect(await incident()).toMatchObject({ statusMsgId: '1727773300.000300', status: 'filed' });
  });

  it('waiting-changed sets waiting_on with since from occurredAt; a status change or an empty payload clears it', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([ev('waiting-changed', { waitingOn: { kind: 'human', who: DANA } }, { occurredAt: '2026-10-01T10:00:00.000Z' })]);
    expect((await incident()).waitingOn).toEqual({ kind: 'human', who: DANA, since: '2026-10-01T10:00:00.000Z' });

    // An event that does not move the status leaves it.
    await appendAll([ev('jira-assignee-changed', { jiraKey: 'WEB-1042', to: DANA })]);
    expect((await incident()).waitingOn).toEqual({ kind: 'human', who: DANA, since: '2026-10-01T10:00:00.000Z' });

    await appendAll([ev('waiting-changed', {})]);
    expect('waitingOn' in (await incident())).toBe(false);

    // Status first, then the wait: the order a step that moves and then parks appends in.
    await appendAll([ev('fixer-started', { runId: '01JZ00000000000000000000R1', harness: 'claude-code', attempt: 1 }), ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' })]);
    await appendAll([ev('waiting-changed', { waitingOn: { kind: 'review' } }, { occurredAt: '2026-10-01T11:00:00.000Z' })]);
    expect((await incident()).waitingOn).toEqual({ kind: 'review', since: '2026-10-01T11:00:00.000Z' });
    await appendAll([ev('review-passed', { prNumber: 77 }), ev('waiting-changed', { waitingOn: { kind: 'ci', who: 'unit' } }, { occurredAt: '2026-10-01T11:05:00.000Z' })]);
    expect(await incident()).toMatchObject({ status: 'ci', waitingOn: { kind: 'ci', who: 'unit', since: '2026-10-01T11:05:00.000Z' } });
    await appendAll([ev('ci-green', { prNumber: 77, headSha: 'fakesha1' })]);
    expect(await incident()).toMatchObject({ status: 'mergeable' });
    expect('waitingOn' in (await incident())).toBe(false);
  });

  it('monitoring-started and monitoring-stopped set monitored; closing clears it and a later start is ignored', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([ev('monitoring-started', { qualifiedBy: 'priority' })]);
    expect((await incident()).monitored).toBe(true);
    await appendAll([ev('monitoring-stopped', { reason: 'downgraded' })]);
    expect((await incident()).monitored).toBe(false);

    await appendAll([ev('monitoring-started', { qualifiedBy: 'outage-score' }), ev('waiting-changed', { waitingOn: { kind: 'hold', who: 'staging' } })]);
    expect(await incident()).toMatchObject({ monitored: true, waitingOn: { kind: 'hold' } });
    await appendAll([ev('closed', { reason: 'fixed' })]);
    const closed = await incident();
    expect(closed).toMatchObject({ status: 'closed', monitored: false });
    expect('waitingOn' in closed).toBe(false);

    await appendAll([ev('monitoring-started', { qualifiedBy: 'critical-surface' })]);
    expect((await incident()).monitored).toBe(false);
  });

  it('the four events are valid in every status they arrive in: no misfit warning, status kept', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await state.append(INC, [toFiled()[0] as NewEvent], 0);
    await appendAll([
      ev('status-message-posted', { messageId: '1727773200.000200' }),
      ev('waiting-changed', { waitingOn: { kind: 'human', who: REPORTER.id } }),
      ev('monitoring-started', { qualifiedBy: 'priority' }),
      ev('monitoring-stopped', { reason: 'disqualified' }),
    ]);
    expect(await incident()).toMatchObject({ status: 'captured', lastSeq: 5, statusMsgId: '1727773200.000200', monitored: false });
    expect(warn).not.toHaveBeenCalled();
  });

  it('a correction can fix the status message id and the waiting-on who', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll([ev('status-message-posted', { messageId: 'wrong' }), ev('waiting-changed', { waitingOn: { kind: 'human', who: 'U-FAKE-WRONG' } })]);
    await appendAll([correct(7, { messageId: '1727773200.000200' }), correct(8, { waitingOn: { kind: 'human', who: DANA } })]);
    expect(await incident()).toMatchObject({ statusMsgId: '1727773200.000200', waitingOn: { kind: 'human', who: DANA } });
  });
});
