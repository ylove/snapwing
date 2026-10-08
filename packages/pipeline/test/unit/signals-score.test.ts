// Escalation by weight of reactions (A 1.4, A 8): the ladder math (pure), and the reaction
// ladder over the signal handler on a real store (SNAPWING_DB picks the dialect): `escalated` steps,
// the priority on the incidents row and as a Jira field row through the outbox, the thread post, the
// outage (monitoring and the playbook ladders), reactions counted when the incident is created, and
// a priority that never comes back down. The ask-back gate's side is at the end.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { evaluateBudget, GATE_CODES, maybeAsk } from '../../src/clarify/index.ts';
import { defaultPlaybook, type Playbook } from '../../src/config/playbook.ts';
import type { EscalatedPayload, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload, ContextBundle, IncidentActor, Resolution } from '../../src/contracts/incident.ts';
import type { Intent } from '../../src/contracts/signals.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import type { EscalationPost } from '../../src/monitor/ladder.ts';
import type { ModelPort } from '../../src/ports/model.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import { adoptPendingSignals, handleSignal, type SignalDeps, type SignalInput } from '../../src/signals/handler.ts';
import {
  atLeastPriority,
  countedReactors,
  createReactionEscalation,
  escalationState,
  escalationText,
  ladderScore,
  planEscalation,
  raisedPriority,
  reactionLadders,
  REACTION_LADDER,
  stepForScore,
} from '../../src/signals/score.ts';
import { getEscalationScores } from '../../src/state/projections/index.ts';
import { jiraFieldBatchKey } from '../../src/state/projections/outbox/jira.ts';
import { StateStore } from '../../src/state/store.ts';
import { createTestDatabase, TEST_DIALECT, type TestDatabase } from '../helpers/db.ts';

const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6SCOREINC0000000000000A';
const CHANNEL = 'C0FAKEBUGS';
const ANCHOR = '1730000000.000100';
const T0 = Date.parse('2026-10-02T10:00:00.000Z');
const MINUTE = 60_000;

const reporter = (n: number): IncidentActor => ({ id: `U0FAKEREP${String(n)}`, name: `Reporter ${String(n)}`, role: 'reporter' });
const engineer = (n: number): IncidentActor => ({ id: `U0FAKEENG${String(n)}`, name: `Engineer ${String(n)}`, role: 'engineer' });
const OWNER: IncidentActor = { id: 'U0FAKEOWNER', name: 'Olu', role: 'engineer' };

const MAP: WorkspaceMap = {
  people: [{ slackId: OWNER.id, handle: 'olu', role: 'engineer', owns: [{ surface: 'web', primary: true }] }],
} as unknown as WorkspaceMap;

// The math (pure) ---------------------------------------------------------------------------------

let seq = 0;

/** A recorded counted (or removed) signal, as the handler writes it. */
function counted(intent: Intent, actor: IncidentActor, weight: number, source: 'reaction' | 'reaction-removed' = 'reaction'): IncidentEvent<'comment'> {
  seq++;
  return {
    workspaceId: WS,
    incidentId: INC,
    seq,
    v: 1,
    type: 'comment',
    source: 'slack',
    actor: { id: actor.id, role: actor.role },
    occurredAt: new Date(T0 + seq * 1000).toISOString(),
    recordedAt: new Date(T0 + seq * 1000).toISOString(),
    payload: {
      intent,
      platform: 'slack',
      signalSource: source,
      confidence: 1,
      raw: intent,
      target: { role: 'anchor', messageId: ANCHOR },
      count: { weight, windowEndsAt: new Date(T0 + 120 * MINUTE).toISOString() },
      effect: source === 'reaction' ? 'count' : 'removed',
    },
  };
}

function escalatedEvent(payload: EscalatedPayload): IncidentEvent<'escalated'> {
  seq++;
  const at = new Date(T0 + seq * 1000).toISOString();
  return { workspaceId: WS, incidentId: INC, seq, v: 1, type: 'escalated', source: 'agent', occurredAt: at, recordedAt: at, payload };
}

const LADDER = ['trigger', 'escalate'];

