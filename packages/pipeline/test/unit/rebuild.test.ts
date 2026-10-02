// Rebuild and upcasting (#20; B 4, B 11 row 2): truncate the projections, replay the log through
// `upcast` and `applyProjections`, and compare canonical snapshots. Runs on the dialect
// `SNAPWING_DB` selects; CI runs it once per dialect.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import type { StateContext } from '../../src/state/context.ts';
import { applyProjections } from '../../src/state/projections/index.ts';
import { rebuild, snapshotProjections } from '../../src/state/rebuild.ts';
import { StateStore } from '../../src/state/store.ts';
import { createUpcasters, upcast, upcasters, type StoredEvent } from '../../src/state/upcast.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

// The real projections, behind a spy, so a test can see which events a rebuild replayed.
vi.mock('../../src/state/projections/index.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projections/index.ts')>();
  return { ...actual, applyProjections: vi.fn(actual.applyProjections) };
});

// `outboxFor` behind a switch: off, the real hook; on, one outbox row per event, as the Jira
// projector will fill it (#89). Row ids come from the event, so a second enqueue would collide.
const outboxHook = vi.hoisted(() => ({ rowPerEvent: false }));
vi.mock('../../src/state/projections/outbox.ts', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../src/state/projections/outbox.ts')>();
  return {
    ...actual,
    outboxFor: (e: IncidentEvent, change: Parameters<typeof actual.outboxFor>[1]): OutboxItem[] =>
      outboxHook.rowPerEvent
        ? [
            {
              id: `${e.incidentId}#${String(e.seq).padStart(4, '0')}`,
              workspaceId: e.workspaceId,
              target: 'jira',
              incidentId: e.incidentId,
              op: 'update-fields',
              payload: { eventType: e.type },
              attempts: 0,
              nextAttempt: e.recordedAt,
              createdAt: e.recordedAt,
            },
          ]
        : actual.outboxFor(e, change),
  };
});

const WS = '01JZ0000000000000000000001';
const INC_A = '01JZ00000000000000000000A1';
const INC_B = '01JZ00000000000000000000B1';
const CHILD = '01JZ00000000000000000000B2';
const REPORTER = { id: 'U-FAKE-REPORTER', name: 'Test Reporter', role: 'reporter' } as const;
const DANA = 'U-FAKE-DANA';
const LEE = 'U-FAKE-LEE';

let tdb: TestDatabase;
let state: OpenedState;
let ctx: StateContext;
let tick = 0;

beforeAll(async () => {
  tdb = await createTestDatabase();
  // A clock one second further on at every read, so each append has its own `recorded_at`.
  state = await tdb.open({ now: () => new Date(Date.parse('2026-10-01T10:00:00.000Z') + tick++ * 1000) });
  if (!(state instanceof StateStore)) {
    throw new Error('openState did not return a StateStore');
  }
  ctx = state.ctx;
});

afterAll(async () => {
  await tdb.drop();
});

beforeEach(() => {
  tick = 0;
  minute = 0;
  vi.spyOn(console, 'warn').mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.mocked(applyProjections).mockClear();
  await ctx.db.deleteFrom('claims').execute();
  await ctx.db.deleteFrom('escalation_scores').execute();
  await ctx.db.deleteFrom('subscriptions').execute();
  await ctx.db.deleteFrom('incidents').execute();
  await ctx.db.deleteFrom('incident_events').execute();
  await ctx.db.deleteFrom('outbox').execute();
});

// Event builders ----------------------------------------------------------------------------------

let minute = 0;

function ev<T extends EventType>(type: T, payload: EventPayloads[T], incidentId: string, extra: { actor?: string; v?: number } = {}): NewEvent<T> {
  return {
    workspaceId: WS,
    incidentId,
    type,
    v: extra.v ?? 1,
    source: extra.actor === undefined ? 'agent' : 'slack',
    ...(extra.actor !== undefined ? { actor: { id: extra.actor, role: 'engineer' } } : {}),
    occurredAt: new Date(Date.parse('2026-10-01T09:00:00.000Z') + minute++ * 60_000).toISOString(),
    payload,
  } as unknown as NewEvent<T>;
}

function captured(incidentId: string, parentId?: string): NewEvent<'captured'> {
  return ev(
    'captured',
    {
      kind: parentId === undefined ? 'incident' : 'work-item',
      ...(parentId !== undefined ? { parentId } : {}),
      idempotencyKey: `slack:T-FAKE:C-FAKE:${incidentId}`,
      source: 'slack',
      reporter: REPORTER,
      anchorText: 'Checkout says 500',
      anchorId: '1727773199.000100',
      channelId: 'C-FAKE',
    },
    incidentId,
  );
}

