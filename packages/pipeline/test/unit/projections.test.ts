// Projections (B 3, B 4, B 5, A 7): incidents, claims, subscriptions, and escalation scores,
// folded in the append transaction, and the store reads over them. Runs on the dialect
// `SNAPWING_DB` selects; CI runs it once per dialect.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { Claim, IncidentView } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { StateContext } from '../../src/state/context.ts';
import {
  applyProjections,
  foldClaims,
  foldIncident,
  foldScores,
  getEscalationScores,
  outboxFor,
  type ScoreRow,
} from '../../src/state/projections/index.ts';
import { rebuild } from '../../src/state/rebuild.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01JZ0000000000000000000001';
const WS_OTHER = '01JZ0000000000000000000009';
const INC = '01JZ00000000000000000000A1';
const INC_B = '01JZ00000000000000000000B1';
const INC_C = '01JZ00000000000000000000C1';
const REPORTER = { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' } as const;
const DANA = 'U-FAKE-DANA';
const LEE = 'U-FAKE-LEE';
/** The map handle the confidence stack resolves as the owner (main 4.4). */
const OWNER = 'webDev1';

// One database and one handle per file, opened once (journal 2026-10-02-pg-introspection-race);
// tests set the clock through `clock` and the tables are emptied between tests.
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

beforeEach(() => {
  clock = () => new Date('2026-10-01T12:00:00.000Z');
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
  await ctx.db.deleteFrom('incidents').where('parent_id', 'is not', null).execute();
  await ctx.db.deleteFrom('incidents').execute();
}

// Event builders ----------------------------------------------------------------------------------

let minute = 0;

/** `occurredAt` one minute after the previous event's, from 09:00. */
function nextTime(): string {
  return new Date(Date.parse('2026-10-01T09:00:00.000Z') + minute++ * 60_000).toISOString();
}

beforeEach(() => {
  minute = 0;
});

function ev<T extends EventType>(
  type: T,
  payload: EventPayloads[T],
  extra: { incidentId?: string; actor?: string; occurredAt?: string; workspaceId?: string } = {},
): NewEvent<T> {
  return {
    workspaceId: extra.workspaceId ?? WS,
    incidentId: extra.incidentId ?? INC,
    type,
    v: 1,
    source: extra.actor === undefined ? 'agent' : 'slack',
    ...(extra.actor !== undefined ? { actor: { id: extra.actor, role: 'engineer' } } : {}),
    occurredAt: extra.occurredAt ?? nextTime(),
    payload,
  } as unknown as NewEvent<T>;
}

function captured(incidentId = INC, extra: { workspaceId?: string; parentId?: string } = {}): NewEvent<'captured'> {
  return ev(
    'captured',
    {
      kind: extra.parentId === undefined ? 'incident' : 'work-item',
      ...(extra.parentId !== undefined ? { parentId: extra.parentId } : {}),
      idempotencyKey: `slack:T-FAKE:C-FAKE:${incidentId}`,
      source: 'slack',
      reporter: REPORTER,
      anchorText: 'Checkout says 500',
      anchorId: '1727773199.000100',
      channelId: 'C-FAKE',
    },
    { incidentId, ...(extra.workspaceId !== undefined ? { workspaceId: extra.workspaceId } : {}) },
  );
}

/** captured through filed: six events that leave the incident `filed` as WEB-1042, owned by `webDev1`. */
function toFiled(incidentId = INC, opts: { summary?: string; surfaceId?: string; jiraKey?: string } = {}): NewEvent[] {
  return [
    captured(incidentId),
    ev('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 4, excludedCount: 1 }, { incidentId }),
    ev(
      'resolved',
      { surfaceId: opts.surfaceId ?? 'web', componentId: 'checkout', repo: 'fake-org/web', ownerId: OWNER, resolvedBy: 'channel-explicit', confidence: 0.9 },
      { incidentId },
    ),
    ev('dedupe-checked', { candidates: [], decision: 'none' }, { incidentId }),
    ev(
      'planned',
      {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary: opts.summary ?? 'Checkout returns 500 on submit',
        priority: 'High',
        labels: ['snapwing'],
        autonomyLevel: 2,
      },
      { incidentId },
    ),
    ev('filed', { jiraKey: opts.jiraKey ?? 'WEB-1042' }, { incidentId }),
  ];
}

async function appendAll(incidentId: string, events: NewEvent[]): Promise<void> {
  const last = (await state.read(incidentId)).at(-1)?.seq ?? 0;
  await state.append(incidentId, events, last);
}

function comment(intent: 'trigger' | 'escalate' | 'accept' | 'reject' | 'watch', actor: string, opts: { removed?: boolean; weight?: number } = {}): NewEvent<'comment'> {
  return ev(
    'comment',
    {
      intent,
      platform: 'slack',
      signalSource: opts.removed === true ? 'reaction-removed' : 'reaction',
      target: { role: 'anchor', messageId: '1727773199.000100' },
      confidence: 1,
      raw: intent === 'watch' ? 'bell' : 'fire',
      ...(intent !== 'watch' ? { count: { weight: opts.weight ?? 1, windowEndsAt: '2026-10-01T11:00:00Z' } } : {}),
    },
    { actor },
  );
}

// incidents ---------------------------------------------------------------------------------------

describe(`incidents projection (${TEST_DIALECT})`, () => {
  it('a 12-event incident produces the expected row, with status from nextStatus and last_seq tracking the log', async () => {
    clock = () => new Date('2026-10-01T10:00:00.000Z');
    await state.append(INC, toFiled(), 0);

    const filed = await state.getIncident(INC);
    expect(filed).toMatchObject({ status: 'filed', lastSeq: 6, jiraKey: 'WEB-1042', updatedAt: '2026-10-01T10:00:00.000Z' });

    clock = () => new Date('2026-10-01T11:00:00.000Z');
    await state.append(
      INC,
      [
        ev('fixer-started', { runId: '01JZ00000000000000000000R1', harness: 'claude-code', attempt: 1 }),
        ev('pr-opened', { prNumber: 77, branch: 'fix/WEB-1042' }),
        ev('review-passed', { prNumber: 77 }),
      ],
      6,
    );
    expect(await state.getIncident(INC)).toMatchObject({ status: 'ci', lastSeq: 9, prNumber: 77 });

    clock = () => new Date('2026-10-01T12:30:00.000Z');
    await state.append(INC, [ev('ci-green', { prNumber: 77, headSha: 'fakesha1' }), ev('merged', { prNumber: 77, mergeCommitSha: 'fakesha2', levelAtMergeTime: 2 })], 9);
    await state.append(INC, [ev('closed', { reason: 'fixed' }, { occurredAt: '2026-10-01T12:45:00Z' })], 11);

    const expected: IncidentView = {
      id: INC,
      workspaceId: WS,
      kind: 'incident',
      lastSeq: 12,
      status: 'closed',
      surfaceId: 'web',
      componentId: 'checkout',
      repo: 'fake-org/web',
      jiraKey: 'WEB-1042',
      prNumber: 77,
      branch: 'fix/WEB-1042',
      priority: 'High',
      autonomyLevel: 2,
      ownerRef: OWNER,
      reporterId: REPORTER.id,
      source: 'slack',
      channelId: 'C-FAKE',
      anchorId: '1727773199.000100',
      summary: 'Checkout returns 500 on submit',
      monitored: false,
      openedAt: '2026-10-01T09:00:00.000Z',
      closedAt: '2026-10-01T12:45:00.000Z',
      updatedAt: '2026-10-01T12:30:00.000Z',
    };
    expect(await state.read(INC)).toHaveLength(12);
    expect(await state.getIncident(INC)).toEqual(expected);
  });

  it('applies Jira edits, level changes, and the claim release that restores the level', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [
      ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'High', to: 'Highest' }),
      ev('jira-assignee-changed', { jiraKey: 'WEB-1042', to: DANA }),
      ev('level-changed', { from: 2, to: 0, reason: 'claimed by a human' }),
      ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' }, { actor: DANA }),
    ]);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'claimed', priority: 'Highest', assigneeId: DANA, autonomyLevel: 0 });

    await appendAll(INC, [
      ev('released', { scope: 'claim', claimerId: DANA, reason: 'expired', restoredLevel: 2 }),
      ev('jira-assignee-changed', { jiraKey: 'WEB-1042', from: DANA }),
    ]);
    const view = await state.getIncident(INC);
    expect(view).toMatchObject({ status: 'fixing', autonomyLevel: 2 });
    expect(view !== null && 'assigneeId' in view).toBe(false);
  });

  it('records a child work item with its parent and kind', async () => {
    await state.append(INC, [captured(INC)], 0);
    await state.append(INC_B, [captured(INC_B, { parentId: INC })], 0);
    expect(await state.getIncident(INC_B)).toMatchObject({ kind: 'work-item', parentId: INC, status: 'captured', lastSeq: 1 });
  });

  it('returns null for an unknown incident, and events before `captured` fold to nothing', async () => {
    expect(await state.getIncident(INC)).toBeNull();
    await state.append(INC, [ev('filed', { jiraKey: 'WEB-1' }), ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' })], 0);
    expect(await state.getIncident(INC)).toBeNull();
    expect(await state.getClaims(INC)).toEqual([]);
  });

  it('keeps the status and warns on an event that does not fit it', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    await state.append(INC, [captured(), ev('merged', { prNumber: 1, mergeCommitSha: 'fakesha', levelAtMergeTime: 1 })], 0);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'captured', lastSeq: 2 });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('merged does not fit status captured');
  });

  it('sets closed_at on any terminal status', async () => {
    await state.append(INC, [captured(), ev('resolution-signal', { messageId: 'm2', text: 'nvm works now' }, { occurredAt: '2026-10-01T09:05:00Z' })], 0);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'not-filed', closedAt: '2026-10-01T09:05:00.000Z' });
  });

  it('folds decision events as bookkeeping only, and a later resolved re-routes the row (ADR 0015)', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    clock = () => new Date('2026-10-01T10:00:00.000Z');
    await state.append(
      INC,
      [
        captured(),
        ev('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 2, excludedCount: 0 }),
        ev('scope-changed', { choice: 'widen', bundle: { artifactId: '01JZ00000000000000000000F1', version: 2 }, includedCount: 4, excludedCount: 1 }, { actor: DANA }),
        ev('resolved', { resolvedBy: 'unresolved', confidence: 0 }),
        ev('dedupe-checked', { candidates: [{ issueKey: 'WEB-7', summary: 'Checkout 500', score: 0.9 }], decision: 'pending-user' }),
        ev('dedupe-decided', { decision: 'create-anyway' }, { actor: DANA }),
        ev('clarified', { audience: 'reporter', question: 'Which part of the site?', asks: 'surface', options: ['Website', 'Mobile App'], timedOut: false }),
      ],
      0,
    );
    const before = await state.getIncident(INC);
    expect(before).toMatchObject({ status: 'deduped', lastSeq: 7 });
    expect(before !== null && 'surfaceId' in before).toBe(false);

    clock = () => new Date('2026-10-01T11:00:00.000Z');
    await appendAll(INC, [ev('clarify-answered', { questionSeq: 7, answer: 'Website', appliesTo: { field: 'surface', id: 'web' } }, { actor: DANA })]);
    const answered = await state.getIncident(INC);
    expect(answered).toEqual({ ...before, lastSeq: 8, updatedAt: '2026-10-01T11:00:00.000Z' });

    await appendAll(INC, [ev('resolved', { surfaceId: 'web', repo: 'fake-org/web', jiraProject: 'WEB', resolvedBy: 'clarify', confidence: 0.9 })]);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'deduped', lastSeq: 9, surfaceId: 'web', repo: 'fake-org/web' });
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps the resolved owner apart from the Jira assignee; a later resolution replaces it, absent included', async () => {
    await state.append(INC, toFiled(), 0);
    expect(await state.getIncident(INC)).toMatchObject({ ownerRef: OWNER });

    await appendAll(INC, [ev('jira-assignee-changed', { jiraKey: 'WEB-1042', to: DANA })]);
    expect(await state.getIncident(INC)).toMatchObject({ ownerRef: OWNER, assigneeId: DANA });

    await appendAll(INC, [ev('resolved', { surfaceId: 'web', ownerId: 'lee', resolvedBy: 'clarify', confidence: 0.9 })]);
    expect(await state.getIncident(INC)).toMatchObject({ ownerRef: 'lee', assigneeId: DANA });

    await appendAll(INC, [ev('resolved', { surfaceId: 'web', resolvedBy: 'clarify', confidence: 0.9 })]);
    const cleared = await state.getIncident(INC);
    expect(cleared).toMatchObject({ surfaceId: 'web', assigneeId: DANA });
    expect(cleared !== null && 'ownerRef' in cleared).toBe(false);
  });

  it('a correction to the resolved owner rewrites owner_ref, and a rebuild reproduces it', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [ev('corrected', { correctsSeq: 3, fields: { ownerId: 'lee' }, reason: 'wrong owner' }, { actor: DANA })]);
    const live = await state.getIncident(INC);
    expect(live).toMatchObject({ ownerRef: 'lee', lastSeq: 7 });

    clock = () => new Date('2031-01-01T00:00:00.000Z');
    await rebuild(state, { all: true });
    expect(await state.getIncident(INC)).toEqual(live);
  });

  it('rolls the projection back with the append on a seq conflict', async () => {
    await state.append(INC, [captured()], 0);
    await expect(state.append(INC, [ev('context-assembled', { bundle: { artifactId: 'a', version: 1 }, includedCount: 0, excludedCount: 0 })], 0)).rejects.toThrow(
      'expected seq 0',
    );
    expect(await state.getIncident(INC)).toMatchObject({ status: 'captured', lastSeq: 1 });
  });
});