describe('the ladder math (A 1.4)', () => {
  it('5 reporters + 1 owner reacting = 7: step 2, not step 3 (A 8)', () => {
    const events = [1, 2, 3, 4, 5].map((n) => counted('trigger', reporter(n), 1)).concat(counted('trigger', OWNER, 2));
    expect(ladderScore(events, LADDER)).toEqual({ score: 7, reactors: 6 });
    const [ladder] = reactionLadders(defaultPlaybook());
    expect(ladder?.intents).toEqual(['trigger', 'escalate']);
    expect(stepForScore(ladder?.steps ?? [], 7)).toBe(2);
    expect(planEscalation(events, {}, defaultPlaybook()).map((p) => p.step)).toEqual([1, 2]);
  });

  it('one person reacting five times counts once; a removal takes them out; two intents count a person once at the larger weight', () => {
    const pat = reporter(1);
    const fives = [1, 2, 3, 4, 5].map(() => counted('escalate', pat, 1));
    expect(ladderScore(fives, LADDER)).toEqual({ score: 1, reactors: 1 });

    const sam = reporter(2);
    const events = [counted('trigger', pat, 1), counted('escalate', pat, 1), counted('escalate', sam, 1), counted('trigger', OWNER, 2), counted('escalate', OWNER, 2)];
    expect(ladderScore(events, LADDER)).toEqual({ score: 4, reactors: 3 });
    expect(ladderScore([...events, counted('escalate', sam, 1, 'reaction-removed')], LADDER)).toEqual({ score: 3, reactors: 2 });
    // Removing one of two reactions keeps the person counted by the other.
    expect(ladderScore([...events, counted('escalate', pat, 1, 'reaction-removed')], LADDER)).toEqual({ score: 4, reactors: 3 });
    // The per-intent view (one intent only) matches the escalation_scores row.
    expect([...countedReactors(events, ['escalate']).entries()].sort()).toEqual([
      [OWNER.id, 2],
      [pat.id, 1],
      [sam.id, 1],
    ]);
    // Accept and reject are not on the reaction ladder.
    expect(ladderScore([counted('accept', pat, 1), counted('accept', sam, 1), counted('accept', OWNER, 2)], LADDER).score).toBe(0);
  });

  it('steps fire once each, in order, with their effects frozen; a later lower score fires nothing', () => {
    const three = [1, 2, 3].map((n) => counted('escalate', reporter(n), 1));
    const first = planEscalation(three, { priority: 'Medium' }, defaultPlaybook());
    expect(first).toEqual([{ intent: 'escalate', step: 1, action: 'post', score: 3, reactors: 3, priority: 'High', note: true }]);

    const reached = [...three, escalatedEvent(first[0] as EscalatedPayload)];
    expect(planEscalation(reached, { priority: 'High' }, defaultPlaybook())).toEqual([]);
    const five = [...reached, counted('escalate', reporter(4), 1), counted('escalate', reporter(5), 1)];
    expect(planEscalation(five, { priority: 'High' }, defaultPlaybook())).toEqual([
      { intent: 'escalate', step: 2, action: 'mention', score: 5, reactors: 5, priority: 'Highest', mentionOwner: true, suppressAskBack: true },
    ]);

    // Everyone takes their reaction back after step 2: nothing fires, nothing comes down.
    const stepped = [...five, escalatedEvent({ intent: 'escalate', step: 2, action: 'mention', score: 5, priority: 'Highest', suppressAskBack: true })];
    const removed = [...stepped, ...[1, 2, 3, 4, 5].map((n) => counted('escalate', reporter(n), 1, 'reaction-removed'))];
    expect(ladderScore(removed, LADDER).score).toBe(0);
    expect(planEscalation(removed, { priority: 'Highest' }, defaultPlaybook())).toEqual([]);
    expect(escalationState(removed)).toEqual({ step: 2, priority: 'Highest', suppressAskBack: true, outage: false });

    // 8 reaches the outage step; the priority is already Highest, so step 3 records none.
    const eight = [...stepped, counted('escalate', OWNER, 2), counted('escalate', engineer(1), 1.5)];
    expect(planEscalation(eight, { priority: 'Highest' }, defaultPlaybook())).toEqual([
      { intent: 'escalate', step: 3, action: 'post', score: 8.5, reactors: 7, outage: true },
    ]);
  });

  it('priority only moves up: +N from the current one (Medium when unset), Highest only when higher, unknown priorities left alone', () => {
    expect(raisedPriority(undefined, { raise: 1 })).toBe('High');
    expect(raisedPriority('Low', { raise: 1 })).toBe('Medium');
    expect(raisedPriority('high', { raise: 3 })).toBe('Highest');
    expect(raisedPriority('Highest', { raise: 1 })).toBeUndefined();
    expect(raisedPriority('Highest', { set: 'High' })).toBeUndefined();
    expect(raisedPriority('Highest', { set: 'Highest' })).toBeUndefined();
    expect(raisedPriority('Low', { set: 'Highest' })).toBe('Highest');
    expect(raisedPriority('P1 - Critical', { set: 'Highest' })).toBeUndefined();
    expect(atLeastPriority('Medium', 'Highest')).toBe('Highest');
    expect(atLeastPriority('Highest', 'High')).toBe('Highest');
    expect(atLeastPriority('Low', undefined)).toBe('Low');
    // A human lowered it to Low after step 1: step 2 still sets Highest; step 1 never fires again.
    expect(planEscalation([1, 2, 3, 4, 5].map((n) => counted('escalate', reporter(n), 1)), { priority: 'Low' }, defaultPlaybook()).map((p) => p.priority)).toEqual([
      'Medium',
      'Highest',
    ]);
  });

  it('the playbook can override the ladder, per intent', () => {
    const playbook: Playbook = defaultPlaybook();
    playbook.ladders = [
      { intents: ['escalate'], steps: [{ score: 2, priority: { set: 'Highest' }, note: false, mentionOwner: true, suppressAskBack: true, outage: true }] },
      { intents: ['trigger'], steps: [{ score: 10, note: true, mentionOwner: false, suppressAskBack: false, outage: false }] },
      { intents: ['accept'], steps: [{ score: 1, note: true, mentionOwner: false, suppressAskBack: false, outage: false }] },
    ];
    expect(reactionLadders(playbook).map((l) => l.intents)).toEqual([['escalate'], ['trigger']]);
    const events = [counted('escalate', engineer(1), 1.5), counted('escalate', reporter(1), 1), counted('trigger', reporter(2), 1)];
    expect(planEscalation(events, { priority: 'Low' }, playbook)).toEqual([
      { intent: 'escalate', step: 1, action: 'mention', score: 2.5, reactors: 2, priority: 'Highest', mentionOwner: true, suppressAskBack: true, outage: true },
    ]);
  });

  it('the thread post says how many people, the new priority, and the outage', () => {
    expect(escalationText([{ intent: 'trigger', step: 1, action: 'post', score: 3, reactors: 3, priority: 'High', note: true }])).toBe(
      '3 people are reporting this. Priority raised to High.',
    );
    expect(
      escalationText([
        { intent: 'trigger', step: 1, action: 'post', score: 8, reactors: 6, priority: 'High', note: true },
        { intent: 'trigger', step: 2, action: 'mention', score: 8, reactors: 6, priority: 'Highest', mentionOwner: true },
        { intent: 'trigger', step: 3, action: 'post', score: 8, reactors: 6, outage: true },
      ]),
    ).toBe('6 people are reporting this. Priority raised to Highest. Treating it as an outage.');
  });
});

