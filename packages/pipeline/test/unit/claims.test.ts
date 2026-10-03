// Claims (#291, A 2.1): an engineer's claim between the anchor and the fixer start holds the fixer at
// every level. The engine runs on the in-process workflow over a real store (SNAPWING_DB picks the
// dialect) with a scripted model, a fake chat adapter, and a fake read-only repo for the scout; the
// fixer job runs on the same workflow with a fake runner. Signal ingestion that produces `claimed`
// is another issue, so each test appends the claim directly and calls `handleClaim` as the signal
// handler will. The Jira outbox worker is simulated as in engine.test.ts.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReader } from '../../src/context/chat-reader.ts';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '../../src/contracts/adapters.ts';
import type { EventActor, EventPayloads, EventType, IncidentEvent, NewEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload, SourceMessage } from '../../src/contracts/incident.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import { claimState } from '../../src/engine/claims.ts';
import type { CardKind } from '../../src/engine/cursor.ts';
import type { EngineDeps } from '../../src/engine/deps.ts';
import { IncidentOrchestrator, type TapInput } from '../../src/engine/orchestrator.ts';
import { registerFixerJobs, runFixerJob, startFixer, type FixerDeps } from '../../src/fixer/job.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { AutonomyLevelId, WorkspaceMap } from '../../src/map/types.ts';
import { withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest, ModelBackend } from '../../src/ports/model.ts';
import type { FixerJob, RunnerPort } from '../../src/ports/runner.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import { StateStore } from '../../src/state/store.ts';
import { ulid } from '../../src/util/ulid.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const exampleXml = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