// findIncidents -----------------------------------------------------------------------------------

describe(`findIncidents (${TEST_DIALECT})`, () => {
  beforeEach(async () => {
    clock = () => new Date('2026-10-01T10:00:00.000Z');
    await state.append(INC, toFiled(INC, { summary: 'Checkout returns 500 on submit', surfaceId: 'web', jiraKey: 'WEB-1' }), 0);
    clock = () => new Date('2026-10-01T10:01:00.000Z');
    await state.append(INC_B, toFiled(INC_B, { summary: 'Login 100%_broken on SAFARI', surfaceId: 'web', jiraKey: 'WEB-2' }), 0);
    clock = () => new Date('2026-10-01T10:02:00.000Z');
    await state.append(INC_C, toFiled(INC_C, { summary: 'Payout export is slow', surfaceId: 'admin', jiraKey: 'ADM-1' }).slice(0, 4), 0);
  });

  const ids = (views: readonly IncidentView[]): string[] => views.map((v) => v.id);

  it('filters by surface, status, Jira key, and summary text, newest first', async () => {
    expect(ids(await state.findIncidents({}))).toEqual([INC_C, INC_B, INC]);
    expect(ids(await state.findIncidents({ surfaceId: 'web' }))).toEqual([INC_B, INC]);
    expect(ids(await state.findIncidents({ status: 'deduped' }))).toEqual([INC_C]);
    expect(ids(await state.findIncidents({ status: ['filed', 'deduped'], surfaceId: 'admin' }))).toEqual([INC_C]);
    expect(ids(await state.findIncidents({ status: [] }))).toEqual([]);
    expect(ids(await state.findIncidents({ jiraKey: 'WEB-2' }))).toEqual([INC_B]);
    expect(ids(await state.findIncidents({ jiraKey: 'ADM-1' }))).toEqual([]);
    expect(ids(await state.findIncidents({ workspaceId: WS_OTHER }))).toEqual([]);
    expect(ids(await state.findIncidents({ kind: 'incident', workspaceId: WS }))).toEqual([INC_C, INC_B, INC]);
  });

  it('matches text case-insensitively as a literal substring', async () => {
    expect(ids(await state.findIncidents({ text: 'CHECKOUT' }))).toEqual([INC]);
    expect(ids(await state.findIncidents({ text: 'safari' }))).toEqual([INC_B]);
    expect(ids(await state.findIncidents({ text: '100%_b' }))).toEqual([INC_B]);
    expect(ids(await state.findIncidents({ text: '%' }))).toEqual([INC_B]);
    expect(ids(await state.findIncidents({ text: 'o_t' }))).toEqual([]);
    // INC_C has no summary yet (not planned).
    expect(ids(await state.findIncidents({ text: 'payout' }))).toEqual([]);
  });

  it('caps at limit and rejects a limit that is not a positive integer', async () => {
    expect(ids(await state.findIncidents({ limit: 2 }))).toEqual([INC_C, INC_B]);
    await expect(state.findIncidents({ limit: 0 })).rejects.toThrow('limit');
    await expect(state.findIncidents({ limit: 1.5 })).rejects.toThrow('limit');
  });

  it('finds children of a parent', async () => {
    const child = '01JZ00000000000000000000D1';
    await state.append(child, [captured(child, { parentId: INC })], 0);
    expect(ids(await state.findIncidents({ parentId: INC }))).toEqual([child]);
    expect(ids(await state.findIncidents({ kind: 'work-item' }))).toEqual([child]);
  });
});