// The reaction ladder on a store ------------------------------------------------------------------

let tdb: TestDatabase;
let state: OpenedState;
let now: number;

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
});

afterEach(async () => {
  await tdb.drop();
});

interface World {
  deps: SignalDeps;
  posts: EscalationPost[];
  ladderRuns: string[];
}

function world(playbook: Playbook = defaultPlaybook(), map?: WorkspaceMap): World {
  const posts: EscalationPost[] = [];
  const ladderRuns: string[] = [];
  const escalation = createReactionEscalation({
    workspaceId: WS,
    state,
    playbook: () => playbook,
    clock: () => new Date(now),
    ...(map === undefined ? {} : { map: () => map }),
    chat: {
      post: (m) => {
        posts.push(m);
        return Promise.resolve();
      },
    },
    ladders: {
      evaluate: (id) => {
        ladderRuns.push(id);
        return Promise.resolve([]);
      },
    },
  });
  const deps: SignalDeps = {
    workspaceId: WS,
    state,
    cache: createKvCache(state as unknown as StateStore),
    playbook,
    map: MAP,
    engine: { handleClaim: () => Promise.resolve(undefined), handleTap: () => Promise.resolve({ accepted: false, reason: 'no-card' }) } as unknown as SignalDeps['engine'],
    stopIncident: () => Promise.resolve({ stopped: false }) as unknown as ReturnType<SignalDeps['stopIncident']>,
    startFixer: () => Promise.resolve(undefined),
    escalation,
    clock: () => new Date(now),
  };
  return { deps, posts, ladderRuns };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T], at = now): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(at).toISOString(), payload } as unknown as NewEvent<T>;
}