const T0 = new Date('2026-10-02T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const WS = '01K6WORKSPACE0000000000000';
const CHANNEL = 'C0APPBUGS'; // the example map: the mobile surface (APP, github.com/acme/mobile), owned by mobDev
const REPORTER: EventActor = { id: 'U0SALESLEAD', role: 'reporter', name: 'Pat' };
/** The claimer: webDev1 in the example map, an engineer with an email. */
const DANA: EventActor = { id: 'U0WEBDEV1', role: 'engineer', name: 'Dana' };
const OWNER: EventActor = { id: 'U0MOBDEV', role: 'engineer' };
const SCOUT_FILE = 'app/settings/SettingsScreen.kt';

function at(minutes: number): string {
  return new Date(T0.getTime() + minutes * 60_000).toISOString();
}

function message(id: string, minutes: number, text: string, authorId = 'U0SALESLEAD'): SourceMessage {
  return { id, authorId, text, timestamp: at(minutes), replyCount: 0, mentions: [], reactions: [], attachments: [] };
}

const ANCHOR = message('m1', 0, 'the app crashes when I open settings');
const SECOND = message('m2', 1, 'same here on android', 'U0WEBDEV1');

// Fakes -------------------------------------------------------------------------------------------

class FakeAdapter implements IngestionAdapter<CanonicalIncidentPayload, { status: number }> {
  readonly channelSource = 'slack' as const;
  readonly cards: InteractiveCard[] = [];
  readonly statuses: StatusUpdate[] = [];
  authenticateRequest(): Promise<boolean> {
    return Promise.resolve(true);
  }
  normalizePayload(raw: CanonicalIncidentPayload): Promise<CanonicalIncidentPayload> {
    return Promise.resolve(raw);
  }
  acknowledge(): Promise<{ status: number }> {
    return Promise.resolve({ status: 200 });
  }
  postInteractive(_payload: CanonicalIncidentPayload, card: InteractiveCard): Promise<void> {
    this.cards.push(card);
    return Promise.resolve();
  }
  postStatus(_payload: CanonicalIncidentPayload, status: StatusUpdate): Promise<void> {
    this.statuses.push(status);
    return Promise.resolve();
  }
}

function fakeReader(messages: SourceMessage[]): ChatReader {
  return {
    history: (_channel, oldest, latest, limit) => Promise.resolve(messages.filter((m) => m.timestamp >= oldest && m.timestamp <= latest).slice(0, limit)),
    replies: () => Promise.resolve([]),
  };
}

function scriptedModel(answers: Record<string, unknown>): ModelBackend {
  return {
    complete: () => Promise.reject(new Error('complete is not scripted')),
    vision: () => Promise.reject(new Error('vision is not scripted')),
    classify(request: ClassifyRequest<unknown>) {
      if (!(request.task in answers)) return Promise.reject(new Error(`classify ${request.task} is not scripted`));
      return Promise.resolve({ value: answers[request.task], model: 'scripted/test' });
    },
  };
}

class FakeRunner implements RunnerPort {
  readonly started: FixerJob[] = [];
  runFixer(job: FixerJob): Promise<{ runId: string }> {
    this.started.push(job);
    return Promise.resolve({ runId: job.runId });
  }
  cancel(): Promise<void> {
    return Promise.resolve();
  }
}

function withLevel(map: WorkspaceMap, level: AutonomyLevelId): WorkspaceMap {
  return { ...map, policies: { ...map.policies, autonomy: { ...map.policies.autonomy, default: level, overrides: [] } } };
}

// Harness -----------------------------------------------------------------------------------------

let baseMap: WorkspaceMap;
beforeAll(async () => {
  baseMap = await parseWorkspaceMap(exampleXml);
});

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0.getTime() + 5 * 60_000;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

interface Harness {
  engine: IncidentOrchestrator;
  adapter: FakeAdapter;
  runner: FakeRunner;
  fixer: FixerDeps;
  id: string;
}

function setup(level: AutonomyLevelId): Harness {
  const adapter = new FakeAdapter();
  const runner = new FakeRunner();
  const fixer: FixerDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    runner,
    github: { markIncomplete: () => Promise.resolve(), closePr: () => Promise.resolve() },
    config: { harness: { adapter: 'claude-code' } },
    clock: () => new Date(now),
  };
  registerFixerJobs(fixer);
  if (!(state instanceof StateStore)) throw new Error('expected a StateStore');
  const model = scriptedModel({
    segmentation: { included: ['m1', 'm2'], excluded: [], resolutionMessageId: '' },
    triage: { action: 'create_issue', issueType: 'Bug', summary: 'App crashes when opening Settings', description: 'Opening Settings crashes the app.', priority: 'Medium', labels: ['crash'] },
    scout: { confidence: 'medium', files: [{ path: SCOUT_FILE, note: 'reads prefs before they load' }] },
  });
  const deps: EngineDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    model: withValidation(model),
    adapters: new Map([['slack', adapter]]),
    context: new Map([['slack', { reader: fakeReader([ANCHOR, SECOND]), anchor: (p) => Promise.resolve({ channelId: p.context.channelId, message: ANCHOR }) }]]),
    jiraSearch: { search: () => Promise.resolve([]) },
    cache: createKvCache(state),
    map: withLevel(baseMap, level),
    repoReader: () => ({
      search: () => Promise.resolve([{ path: SCOUT_FILE, snippet: 'val prefs = load()' }]),
      read: () => Promise.resolve('class SettingsScreen { val prefs = load() }'),
    }),
    clock: () => new Date(now),
    startFixer: (incidentId) => startFixer(fixer, { incidentId, attempt: 1 }),
  };
  const engine = new IncidentOrchestrator(deps);
  engine.register();
  return { engine, adapter, runner, fixer, id: ulid(T0.getTime()) };
}

async function inbound(h: Harness): Promise<void> {
  const payload: CanonicalIncidentPayload = {
    eventId: h.id,
    idempotencyKey: `slack-${CHANNEL}-${ANCHOR.id}`,
    source: 'slack',
    reporter: { id: REPORTER.id, name: 'Pat', role: 'reporter' },
    anchorText: ANCHOR.text,
    context: { channelId: CHANNEL, rawPayloadSnapshot: { ts: ANCHOR.id } },
    timestamp: ANCHOR.timestamp,
  };
  await h.engine.handleInbound('slack', payload);
  await wf.drain();
}

async function tap(h: Harness, card: CardKind, choice: string, actor: TapInput['actor']): Promise<void> {
  expect(await h.engine.handleTap({ eventId: h.id, card, choice, actor })).toEqual({ accepted: true, resumed: true });
  await wf.drain();
}

async function log(h: Harness): Promise<IncidentEvent[]> {
  return state.read(h.id);
}

async function types(h: Harness): Promise<EventType[]> {
  return (await log(h)).map((e) => e.type);
}

async function append<T extends EventType>(h: Harness, type: T, payload: EventPayloads[T], actor?: EventActor): Promise<number> {
  const last = (await log(h)).at(-1)?.seq ?? 0;
  const event = { workspaceId: WS, incidentId: h.id, type, v: 1, source: 'slack', ...(actor === undefined ? {} : { actor }), occurredAt: new Date(now).toISOString(), payload };
  const { seq } = await state.append(h.id, [event as unknown as NewEvent], last);
  return seq;
}

