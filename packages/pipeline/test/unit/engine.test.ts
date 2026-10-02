// IncidentOrchestrator (#47, main 14.1, B 5): the process job on the in-process WorkflowPort over a
// real state store (SNAPWING_DB picks the dialect), with fakes for the adapter, the chat reader, Jira
// search, and the model (a scripted backend behind the shared classify contract). The outbox worker
// is simulated: it drains `create-issue`, appends `filed`, and continues the incident.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReader } from '../../src/context/chat-reader.ts';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '../../src/contracts/adapters.ts';
import type { EventActorRole, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload, SourceMessage } from '../../src/contracts/incident.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { JiraSearch, JiraSearchHit } from '../../src/dedupe/index.ts';
import { IncidentOrchestrator, UnauthorizedError, UnsupportedChannelError, type TapInput } from '../../src/engine/orchestrator.ts';
import type { CardKind } from '../../src/engine/cursor.ts';
import type { EngineDeps } from '../../src/engine/deps.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { AutonomyLevelId, WorkspaceMap } from '../../src/map/types.ts';
import { withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest, ModelBackend } from '../../src/ports/model.ts';
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
const CHANNEL = 'C0APPBUGS'; // the example map: explicit channel for the mobile surface (APP), owned by mobDev
const REPORTER = { id: 'U0SALESLEAD', role: 'reporter' as EventActorRole };
const ENGINEER = { id: 'U0MOBDEV', role: 'engineer' as EventActorRole };

function at(minutes: number): string {
  return new Date(T0.getTime() + minutes * 60_000).toISOString();
}

function message(id: string, minutes: number, text: string, authorId = 'U0SALESLEAD'): SourceMessage {
  return { id, authorId, text, timestamp: at(minutes), replyCount: 0, mentions: [], reactions: [], attachments: [] };
}

const ANCHOR = message('m1', 0, 'the app crashes when I open settings');
const SECOND = message('m2', 1, 'same here on android', 'U0WEBDEV1');
const RETRACTION = message('m3', 3, 'nvm, works now after the update');

// Fakes -------------------------------------------------------------------------------------------

interface FakeRaw {
  signature: string;
  payload: CanonicalIncidentPayload;
}

class FakeAdapter implements IngestionAdapter<FakeRaw, { status: number }> {
  readonly channelSource = 'slack' as const;
  readonly cards: InteractiveCard[] = [];
  readonly statuses: StatusUpdate[] = [];
  authenticateRequest(raw: FakeRaw): Promise<boolean> {
    return Promise.resolve(raw.signature === 'sig-test');
  }
  normalizePayload(raw: FakeRaw): Promise<CanonicalIncidentPayload> {
    return Promise.resolve(raw.payload);
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
    history: (_channel, oldest, latest, limit) =>
      Promise.resolve(messages.filter((m) => m.timestamp >= oldest && m.timestamp <= latest).slice(0, limit)),
    replies: () => Promise.resolve([]),
  };
}

function fakeJira(hits: JiraSearchHit[]): JiraSearch & { queries: string[] } {
  const queries: string[] = [];
  return {
    queries,
    search(jql) {
      queries.push(jql);
      return Promise.resolve(hits);
    },
  };
}

/** Answers classify by task; anything else is a test bug. Wrapped in withValidation like every port. */
function scriptedModel(answers: Partial<Record<string, unknown>>): ModelBackend & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    complete: () => Promise.reject(new Error('complete is not scripted')),
    vision: () => Promise.reject(new Error('vision is not scripted')),
    classify(request: ClassifyRequest<unknown>) {
      tasks.push(request.task);
      if (!(request.task in answers)) return Promise.reject(new Error(`classify ${request.task} is not scripted`));
      return Promise.resolve({ value: answers[request.task], model: 'scripted/test' });
    },
  };
}

const TRIAGE = {
  action: 'create_issue',
  issueType: 'Bug',
  summary: 'App crashes when opening Settings',
  description: 'Opening Settings crashes the app on Android.',
  priority: 'Medium',
  labels: ['crash'],
};