const CAPTURED = (): NewEvent =>
  ev(
    'captured',
    {
      kind: 'incident',
      idempotencyKey: `slack-${CHANNEL}-${ANCHOR}`,
      source: 'slack',
      reporter: reporter(0),
      anchorText: 'Checkout total is blank',
      anchorId: ANCHOR,
      channelId: CHANNEL,
    },
    T0 - MINUTE,
  );

const RESOLVED = (): NewEvent[] => [
  ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
  ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'github.com/fake-org/web', ownerId: 'olu', resolvedBy: 'channel-explicit', confidence: 0.9 }),
];

const PLANNED = (): NewEvent[] => [
  ev('dedupe-checked', { candidates: [], decision: 'none' }),
  ev('planned', { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: 'Checkout total is blank', priority: 'Medium', labels: ['snapwing'], autonomyLevel: 2 }),
];

async function append(...events: NewEvent[]): Promise<void> {
  await state.append(INC, events, (await state.read(INC)).at(-1)?.seq ?? 0);
}

async function filed(): Promise<void> {
  await append(CAPTURED(), ...RESOLVED(), ...PLANNED(), ev('filed', { jiraKey: 'WEB-1042' }));
  await drained();
}

async function drained(): Promise<void> {
  const rows = await state.drainOutbox('jira', 500);
  if (rows.length > 0) await state.ackOutbox(rows.map((r) => r.id));
}

async function priorityRows(): Promise<OutboxItem[]> {
  return (await state.drainOutbox('jira', 500)).filter((r) => r.batchKey === jiraFieldBatchKey(INC, 'priority'));
}

async function escalated(): Promise<EscalatedPayload[]> {
  return (await state.read(INC)).filter((e): e is IncidentEvent<'escalated'> => e.type === 'escalated').map((e) => e.payload);
}

function react(intent: Intent, actor: IncidentActor, extra: Partial<SignalInput> = {}): SignalInput {
  return {
    intent,
    confidence: 1,
    source: 'reaction',
    platform: 'slack',
    actor,
    target: { channel: CHANNEL, messageId: ANCHOR },
    raw: intent === 'escalate' ? 'fire' : 'bug',
    timestamp: new Date(now).toISOString(),
    ...extra,
  };
}