/** A claim as the signal handler will record it, then its `handleClaim` call. */
async function claim(h: Harness, actor: EventActor): Promise<{ commented: boolean; woke: boolean }> {
  const seq = await append(h, 'claimed', { claimerId: actor.id, expiresAt: new Date(now + 4 * 60 * 60_000).toISOString() }, actor);
  const outcome = await h.engine.handleClaim(h.id, seq);
  await wf.drain();
  return outcome;
}

/** Undone Jira rows, minus the Agent Status and Autonomy Level writes the lifecycle rows add (outbox-jira.test.ts covers those). */
async function rows(): Promise<OutboxItem[]> {
  return (await state.drainOutbox('jira', 50)).filter((r) => r.op !== 'update-fields');
}

async function ack(): Promise<void> {
  await state.ackOutbox((await state.drainOutbox('jira', 50)).map((r) => r.id));
}

/** The Jira outbox worker, simulated: create-issue succeeded, `filed` is appended, the incident continues. */
async function file(h: Harness, jiraKey: string): Promise<void> {
  expect((await rows()).some((r) => r.op === 'create-issue' && r.incidentId === h.id)).toBe(true);
  await ack();
  await append(h, 'filed', { jiraKey });
  await h.engine.continueIncident(h.id);
  await wf.drain();
}

/** The Jira In Progress webhook, simulated: a human (or a sent transition) moves the issue, so `fixer.run` runs. */
async function inProgressWebhook(h: Harness): Promise<unknown> {
  return runFixerJob(h.fixer, { incidentId: h.id, attempt: 1 });
}

function ops(list: OutboxItem[]): string[] {
  return list.map((r) => (r.op === 'transition' ? `transition:${String(r.payload['to'])}` : r.op));
}

function comments(list: OutboxItem[]): string[] {
  return list.filter((r) => r.op === 'add-comment').map((r) => String(r.payload['text']));
}

interface CreateRow {
  fields: { labels: string[] };
  suggestedAssigneeEmail?: string;
}

// Tests -------------------------------------------------------------------------------------------

describe('claimState (A 2.1)', () => {
  const base = { workspaceId: WS, incidentId: 'inc', v: 1, source: 'slack', occurredAt: at(1), recordedAt: at(1) } as const;
  const e = <T extends EventType>(seq: number, type: T, payload: EventPayloads[T], actor?: EventActor): IncidentEvent =>
    ({ ...base, seq, type, payload, ...(actor === undefined ? {} : { actor }) }) as unknown as IncidentEvent;
  const claimed = (seq: number, actor: EventActor) => e(seq, 'claimed', { claimerId: actor.id, expiresAt: at(240) }, actor);

  it('an engineer claim before the first fixer start holds; one after it, or a reporter claim, does not', () => {
    expect(claimState([claimed(1, DANA)]).hold).toMatchObject({ seq: 1, claimerId: DANA.id });
    expect(claimState([e(1, 'fixer-started', { runId: 'r1', harness: 'claude-code', attempt: 1 }), claimed(2, DANA)]).hold).toBeUndefined();
    const reporter = claimState([claimed(1, REPORTER)]);
    expect(reporter.hold).toBeUndefined();
    expect(reporter.reporterClaims).toEqual([{ seq: 1, claimerId: REPORTER.id, actor: REPORTER }]);
  });

  it("let-agent-take or the holder's release ends the hold; someone else's release does not", () => {
    expect(claimState([claimed(1, DANA), e(2, 'released', { scope: 'claim', claimerId: OWNER.id, reason: 'requested' })]).hold).toBeDefined();
    const released = claimState([claimed(1, DANA), e(2, 'released', { scope: 'claim', claimerId: DANA.id, reason: 'expired' })]);
    expect(released).toMatchObject({ ended: { seq: 2, by: 'released', hold: { claimerId: DANA.id } } });
    expect(released.hold).toBeUndefined();
    const taken = claimState([claimed(1, DANA), e(2, 'let-agent-take', { claimerId: DANA.id }, OWNER)]);
    expect(taken.ended?.by).toBe('let-agent-take');
    // A new claim before any fixer start holds again.
    expect(claimState([claimed(1, DANA), e(2, 'let-agent-take', { claimerId: DANA.id }), claimed(3, OWNER)]).hold?.seq).toBe(3);
  });
});