// claims ------------------------------------------------------------------------------------------

describe(`claims projection (${TEST_DIALECT})`, () => {
  it('claim then release removes the claim', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' }, { actor: DANA, occurredAt: '2026-10-01T10:00:00Z' })]);
    expect(await state.getClaims(INC)).toEqual([
      { incidentId: INC, claimerId: DANA, since: '2026-10-01T10:00:00.000Z', lastActivity: '2026-10-01T10:00:00.000Z', expiresAt: '2026-10-01T14:00:00.000Z' },
    ]);
    expect((await state.getIncident(INC))?.status).toBe('claimed');

    await appendAll(INC, [ev('released', { scope: 'claim', claimerId: DANA, reason: 'requested' }, { actor: DANA })]);
    expect(await state.getClaims(INC)).toEqual([]);
    expect((await state.getIncident(INC))?.status).toBe('fixing');
  });

  it('tracks activity, environment holds, and their release; let-agent-take ends the claim', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [
      ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' }, { actor: DANA, occurredAt: '2026-10-01T10:00:00Z' }),
      ev('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-01T12:30:00Z' }, { actor: DANA, occurredAt: '2026-10-01T10:30:00Z' }),
      ev('held', { kind: 'environment', env: 'staging', claimerId: LEE, expiresAt: '2026-10-01T13:00:00Z' }, { occurredAt: '2026-10-01T10:40:00Z' }),
    ]);
    expect(await state.getClaims(INC)).toEqual([
      {
        incidentId: INC,
        claimerId: DANA,
        since: '2026-10-01T10:00:00.000Z',
        lastActivity: '2026-10-01T10:30:00.000Z',
        expiresAt: '2026-10-01T14:00:00.000Z',
        holdEnv: 'staging',
        holdExpiresAt: '2026-10-01T12:30:00.000Z',
      },
      {
        incidentId: INC,
        claimerId: LEE,
        since: '2026-10-01T10:40:00.000Z',
        lastActivity: '2026-10-01T10:40:00.000Z',
        expiresAt: '2026-10-01T13:00:00.000Z',
        holdEnv: 'staging',
        holdExpiresAt: '2026-10-01T13:00:00.000Z',
      },
    ]);

    await appendAll(INC, [
      ev('released', { scope: 'hold', env: 'staging', reason: 'requested' }, { occurredAt: '2026-10-01T11:00:00Z' }),
      comment('accept', DANA),
    ]);
    const claims = await state.getClaims(INC);
    expect(claims.map((c) => [c.claimerId, c.holdEnv])).toEqual([
      [DANA, undefined],
      [LEE, undefined],
    ]);
    // Dana's comment (at 09:00 + n minutes, earlier than her last activity) does not move it back.
    expect(claims[0]?.lastActivity).toBe('2026-10-01T10:30:00.000Z');
    await appendAll(INC, [ev('jira-transitioned', { jiraKey: 'WEB-1042', from: 'To Do', to: 'In Progress' }, { actor: DANA, occurredAt: '2026-10-01T11:30:00Z' })]);
    expect((await state.getClaims(INC))[0]?.lastActivity).toBe('2026-10-01T11:30:00.000Z');

    await appendAll(INC, [ev('let-agent-take', { claimerId: DANA }, { actor: DANA })]);
    expect((await state.getClaims(INC)).map((c) => c.claimerId)).toEqual([LEE]);
  });

  it('a terminal status clears every claim', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' }, { actor: DANA })]);
    await appendAll(INC, [ev('closed', { reason: 'duplicate' })]);
    expect(await state.getClaims(INC)).toEqual([]);
  });
});