describe(`the reaction ladder (${TEST_DIALECT})`, () => {
  it('3 people: +1 priority with a status note, as a Jira priority row through the outbox; the status stays', async () => {
    await filed();
    const w = world();
    for (const n of [1, 2]) await handleSignal(w.deps, react('trigger', reporter(n)));
    expect(await escalated()).toEqual([]);
    await handleSignal(w.deps, react('escalate', reporter(3)));

    expect(await escalated()).toEqual([{ intent: 'escalate', step: 1, action: 'post', score: 3, reactors: 3, priority: 'High', note: true }]);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'filed', priority: 'High' });
    const rows = await priorityRows();
    expect(rows.map((r) => [r.op, r.payload])).toEqual([['update-fields', { issueKey: 'WEB-1042', fields: { priority: { name: 'High' } } }]]);
    expect(w.posts).toEqual([
      { incidentId: INC, ladder: REACTION_LADDER, step: 1, where: { kind: 'thread', channel: CHANNEL, threadId: ANCHOR }, text: '3 people are reporting this. Priority raised to High.' },
    ]);
    const scores = await getEscalationScores((state as unknown as StateStore).ctx, INC);
    expect(scores.find((s) => s.intent === 'escalate')).toMatchObject({ ladderStepReached: 1 });
  });

  it('5 reporters + the owner = 7: Highest, the owner mentioned, the ask-back suppressed; not the outage (A 8)', async () => {
    await filed();
    const w = world();
    for (const n of [1, 2, 3, 4, 5]) await handleSignal(w.deps, react('trigger', reporter(n)));
    // One person reacting five times counts once.
    for (let i = 0; i < 5; i++) await handleSignal(w.deps, react('trigger', reporter(5)));
    await handleSignal(w.deps, react('trigger', OWNER));

    const steps = await escalated();
    expect(steps.map((p) => [p.step, p.score, p.priority])).toEqual([
      [1, 3, 'High'],
      [2, 5, 'Highest'],
    ]);
    expect(steps.some((p) => p.outage === true)).toBe(false);
    expect(escalationState(await state.read(INC))).toEqual({ step: 2, priority: 'Highest', suppressAskBack: true, outage: false });
    expect(await state.getIncident(INC)).toMatchObject({ status: 'filed', priority: 'Highest', monitored: false });
    expect((await priorityRows()).map((r) => (r.payload['fields'] as { priority: { name: string } }).priority.name)).toEqual(['High', 'Highest']);
    expect(w.posts.at(-1)).toMatchObject({ step: 2, mention: 'olu', text: '5 people are reporting this. Priority raised to Highest.' });
    expect(w.ladderRuns).toEqual([INC, INC]);
    // The owner's reaction arrived after step 2: 7 is still step 2.
    expect(ladderScore(await state.read(INC), LADDER).score).toBe(7);
  });

  it('8 is an outage: monitoring starts in the same append and the playbook ladders see the outage', async () => {
    await filed();
    const w = world();
    for (const actor of [OWNER, engineer(1), engineer(2), reporter(1), reporter(2), reporter(3)]) await handleSignal(w.deps, react('escalate', actor));
    const steps = await escalated();
    expect(steps.map((p) => p.step)).toEqual([1, 2, 3]);
    expect(steps.at(-1)).toMatchObject({ step: 3, outage: true, score: 8, reactors: 6 });
    const log = await state.read(INC);
    const outageAt = log.findIndex((e) => e.type === 'escalated' && e.payload.outage === true);
    expect(log[outageAt + 1]).toMatchObject({ type: 'monitoring-started', payload: { qualifiedBy: 'outage-score' } });
    expect(await state.getIncident(INC)).toMatchObject({ status: 'filed', priority: 'Highest', monitored: true });
    // Evaluating again fires nothing; the outage fact the playbook ladders read (`LadderDeps.outage`) holds.
    expect(await world().deps.escalation?.evaluate(INC)).toEqual({ fired: [], posted: false });
    expect(await createReactionEscalation({ workspaceId: WS, state, playbook: defaultPlaybook(), clock: () => new Date(now) }).outage({ id: INC })).toBe(true);
    expect(w.ladderRuns.at(-1)).toBe(INC);
  });

  it('a later lower score never lowers the priority, and a human edit is not overruled by a step already reached', async () => {
    await filed();
    const w = world();
    for (const n of [1, 2, 3, 4, 5]) await handleSignal(w.deps, react('escalate', reporter(n)));
    expect((await state.getIncident(INC))?.priority).toBe('Highest');
    await drained();
    for (const n of [1, 2, 3, 4, 5]) await handleSignal(w.deps, react('escalate', reporter(n), { source: 'reaction-removed' }));
    expect(ladderScore(await state.read(INC), LADDER).score).toBe(0);
    expect((await state.getIncident(INC))?.priority).toBe('Highest');
    expect(await priorityRows()).toEqual([]);

    // A human lowers it in Jira; reactions coming back reach no new step, so nothing raises it again.
    await append(ev('jira-priority-changed', { jiraKey: 'WEB-1042', from: 'Highest', to: 'Low' }));
    for (const n of [1, 2, 3, 4, 5]) await handleSignal(w.deps, react('escalate', reporter(n)));
    expect((await escalated()).map((p) => p.step)).toEqual([1, 2]);
    expect((await state.getIncident(INC))?.priority).toBe('Low');
    expect(await priorityRows()).toEqual([]);
  });

  it('reactions before the incident existed are counted at creation: one append, straight to Highest, no Jira row before filing', async () => {
    const w = world();
    for (const n of [1, 2, 3, 4, 5]) {
      expect(await handleSignal(w.deps, react('escalate', reporter(n)))).toMatchObject({ handled: false, reason: 'pending' });
      now += 1000;
    }
    await append(CAPTURED(), ...RESOLVED());
    expect(await adoptPendingSignals(w.deps, INC)).toBe(5);

    const log = await state.read(INC);
    const firstStep = log.findIndex((e) => e.type === 'escalated');
    expect(log.slice(firstStep).map((e) => e.type)).toEqual(['escalated', 'escalated']);
    expect(await escalated()).toMatchObject([
      { step: 1, priority: 'High' },
      { step: 2, priority: 'Highest', suppressAskBack: true },
    ]);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'resolved', priority: 'Highest' });
    expect(await priorityRows()).toEqual([]);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]).toMatchObject({ step: 2, mention: 'olu', text: '5 people are reporting this. Priority raised to Highest.' });

    // The status went on as it was: the plan step files at Highest (engine.test.ts covers the floor).
    await append(...PLANNED(), ev('filed', { jiraKey: 'WEB-1042' }));
    expect((await state.getIncident(INC))?.status).toBe('filed');
  });

  // the live escalation row: the engine adopts the waiting reactions right after `captured`
  // (`EngineDeps.onCaptured`), before `resolved` names an owner, so `mention="owner"` named nobody and
  // the post went out without the owner. The map's owner of the channel's surface stands in.
  it('adopted at capture, before resolution: the owner of the channel surface in the map is mentioned', async () => {
    const map = {
      channels: [{ id: CHANNEL, name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
      surfaces: [{ id: 'web', label: 'Website', components: [] }],
      people: [
        { slackId: OWNER.id, handle: 'olu', role: 'engineer', owns: [{ surface: 'web' }] },
        { slackId: reporter(1).id, handle: 'rep1', role: 'reporter', owns: [] },
      ],
    } as unknown as WorkspaceMap;
    const w = world(defaultPlaybook(), map);
    for (const n of [1, 2, 3, 4, 5]) await handleSignal(w.deps, react('escalate', reporter(n)));
    await append(CAPTURED());
    expect(await state.getIncident(INC)).toMatchObject({ status: 'captured' });
    expect((await state.getIncident(INC))?.ownerRef).toBeUndefined();
    expect(await adoptPendingSignals(w.deps, INC)).toBe(5);

    expect((await escalated()).map((p) => [p.step, p.mentionOwner === true])).toEqual([
      [1, false],
      [2, true],
    ]);
    expect(w.posts).toEqual([
      {
        incidentId: INC,
        ladder: REACTION_LADDER,
        step: 2,
        where: { kind: 'thread', channel: CHANNEL, threadId: ANCHOR },
        mention: 'olu',
        text: '5 people are reporting this. Priority raised to Highest.',
      },
    ]);
  });

  it('adopted at capture with no map, or a channel the map does not know: posted without a mention', async () => {
    const w = world(defaultPlaybook(), { channels: [], surfaces: [], people: [] } as unknown as WorkspaceMap);
    for (const n of [1, 2, 3, 4, 5]) await handleSignal(w.deps, react('escalate', reporter(n)));
    await append(CAPTURED());
    await adoptPendingSignals(w.deps, INC);
    expect(w.posts).toHaveLength(1);
    expect(w.posts[0]?.mention).toBeUndefined();
  });

  it('before filing the row takes the priority and Jira gets nothing; a closed incident escalates no more', async () => {
    await append(CAPTURED(), ...RESOLVED(), ...PLANNED());
    const w = world();
    for (const n of [1, 2, 3]) await handleSignal(w.deps, react('escalate', reporter(n)));
    expect((await escalated()).map((p) => p.priority)).toEqual(['High']);
    expect(await state.getIncident(INC)).toMatchObject({ status: 'planned', priority: 'High' });
    expect(await priorityRows()).toEqual([]);

    await append(ev('filed', { jiraKey: 'WEB-1042' }), ev('closed', { reason: 'fixed elsewhere' }));
    for (const n of [4, 5]) await handleSignal(w.deps, react('escalate', reporter(n)));
    expect((await escalated()).map((p) => p.step)).toEqual([1]);
    expect(await priorityRows()).toEqual([]);
  });
});