function segmentation(messages: SourceMessage[], resolutionMessageId = ''): unknown {
  return { included: messages.map((m) => m.id), excluded: [], resolutionMessageId };
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

interface Scene {
  level?: AutonomyLevelId;
  messages?: SourceMessage[];
  segment?: unknown;
  jira?: JiraSearchHit[];
  channel?: string;
  clarify?: unknown;
}

interface Harness {
  engine: IncidentOrchestrator;
  adapter: FakeAdapter;
  model: ReturnType<typeof scriptedModel>;
  payload: CanonicalIncidentPayload;
  raw: FakeRaw;
}

function setup(scene: Scene = {}): Harness {
  const messages = scene.messages ?? [ANCHOR, SECOND];
  const adapter = new FakeAdapter();
  const channel = scene.channel ?? CHANNEL;
  const model = scriptedModel({
    segmentation: scene.segment ?? segmentation(messages),
    triage: TRIAGE,
    ...(scene.clarify === undefined ? {} : { clarify: scene.clarify }),
  });
  if (!(state instanceof StateStore)) throw new Error('expected a StateStore');
  const deps: EngineDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    model: withValidation(model),
    adapters: new Map([['slack', adapter]]),
    context: new Map([
      [
        'slack',
        {
          reader: fakeReader(messages),
          anchor: (p) => Promise.resolve({ channelId: p.context.channelId, message: ANCHOR }),
        },
      ],
    ]),
    jiraSearch: fakeJira(scene.jira ?? []),
    cache: createKvCache(state),
    map: withLevel(baseMap, scene.level ?? 0),
    clock: () => new Date(now),
  };
  const engine = new IncidentOrchestrator(deps);
  engine.register();
  const payload: CanonicalIncidentPayload = {
    eventId: ulid(T0.getTime()),
    idempotencyKey: `slack-${channel}-${ANCHOR.id}`,
    source: 'slack',
    reporter: { id: REPORTER.id, name: 'Pat', role: 'reporter' },
    anchorText: ANCHOR.text,
    context: { channelId: channel, deepLink: 'https://example.test/archives/C0APPBUGS/p1', rawPayloadSnapshot: { ts: ANCHOR.id } },
    timestamp: ANCHOR.timestamp,
  };
  return { engine, adapter, model, payload, raw: { signature: 'sig-test', payload } };
}

async function inbound(h: Harness): Promise<void> {
  expect(await h.engine.handleInbound('slack', h.raw)).toEqual({ status: 200 });
  await wf.drain();
}

async function tap(h: Harness, card: CardKind, choice: string, actor: TapInput['actor'] = REPORTER): Promise<void> {
  expect(await h.engine.handleTap({ eventId: h.payload.eventId, card, choice, actor })).toEqual({ accepted: true, resumed: true });
  await wf.drain();
}

async function events(h: Harness): Promise<IncidentEvent[]> {
  return state.read(h.payload.eventId);
}

async function types(h: Harness): Promise<EventType[]> {
  return (await events(h)).map((e) => e.type);
}

async function status(h: Harness): Promise<string | undefined> {
  return (await state.getIncident(h.payload.eventId))?.status;
}

async function outbox(): Promise<OutboxItem[]> {
  return state.drainOutbox('jira', 50);
}

/** The Jira outbox worker, simulated: create-issue succeeded, so `filed` is appended and the incident continues. */
async function file(h: Harness, jiraKey: string): Promise<void> {
  const rows = await outbox();
  const create = rows.find((r) => r.op === 'create-issue' && r.incidentId === h.payload.eventId);
  expect(create).toBeDefined();
  await state.ackOutbox(rows.map((r) => r.id));
  const log = await events(h);
  await state.append(h.payload.eventId, [{ workspaceId: WS, incidentId: h.payload.eventId, type: 'filed', v: 1, source: 'jira', occurredAt: new Date(now).toISOString(), payload: { jiraKey } }], log.length);
  await h.engine.continueIncident(h.payload.eventId);
  await wf.drain();
}

const PREFIX: EventType[] = ['captured', 'context-assembled', 'waiting-changed', 'tapped', 'resolved', 'dedupe-checked'];

// Tests -------------------------------------------------------------------------------------------