describe("an engineer's claim holds the fixer (A 2.1)", () => {
  it('level 2: files ticket only, labeled and assigned to the claimer, scout comment, claim card; Let the agent take it starts the fixer', async () => {
    const h = setup(2);
    await inbound(h);
    // Claimed while the scope card waits: nothing to wake, the job reads the claim when it resumes.
    expect(await claim(h, DANA)).toEqual({ commented: false, woke: false });
    await tap(h, 'scope-preview', 'looks-right', REPORTER);

    const [create] = await rows();
    expect(create?.op).toBe('create-issue');
    const row = create?.payload as unknown as CreateRow;
    expect(row.fields.labels).toEqual(expect.arrayContaining(['crash', 'human-claimed']));
    expect(row.suggestedAssigneeEmail).toBe('dana@example.com');
    // The configured level is kept, so it can resume.
    expect((await log(h)).find((e): e is IncidentEvent<'planned'> => e.type === 'planned')?.payload.autonomyLevel).toBe(2);

    await file(h, 'APP-201');
    const after = await rows();
    expect(ops(after)).toEqual(['add-labels', 'add-comment']); // no In Progress transition
    expect(after[0]?.payload).toEqual({ issueKey: 'APP-201', labels: ['human-claimed'] });
    const [diagnosis] = comments(after);
    expect(diagnosis).toContain(`while @webDev1 is on this`);
    expect(diagnosis).toContain(`- ${SCOUT_FILE}: reads prefs before they load`);
    // The fix preview is replaced by the claim card.
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'claimed']);
    expect(h.adapter.cards[1]).toEqual({ kind: 'claimed', issueKey: 'APP-201', claimerUserId: DANA.id });
    expect(h.adapter.statuses.map((s) => s.text)).toEqual(['Filed as APP-201, assigned to @webDev1. @webDev1 is on it, so this is filed as ticket only.']);
    expect((await state.getIncident(h.id))?.waitingOn).toMatchObject({ kind: 'human', who: DANA.id });

    // A human moving the issue to In Progress (or any other start) is refused while the claim holds.
    expect(await inProgressWebhook(h)).toEqual({ started: false, reason: 'claimed' });
    expect(h.runner.started).toEqual([]);
    await ack();

    // Handing it back starts a fix, so it takes an engineer.
    expect(await h.engine.handleTap({ eventId: h.id, card: 'claimed', choice: 'let-agent-take', actor: REPORTER })).toEqual({
      accepted: false,
      reason: 'engineer-required',
    });
    await tap(h, 'claimed', 'let-agent-take', DANA);
    const taken = (await log(h)).find((e): e is IncidentEvent<'let-agent-take'> => e.type === 'let-agent-take');
    expect(taken).toMatchObject({ payload: { claimerId: DANA.id }, actor: { id: DANA.id } });
    // Level 2 resumes: In Progress, the informational fix preview, and the fixer.
    expect(ops(await rows())).toEqual(['transition:in-progress']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'claimed', 'fix-preview']);
    expect(h.runner.started).toHaveLength(1);
    expect((await types(h)).slice(-4)).toEqual(['tapped', 'let-agent-take', 'waiting-changed', 'fixer-started']);
    // The card is answered: a second tap is refused.
    expect(await h.engine.handleTap({ eventId: h.id, card: 'claimed', choice: 'dismiss', actor: DANA })).toEqual({ accepted: false, reason: 'not-pending' });
  });

  it('level 1: a claim on the parked fix preview files ticket only at once; Fix it is no longer pending', async () => {
    const h = setup(1);
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right', REPORTER);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    expect(await rows()).toEqual([]);

    expect(await claim(h, DANA)).toEqual({ commented: false, woke: true });
    const [create] = await rows();
    expect(create?.op).toBe('create-issue');
    expect((create?.payload as unknown as CreateRow).fields.labels).toContain('human-claimed');
    expect(await h.engine.handleTap({ eventId: h.id, card: 'fix-preview', choice: 'approve_fix', actor: OWNER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });

    await file(h, 'APP-202');
    expect(ops(await rows())).toEqual(['add-labels', 'add-comment']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview', 'claimed']);
    expect(await inProgressWebhook(h)).toEqual({ started: false, reason: 'claimed' });
    await ack();

    // The card waits past its timeout without reposting: a claim has no default.
    now += DAY + 1;
    await wf.drain();
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview', 'claimed']);

    // At level 1 an engineer's Let the agent take it is the Fix it approval.
    await tap(h, 'claimed', 'let-agent-take', DANA);
    expect(ops(await rows())).toEqual(['transition:in-progress']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview', 'claimed']); // no informational preview at level 1
    expect(h.runner.started).toHaveLength(1);
  });

  it('level 3: a claim after the In Progress transition, before the fixer starts, still holds; Let the agent take it starts it directly', async () => {
    const h = setup(3);
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right', REPORTER);
    await file(h, 'APP-203');
    expect(ops(await rows())).toEqual(['transition:in-progress']);
    await ack(); // the issue is In Progress; the webhook has not run the fixer yet

    // The job ended after filing, so the claim starts it again to post the card.
    expect(await claim(h, DANA)).toEqual({ commented: false, woke: true });
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview', 'claimed']);
    expect(await inProgressWebhook(h)).toEqual({ started: false, reason: 'claimed' });
    // A claim after filing is labeled by the lifecycle rows; the engine adds the scout's comment.
    expect(comments(await rows())).toEqual([expect.stringContaining(SCOUT_FILE)]);
    expect((await state.getIncident(h.id))?.status).toBe('claimed');
    await ack();

    await tap(h, 'claimed', 'let-agent-take', DANA);
    // The issue already sits In Progress, so the transition fires no webhook; `startFixer` starts the run.
    expect(h.runner.started).toHaveLength(1);
    expect((await state.getIncident(h.id))?.status).toBe('fixing');
  });

  it('level 0: the claim card replaces the owner wait; Not a bug closes the issue as Won\'t Do', async () => {
    const h = setup(0);
    await inbound(h);
    await claim(h, DANA);
    await tap(h, 'scope-preview', 'looks-right', REPORTER);
    await file(h, 'APP-204');
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'claimed']);
    await ack();

    await tap(h, 'claimed', 'dismiss', DANA);
    expect((await types(h)).slice(-2)).toEqual(['tapped', 'not-a-bug']);
    expect((await rows()).filter((r) => r.op === 'transition').map((r) => r.payload)).toEqual([{ issueKey: 'APP-204', to: 'done', resolution: "Won't Do" }]);
    expect((await state.getIncident(h.id))?.status).toBe('not-a-bug');
    expect(h.runner.started).toEqual([]);
  });

  it('a released claim (expiry, A 2.4) resumes the configured level the same way', async () => {
    const h = setup(2);
    await inbound(h);
    await claim(h, DANA);
    await tap(h, 'scope-preview', 'looks-right', REPORTER);
    await file(h, 'APP-205');
    await ack();

    const seq = await append(h, 'released', { scope: 'claim', claimerId: DANA.id, reason: 'expired' });
    expect(await h.engine.handleClaim(h.id, seq)).toEqual({ commented: false, woke: true });
    await wf.drain();
    expect(ops(await rows())).toEqual(['transition:in-progress']);
    expect(h.runner.started).toHaveLength(1);
  });
});

describe("a reporter's claim is a comment and holds nothing (A 2.1)", () => {
  it('before filing: the level 2 fixer path runs, and the ticket says who is looking', async () => {
    const h = setup(2);
    await inbound(h);
    expect(await claim(h, REPORTER)).toEqual({ commented: false, woke: false });
    await tap(h, 'scope-preview', 'looks-right', REPORTER);
    const create = (await rows())[0]?.payload as unknown as CreateRow;
    expect(create.fields.labels).not.toContain('human-claimed');

    await file(h, 'APP-206');
    const after = await rows();
    expect(ops(after)).toEqual(['add-comment', 'transition:in-progress']);
    expect(comments(after)).toEqual(['@salesLead is looking into it.']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    expect(await inProgressWebhook(h)).toMatchObject({ started: true });
  });

  it('after filing: a comment on the ticket, and the fixer still starts', async () => {
    const h = setup(2);
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right', REPORTER);
    await file(h, 'APP-207');
    await ack();

    expect(await claim(h, REPORTER)).toEqual({ commented: true, woke: false });
    expect(comments(await rows())).toEqual(['@salesLead is looking into it.']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    expect(await inProgressWebhook(h)).toMatchObject({ started: true });
  });
});