// escalation scores -------------------------------------------------------------------------------

describe(`escalation scores (${TEST_DIALECT})`, () => {
  it('two reactors produce a score with two unique ids', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [comment('trigger', LEE, { weight: 1.5 }), comment('trigger', DANA, { weight: 1 }), comment('trigger', LEE, { weight: 1.5 })]);
    expect(await getEscalationScores(ctx, INC)).toEqual([{ incidentId: INC, intent: 'trigger', uniqueReactors: [DANA, LEE], score: 2.5 }]);
  });

  it('a removed reaction takes the reactor back out; escalated records the highest step', async () => {
    await state.append(INC, toFiled(), 0);
    await appendAll(INC, [comment('escalate', DANA, { weight: 2 }), comment('escalate', LEE, { weight: 1.5 }), comment('accept', LEE)]);
    await appendAll(INC, [
      comment('escalate', DANA, { removed: true, weight: 2 }),
      comment('escalate', 'U-FAKE-NOBODY', { removed: true, weight: 2 }),
      ev('escalated', { intent: 'escalate', step: 2, action: 'page', score: 3.5 }),
      ev('escalated', { intent: 'escalate', step: 1, action: 'mention', score: 3.5 }),
      ev('escalated', { intent: 'trigger', step: 1, action: 'post', score: 0 }),
    ]);
    expect(await getEscalationScores(ctx, INC)).toEqual([
      { incidentId: INC, intent: 'accept', uniqueReactors: [LEE], score: 1 },
      { incidentId: INC, intent: 'escalate', uniqueReactors: [LEE], score: 1.5, ladderStepReached: 2 },
      { incidentId: INC, intent: 'trigger', uniqueReactors: [], score: 0, ladderStepReached: 1 },
    ]);
  });
});