function toFiled(incidentId: string, jiraKey: string): NewEvent[] {
  return [
    captured(incidentId),
    ev('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 4, excludedCount: 1 }, incidentId),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }, incidentId),
    ev('dedupe-checked', { candidates: [], decision: 'none' }, incidentId),
    ev(
      'planned',
      { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: `Bug ${jiraKey}`, priority: 'High', labels: ['snapwing'], autonomyLevel: 2 },
      incidentId,
    ),
    ev('filed', { jiraKey }, incidentId),
  ];
}

function comment(incidentId: string, intent: 'escalate' | 'watch', actor: string, weight = 1): NewEvent<'comment'> {
  return ev(
    'comment',
    {
      intent,
      platform: 'slack',
      signalSource: 'reaction',
      target: { role: 'anchor', messageId: '1727773199.000100' },
      confidence: 1,
      raw: intent === 'watch' ? 'bell' : 'fire',
      ...(intent !== 'watch' ? { count: { weight, windowEndsAt: '2026-10-01T11:00:00Z' } } : {}),
    },
    incidentId,
    { actor },
  );
}

async function appendAll(incidentId: string, events: NewEvent[]): Promise<void> {
  const last = (await state.read(incidentId)).at(-1)?.seq ?? 0;
  await state.append(incidentId, events, last);
}

/**
 * Three incidents in interleaved appends: A is filed, claimed, held, watched, and escalated, with a
 * correction; B is filed and has a child work item C. Plus one standing surface subscription, which
 * no event writes and a rebuild must keep.
 */
async function appendFixture(): Promise<void> {
  await state.append(INC_A, toFiled(INC_A, 'WEB-1042'), 0);
  await state.append(INC_B, toFiled(INC_B, 'WEB-2001'), 0);
  await appendAll(INC_A, [
    ev('claimed', { claimerId: DANA, expiresAt: '2026-10-01T14:00:00Z' }, INC_A, { actor: DANA }),
    ev('held', { kind: 'environment', env: 'staging', expiresAt: '2026-10-01T12:30:00Z' }, INC_A, { actor: DANA }),
  ]);
  await state.append(CHILD, [captured(CHILD, INC_B)], 0);
  await appendAll(INC_A, [comment(INC_A, 'watch', LEE), comment(INC_A, 'escalate', DANA, 2), comment(INC_A, 'escalate', LEE, 1.5)]);
  await appendAll(INC_B, [ev('jira-priority-changed', { jiraKey: 'WEB-2001', from: 'High', to: 'Highest' }, INC_B)]);
  await appendAll(INC_A, [
    ev('escalated', { intent: 'escalate', step: 2, action: 'page', score: 3.5 }, INC_A),
    ev('corrected', { correctsSeq: 3, fields: { componentId: 'payments' }, reason: 'wrong component' }, INC_A, { actor: DANA }),
  ]);
  await ctx.db
    .insertInto('subscriptions')
    .values({ workspace_id: WS, user_id: DANA, scope_kind: 'surface', scope_id: 'web', channel: 'dm', created_at: ctx.codec.timestamp('2026-10-01T08:00:00Z') })
    .execute();
}

async function storedEvents(): Promise<unknown[]> {
  const rows = await ctx.db.selectFrom('incident_events').selectAll().orderBy('incident_id').orderBy('seq').execute();
  return rows.map((r) => ({ ...r, payload: ctx.codec.fromJson(r.payload), occurred_at: ctx.codec.fromTimestamp(r.occurred_at), recorded_at: ctx.codec.fromTimestamp(r.recorded_at) }));
}

// rebuild -----------------------------------------------------------------------------------------

describe(`rebuild (${TEST_DIALECT})`, () => {
  it('B 11 row 2: rebuilding all from a 3-incident log reproduces every projection row', async () => {
    await appendFixture();
    const before = await snapshotProjections(state);
    const parsed = JSON.parse(before) as Record<string, unknown[]>;
    expect(Object.keys(parsed)).toEqual(['claims', 'escalation_scores', 'incidents', 'subscriptions']);
    expect(parsed.incidents).toHaveLength(3);
    expect(parsed.claims).toHaveLength(1);
    expect(parsed.subscriptions).toHaveLength(2);
    expect(parsed.escalation_scores).toHaveLength(1);

    const result = await rebuild(state, { all: true });
    expect(result).toEqual({ incidents: 3, events: 21 });
    const after = await snapshotProjections(state);
    expect(JSON.parse(after)).toEqual(parsed);
    expect(after).toBe(before);
  });

  it('replays in batches: one event per call gives the same rows, and a parent before its child', async () => {
    await appendFixture();
    const before = await snapshotProjections(state);
    vi.mocked(applyProjections).mockClear();

    await rebuild(state, { all: true }, { batchSize: 1 });
    expect(await snapshotProjections(state)).toBe(before);
    const calls = vi.mocked(applyProjections).mock.calls.map(([, events]) => events);
    expect(calls).toHaveLength(21);
    expect(calls.every((events) => events.length === 1)).toBe(true);
    const order = calls.map((events) => `${events[0]?.incidentId}#${events[0]?.seq}`);
    expect(order.indexOf(`${INC_B}#1`)).toBeLessThan(order.indexOf(`${CHILD}#1`));
    // Each incident's log replays in seq order.
    for (const id of [INC_A, INC_B, CHILD]) {
      const seqs = calls.flatMap((events) => events.filter((e) => e.incidentId === id).map((e) => e.seq));
      expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    }
  });

  it('truncates drifted rows and rebuilds them from the log', async () => {
    await appendFixture();
    const before = await snapshotProjections(state);
    await ctx.db.updateTable('incidents').set({ status: 'closed', summary: 'drifted' }).where('id', '=', INC_A).execute();
    await ctx.db.deleteFrom('claims').execute();
    await ctx.db.updateTable('escalation_scores').set({ score: 99 }).execute();
    expect(await snapshotProjections(state)).not.toBe(before);

    await rebuild(state, { all: true });
    expect(await snapshotProjections(state)).toBe(before);
  });

  it('rebuilds one incident and leaves the others alone, children included', async () => {
    await appendFixture();
    const before = await snapshotProjections(state);
    await ctx.db.updateTable('incidents').set({ priority: 'Low' }).where('id', 'in', [INC_A, INC_B]).execute();

    expect(await rebuild(state, { incidentId: INC_B })).toEqual({ incidents: 1, events: 7 });
    expect(await state.getIncident(INC_B)).toMatchObject({ priority: 'Highest' });
    expect(await state.getIncident(CHILD)).toMatchObject({ parentId: INC_B, kind: 'work-item' });
    expect(await state.getIncident(INC_A)).toMatchObject({ priority: 'Low' });

    await rebuild(state, { incidentId: INC_A });
    expect(await snapshotProjections(state)).toBe(before);
  });

  it('an incident with no events rebuilds to nothing', async () => {
    expect(await rebuild(state, { incidentId: '01JZ00000000000000000000Z9' })).toEqual({ incidents: 0, events: 0 });
    expect(await rebuild(state, { all: true })).toEqual({ incidents: 0, events: 0 });
    expect(JSON.parse(await snapshotProjections(state))).toEqual({ incidents: [], claims: [], subscriptions: [], escalation_scores: [] });
  });

  it('replays corrected events and never edits the stored log', async () => {
    await appendFixture();
    const log = await storedEvents();
    vi.mocked(applyProjections).mockClear();

    await rebuild(state, { all: true });
    const replayed = vi.mocked(applyProjections).mock.calls.flatMap(([, events]) => events);
    const corrected = replayed.filter((e) => e.type === 'corrected');
    expect(corrected).toHaveLength(1);
    expect(corrected[0]).toMatchObject({ incidentId: INC_A, payload: { correctsSeq: 3 } });
    expect(await storedEvents()).toEqual(log);
  });

  it('rejects a target that is neither one incident nor all, and a bad batch size', async () => {
    await expect(rebuild(state, {} as never)).rejects.toThrow(TypeError);
    await expect(rebuild(state, { incidentId: '' })).rejects.toThrow(TypeError);
    await expect(rebuild(state, { all: true }, { batchSize: 0 })).rejects.toThrow(TypeError);
  });

  it('an append that arrives during a rebuild waits for it, then folds onto the rebuilt rows', async () => {
    await appendFixture();
    const mocked = vi.mocked(applyProjections);
    const actual = mocked.getMockImplementation();
    if (actual === undefined) {
      throw new Error('applyProjections spy has no implementation');
    }
    let entered = (): void => {};
    const inRebuild = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let release = (): void => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocked.mockImplementationOnce(async (tx, events, options) => {
      entered();
      await gate;
      return actual(tx, events, options);
    });

    const rebuilding = rebuild(state, { all: true });
    await inRebuild;
    const appending = appendAll(INC_B, [ev('jira-assignee-changed', { jiraKey: 'WEB-2001', to: LEE }, INC_B)]);
    // Give the append time to reach the log (Postgres: it waits on the rebuild's table lock).
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    await Promise.all([rebuilding, appending]);

    expect(await state.getIncident(INC_B)).toMatchObject({ assigneeId: LEE, lastSeq: 8 });
    const live = await snapshotProjections(state);
    await rebuild(state, { all: true });
    expect(await snapshotProjections(state)).toBe(live);
  });

  it('accepts a StateContext as well as the store', async () => {
    await appendFixture();
    const before = await snapshotProjections(ctx);
    await rebuild(ctx, { all: true });
    expect(await snapshotProjections(state)).toBe(before);
  });
});

// rebuild and the outbox --------------------------------------------------------------------------

describe(`rebuild and the outbox (${TEST_DIALECT})`, () => {
  beforeEach(() => {
    outboxHook.rowPerEvent = true;
  });

  afterEach(() => {
    outboxHook.rowPerEvent = false;
  });

  async function outboxRows(): Promise<unknown[]> {
    return ctx.db.selectFrom('outbox').selectAll().orderBy('id').execute();
  }

  it('#89: with outboxFor giving a row per event, a rebuild leaves the outbox table unchanged', async () => {
    await appendFixture();
    // Appends enqueue in their transaction: one row per event.
    expect(await outboxRows()).toHaveLength(21);
    // One row delivered and acked, one delivered and pruned, as the projector will leave them.
    await state.ackOutbox([`${INC_A}#0001`]);
    await ctx.db.deleteFrom('outbox').where('id', '=', `${INC_B}#0001`).execute();
    const before = await outboxRows();
    expect(before).toHaveLength(20);
    const projections = await snapshotProjections(state);
    vi.mocked(applyProjections).mockClear();

    expect(await rebuild(state, { all: true })).toEqual({ incidents: 3, events: 21 });
    expect(await outboxRows()).toEqual(before);
    expect(await rebuild(state, { incidentId: INC_B })).toEqual({ incidents: 1, events: 7 });
    expect(await outboxRows()).toEqual(before);
    expect(await snapshotProjections(state)).toBe(projections);

    const calls = vi.mocked(applyProjections).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    expect(calls.every(([, , options]) => options?.outbox === false)).toBe(true);
  });

  it('an append after a rebuild still enqueues its own rows', async () => {
    await appendFixture();
    await rebuild(state, { all: true });
    await appendAll(INC_B, [ev('jira-assignee-changed', { jiraKey: 'WEB-2001', to: LEE }, INC_B)]);
    const rows = (await outboxRows()) as { id: string }[];
    expect(rows).toHaveLength(22);
    expect(rows.map((r) => r.id)).toContain(`${INC_B}#0008`);
  });
});

// upcast ------------------------------------------------------------------------------------------

describe(`upcast (${TEST_DIALECT})`, () => {
  it('rebuild applies a registered v1 to v2 upcaster, and the stored v1 event is untouched', async () => {
    await state.append(INC_A, toFiled(INC_A, 'WEB-1042').slice(0, 5), 0);
    // A v1 `filed` event from before the payload field was renamed to `jiraKey`.
    const v1 = { ...ev('filed', { jiraKey: 'unused' }, INC_A), payload: { key: 'WEB-7' } } as unknown as NewEvent;
    await appendAll(INC_A, [v1]);
    expect((await state.getIncident(INC_A))?.jiraKey).toBeUndefined();

    const unregister = upcasters.register('filed', 1, (payload) => ({ jiraKey: (payload as { key: string }).key }));
    try {
      await rebuild(state, { all: true });
    } finally {
      unregister();
    }
    expect(await state.getIncident(INC_A)).toMatchObject({ jiraKey: 'WEB-7', status: 'filed' });
    const stored = (await state.read(INC_A)).at(-1);
    expect(stored).toMatchObject({ type: 'filed', v: 1, payload: { key: 'WEB-7' } });
  });

  it('chains steps, returns a new event, and leaves the input as it was', () => {
    const registry = createUpcasters();
    registry.register('filed', 1, (p) => ({ key: (p as { k: string }).k }));
    registry.register('filed', 2, (p) => ({ jiraKey: (p as { key: string }).key }));
    const stored: StoredEvent = {
      workspaceId: WS,
      incidentId: INC_A,
      seq: 6,
      type: 'filed',
      v: 1,
      source: 'agent',
      occurredAt: '2026-10-01T09:00:00.000Z',
      recordedAt: '2026-10-01T10:00:00.000Z',
      payload: { k: 'WEB-9' },
    };
    const out = upcast(stored, registry);
    expect(out).toEqual({ ...stored, v: 3, payload: { jiraKey: 'WEB-9' } });
    expect(stored).toMatchObject({ v: 1, payload: { k: 'WEB-9' } });

    const current = { ...stored, v: 3, payload: { jiraKey: 'WEB-9' } } as IncidentEvent;
    expect(upcast(current, registry)).toBe(current);
    expect(upcast(stored, createUpcasters())).toBe(stored);
  });

  it('rejects a second step for the same version and a bad fromV; unregister removes the step', () => {
    const registry = createUpcasters();
    const step = (p: unknown): unknown => p;
    const unregister = registry.register('closed', 1, step);
    expect(() => registry.register('closed', 1, step)).toThrow(/already registered/);
    expect(() => registry.register('closed', 0, step)).toThrow(RangeError);
    unregister();
    expect(registry.get('closed', 1)).toBeUndefined();
    registry.register('closed', 1, step);
    expect(registry.get('closed', 1)).toBe(step);
  });
});