describe('handleInbound', () => {
  it('authenticates, normalizes, starts the process job once per idempotency key, and acknowledges', async () => {
    const h = setup();
    await inbound(h);
    expect(await types(h)).toEqual(['captured', 'context-assembled', 'waiting-changed']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview']);

    // The same message again (a retried delivery), even under a fresh event id: acknowledged, nothing started.
    const again = { ...h.payload, eventId: ulid(T0.getTime() + 1) };
    expect(await h.engine.handleInbound('slack', { signature: 'sig-test', payload: again })).toEqual({ status: 200 });
    await wf.drain();
    expect(await state.read(again.eventId)).toEqual([]);
  });

  it('rejects an unauthenticated request and an unknown channel before doing anything', async () => {
    const h = setup();
    await expect(h.engine.handleInbound('slack', { ...h.raw, signature: 'forged' })).rejects.toBeInstanceOf(UnauthorizedError);
    await expect(h.engine.handleInbound('teams', h.raw)).rejects.toBeInstanceOf(UnsupportedChannelError);
    await wf.drain();
    expect(await types(h)).toEqual([]);
  });
});

describe('levels (main 14.1)', () => {
  it('level 0: files ticket only through the outbox and waits on the owner', async () => {
    const h = setup({ level: 0 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(await types(h)).toEqual([...PREFIX, 'planned']);
    expect(await status(h)).toBe('planned');

    const [row] = await outbox();
    expect(row?.op).toBe('create-issue');
    const create = row?.payload as { fields: { project: { key: string }; labels: string[] }; customFields: Record<string, unknown> };
    expect(create.fields.project.key).toBe('APP');
    expect(create.fields.labels).toContain('crash');
    expect(create.customFields['Autonomy Level']).toBe(0);
    expect(String(create.customFields['Implementation Prompt'])).toContain('autonomy="0"');

    await file(h, 'APP-101');
    expect((await types(h)).slice(-2)).toEqual(['filed', 'waiting-changed']);
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toMatchObject({ kind: 'human', who: 'mobDev' });
    expect(await outbox()).toEqual([]); // no transition at level 0
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview']);
    expect(h.adapter.statuses).toEqual([{ issueKey: 'APP-101', stage: 'filed', text: 'Filed as APP-101, assigned to @mobDev.' }]);
  });

  it('level 1: parks on the fix preview, files on Fix it, and moves to In Progress after filed', async () => {
    const h = setup({ level: 1 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(await types(h)).toEqual([...PREFIX, 'planned', 'waiting-changed']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    expect(await outbox()).toEqual([]); // nothing reaches Jira before the decision

    // A reporter cannot start the fixer; the owner is asked instead (main 8.2).
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'fix-preview', choice: 'approve_fix', actor: REPORTER })).toEqual({
      accepted: false,
      reason: 'engineer-required',
      askOwner: true,
    });
    await tap(h, 'fix-preview', 'approve_fix', ENGINEER);
    expect((await types(h)).slice(-2)).toEqual(['tapped', 'waiting-changed']);
    const [create] = await outbox();
    expect(create?.op).toBe('create-issue');
    expect((create?.payload as { customFields: Record<string, unknown> }).customFields['Autonomy Level']).toBe(1);

    await file(h, 'APP-102');
    const [transition] = await outbox();
    expect(transition).toMatchObject({ op: 'transition', payload: { issueKey: 'APP-102', to: 'In Progress' } });
    expect(await status(h)).toBe('filed');
  });

  it('level 2: files, then moves to In Progress and posts the informational fix preview after filed', async () => {
    const h = setup({ level: 2 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(await types(h)).toEqual([...PREFIX, 'planned']);
    const [create] = await outbox();
    expect(String((create?.payload as { customFields: Record<string, unknown> }).customFields['Implementation Prompt'])).toContain('mode="review"');

    await file(h, 'APP-103');
    const [transition] = await outbox();
    expect(transition).toMatchObject({ op: 'transition', payload: { issueKey: 'APP-103', to: 'In Progress' } });
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toBeUndefined();

    // The informational card is not awaited: nothing is parked, so a tap on it is refused.
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'fix-preview', choice: 'dismiss', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });
  });

  it('level 3: same path as level 2, with an autopilot handoff in the implementation request', async () => {
    const h = setup({ level: 3 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    const log = await events(h);
    const planned = log.find((e): e is IncidentEvent<'planned'> => e.type === 'planned');
    expect(planned?.payload.autonomyLevel).toBe(3);
    const ref = planned?.payload.implementationRequest;
    expect(ref).toBeDefined();
    const xml = (await state.getArtifact(ref?.artifactId ?? '', ref?.version)).body;
    expect(xml).toContain('mode="auto"');

    await file(h, 'APP-104');
    expect(await outbox()).toMatchObject([{ op: 'transition', payload: { issueKey: 'APP-104', to: 'In Progress' } }]);
    expect((await types(h)).slice(-2)).toEqual(['filed', 'waiting-changed']);
  });
});

describe('early exits and waits', () => {
  it('stops at not-filed when a later message says it is fixed (resolution signal, main 5.4)', async () => {
    const messages = [ANCHOR, SECOND, RETRACTION];
    const h = setup({ messages, segment: segmentation(messages, RETRACTION.id) });
    await inbound(h);
    expect(await types(h)).toEqual(['captured', 'context-assembled', 'resolution-signal']);
    expect(await status(h)).toBe('not-filed');
    expect(h.adapter.cards).toEqual([]);
    expect(await outbox()).toEqual([]);
    expect(h.model.tasks).toEqual(['segmentation']);
  });

  it('links to an existing issue from the dedupe card instead of creating one (main 6)', async () => {
    const h = setup({ jira: [{ key: 'APP-7', summary: 'The app crashes when I open settings', assignee: 'mobDev' }] });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(h.adapter.cards[1]).toEqual({ kind: 'dedupe', issueKey: 'APP-7', summary: 'The app crashes when I open settings', assignee: 'mobDev' });

    await tap(h, 'dedupe', 'link');
    expect(await types(h)).toEqual([...PREFIX, 'waiting-changed', 'tapped', 'corrected', 'linked-to-existing']);
    expect(await status(h)).toBe('linked-to-existing');
    const incident = await state.getIncident(h.payload.eventId);
    expect(incident?.jiraKey).toBe('APP-7');
    const rows = await outbox();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ op: 'add-comment', payload: { issueKey: 'APP-7' } });
    expect(h.model.tasks).not.toContain('triage');
  });

  it('applies the defaults when taps time out: Looks right, then ticket only at level 1 (B 5)', async () => {
    const h = setup({ level: 1 });
    await inbound(h);
    now += DAY + 1;
    await wf.drain(); // the scope preview times out: Looks right
    expect(await types(h)).toEqual(['captured', 'context-assembled', 'waiting-changed', 'resolved', 'dedupe-checked', 'planned', 'waiting-changed']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);

    now += DAY + 1;
    await wf.drain(); // the fix preview times out: ticket only
    expect((await types(h)).slice(-1)).toEqual(['waiting-changed']);
    expect((await outbox()).map((r) => r.op)).toEqual(['create-issue']);

    // A tap after the timeout is refused and not recorded.
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'fix-preview', choice: 'approve_fix', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });

    await file(h, 'APP-105');
    expect(await outbox()).toEqual([]); // ticket only: no transition
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toMatchObject({ kind: 'human', who: 'mobDev' });
    expect(h.adapter.statuses.at(-1)?.text).toBe('Filed as APP-105, assigned to @mobDev. Nobody tapped Fix it within 24 hours, so this is filed as ticket only.');
    expect((await types(h)).filter((t) => t === 'tapped')).toEqual([]);
  });

  it('widens the scope as a corrected bundle and shows the preview again', async () => {
    const early = message('m0', -45, 'settings page looks odd since this morning');
    const messages = [early, ANCHOR, SECOND];
    const h = setup({ messages, segment: segmentation(messages) });
    await inbound(h);
    expect(h.adapter.cards[0]).toEqual({ kind: 'scope-preview', summary: expect.stringContaining('Reading 2 messages') as unknown });

    await tap(h, 'scope-preview', 'widen');
    expect(await types(h)).toEqual(['captured', 'context-assembled', 'waiting-changed', 'tapped', 'corrected']);
    expect(h.adapter.cards[1]).toEqual({ kind: 'scope-preview', summary: expect.stringContaining('Reading 3 messages') as unknown });
    const incident = await events(h);
    const assembled = incident.find((e): e is IncidentEvent<'context-assembled'> => e.type === 'context-assembled');
    const corrected = incident.find((e): e is IncidentEvent<'corrected'> => e.type === 'corrected');
    expect(corrected?.payload).toMatchObject({ correctsSeq: assembled?.seq, fields: { includedCount: 3, bundle: { version: 2 } } });

    await tap(h, 'scope-preview', 'looks-right');
    expect((await types(h)).slice(-4)).toEqual(['tapped', 'resolved', 'dedupe-checked', 'planned']);
  });

  it('asks back when the gate passes and records the answer on the clarified event (main 7)', async () => {
    const question = {
      audience: 'reporter',
      kind: 'experiential',
      asks: 'component',
      text: 'Which part of the website were you using?',
      options: ['Navigation', 'Checkout'],
      screenshotRequest: false,
    };
    // C0WEBBUGS names the web surface but no component, and web has three: a component gap.
    const h = setup({ channel: 'C0WEBBUGS', clarify: question });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(h.adapter.cards[1]).toMatchObject({ kind: 'clarify', question: { text: question.text, options: question.options, gatePassed: true } });
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'clarify', choice: ' ', actor: REPORTER })).toEqual({ accepted: false, reason: 'invalid-choice' });

    await tap(h, 'clarify', 'Checkout');
    expect(await types(h)).toEqual([...PREFIX, 'clarified', 'waiting-changed', 'tapped', 'corrected', 'waiting-changed', 'planned']);
    const log = await events(h);
    const clarified = log.find((e): e is IncidentEvent<'clarified'> => e.type === 'clarified');
    expect(clarified?.payload).toEqual({ audience: 'reporter', question: question.text, timedOut: false });
    expect(log.find((e) => e.type === 'corrected')?.payload).toMatchObject({ correctsSeq: clarified?.seq, fields: { answer: 'Checkout' } });
    const [create] = await outbox();
    expect((create?.payload as { fields: { labels: string[] } }).fields.labels).not.toContain('needs-clarification');
  });
});