// subscriptions -----------------------------------------------------------------------------------

describe(`subscriptions (${TEST_DIALECT})`, () => {
  it('a watch subscribes the reactor to the incident; removing it unsubscribes; reads cover surface and all scopes', async () => {
    await state.append(INC, toFiled(INC, { surfaceId: 'web' }), 0);
    await appendAll(INC, [comment('watch', DANA), comment('watch', DANA), comment('watch', LEE)]);

    const at = ctx.codec.timestamp('2026-10-01T08:00:00Z');
    await ctx.db
      .insertInto('subscriptions')
      .values([
        { workspace_id: WS, user_id: 'U-FAKE-SURFACE', scope_kind: 'surface', scope_id: 'web', channel: 'dm', created_at: at },
        { workspace_id: WS, user_id: 'U-FAKE-ADMIN', scope_kind: 'surface', scope_id: 'admin', channel: 'dm', created_at: at },
        { workspace_id: WS, user_id: 'U-FAKE-ALL', scope_kind: 'all', scope_id: '', channel: 'dm', created_at: at },
        { workspace_id: WS_OTHER, user_id: 'U-FAKE-ELSEWHERE', scope_kind: 'all', scope_id: '', channel: 'dm', created_at: at },
        { workspace_id: WS, user_id: 'U-FAKE-OTHER-INCIDENT', scope_kind: 'incident', scope_id: INC_B, channel: 'thread', created_at: at },
      ])
      .execute();

    expect(await state.getSubscriptions(INC)).toEqual([
      { workspaceId: WS, userId: 'U-FAKE-ALL', scopeKind: 'all', channel: 'dm', createdAt: '2026-10-01T08:00:00.000Z' },
      // A watch records the incident's chat platform (this one came from Slack).
      { workspaceId: WS, userId: DANA, scopeKind: 'incident', scopeId: INC, channel: 'thread', platform: 'slack', createdAt: '2026-10-01T09:06:00.000Z' },
      { workspaceId: WS, userId: LEE, scopeKind: 'incident', scopeId: INC, channel: 'thread', platform: 'slack', createdAt: '2026-10-01T09:08:00.000Z' },
      { workspaceId: WS, userId: 'U-FAKE-SURFACE', scopeKind: 'surface', scopeId: 'web', channel: 'dm', createdAt: '2026-10-01T08:00:00.000Z' },
    ]);

    await appendAll(INC, [comment('watch', DANA, { removed: true })]);
    expect((await state.getSubscriptions(INC)).map((s) => s.userId)).toEqual(['U-FAKE-ALL', LEE, 'U-FAKE-SURFACE']);
    expect(await state.getSubscriptions(INC_C)).toEqual([]);
  });
});