// The ask-back gate reads the suppression ----------------------------------------------------------

describe('the ask-back gate (main 7.2, A 1.4)', () => {
  it('a suppressed ask-back fails the budget check before any model call', async () => {
    expect(evaluateBudget({ maxQuestionsPerIncident: 1, suppressWhenReportersAtLeast: 3, questionsAsked: 0, reportersInWindow: 1 })).toEqual([]);
    const failures = evaluateBudget({ maxQuestionsPerIncident: 1, suppressWhenReportersAtLeast: 3, questionsAsked: 0, reportersInWindow: 1, escalated: true });
    expect(failures.map((f) => f.split(':')[0])).toEqual([GATE_CODES.escalated]);

    const noModel: ModelPort = {
      complete: () => Promise.reject(new Error('model must not be called')),
      vision: () => Promise.reject(new Error('model must not be called')),
      classify: () => Promise.reject(new Error('model must not be called')),
    };
    const map = { surfaces: [], people: [], policies: {} } as unknown as WorkspaceMap;
    const payload = { reporter: reporter(1) } as unknown as CanonicalIncidentPayload;
    const bundle = { included: [], excluded: [] } as unknown as ContextBundle;
    const unresolved = { resolvedBy: 'none', confidence: 0 } as unknown as Resolution;
    const q = await maybeAsk(payload, bundle, unresolved, map, noModel, { escalated: true });
    expect(q).toMatchObject({ gatePassed: false });
    expect(q?.gateFailures.map((f) => f.split(':')[0])).toEqual([GATE_CODES.escalated]);
  });
});