// Determinism -------------------------------------------------------------------------------------

describe(`determinism (${TEST_DIALECT})`, () => {
  async function snapshot(): Promise<unknown> {
    return {
      incident: await state.getIncident(INC),
      claims: await state.getClaims(INC),
      scores: await getEscalationScores(ctx, INC),
      subscriptions: await state.getSubscriptions(INC),
    };
  }

  it('replaying the log in one batch, with the clock elsewhere, writes the same rows', async () => {
    clock = () => new Date('2026-10-01T10:00:00.000Z');
    await state.append(INC, toFiled(), 0);
    clock = () => new Date('2026-10-01T10:30:00.000Z');
    await appendAll(INC, [
      ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' }, { actor: DANA }),
      ev('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-01T12:30:00Z' }, { actor: DANA }),
      comment('trigger', LEE, { weight: 1.5 }),
      comment('trigger', DANA),
      comment('watch', LEE),
    ]);
    const live = await snapshot();

    clock = () => new Date('2031-01-01T00:00:00.000Z');
    await clearProjections();
    // A replay, as rebuild runs it: the outbox already holds the rows these events implied.
    await state.transaction(async (tx) => applyProjections((tx as StateStore).ctx, await tx.read(INC), { outbox: false }));
    expect(await snapshot()).toEqual(live);
  });

  it('an append enqueues the rows the outbox hook implies, and only once the issue is filed', async () => {
    const [first] = toFiled();
    const captured = { ...first, seq: 1, recordedAt: '2026-10-01T10:00:00.000Z' } as IncidentEvent;
    const opened = foldIncident(undefined, captured).view;
    expect(opened && outboxFor(captured, { before: undefined, after: opened, valid: true })).toEqual([]);
    await state.append(INC, toFiled(), 0);
    const rows = await state.drainOutbox('jira', 10);
    expect(rows).toMatchObject([{ op: 'update-fields', incidentId: INC, payload: { issueKey: 'WEB-1042', customFields: { 'Agent Status': 'filed' } } }]);
  });
});

// Pure reducers -----------------------------------------------------------------------------------

describe('pure reducers', () => {
  const stored = <T extends EventType>(e: NewEvent<T>, seq: number): IncidentEvent => ({ ...e, seq, recordedAt: '2026-10-01T10:00:00.000Z' }) as IncidentEvent;

  it('foldIncident never reads the clock', () => {
    const now = vi.spyOn(Date, 'now');
    let view: IncidentView | undefined;
    toFiled().forEach((e, i) => {
      view = foldIncident(view, stored(e, i + 1)).view;
    });
    expect(view?.status).toBe('filed');
    expect(now).not.toHaveBeenCalled();
  });

  it('folds return the same array when nothing changed', () => {
    const claims: readonly Claim[] = [];
    const scores: readonly ScoreRow[] = [];
    const e = stored(ev('ci-green', { prNumber: 1, headSha: 'fakesha' }), 7);
    expect(foldClaims(claims, e, 'mergeable')).toBe(claims);
    expect(foldScores(scores, e)).toBe(scores);
  });
});
