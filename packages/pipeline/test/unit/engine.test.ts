// IncidentOrchestrator (#47, main 14.1, B 5): the process job on the in-process WorkflowPort over a
// real state store (SNAPWING_DB picks the dialect), with fakes for the adapter, the chat reader, Jira
// search, and the model (a scripted backend behind the shared classify contract). The outbox worker
// is simulated: it drains `create-issue`, appends `filed`, and continues the incident.
//
// Card answers are decision events, never corrections (ADR 0015): `afterEach` checks that no scenario
// appends `corrected`.

import { jiraCreateBatchKey } from '../../src/state/projections/outbox/jira.ts';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ChatReader } from '../../src/context/chat-reader.ts';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '../../src/contracts/adapters.ts';
import type { EscalatedPayload, EventActorRole, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload, SourceMessage } from '../../src/contracts/incident.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { JiraSearch, JiraSearchHit } from '../../src/dedupe/index.ts';
import { IncidentOrchestrator, UnauthorizedError, UnsupportedChannelError, type TapInput } from '../../src/engine/orchestrator.ts';
import type { CardKind } from '../../src/engine/cursor.ts';
import type { EngineDeps, EngineOptions } from '../../src/engine/deps.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { AutonomyLevelId, WorkspaceMap } from '../../src/map/types.ts';
import { withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest, ModelBackend } from '../../src/ports/model.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import { recordBotMessage, roleOfCard } from '../../src/signals/messages.ts';
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
  /** Runs after each card is kept, as a real adapter records what it posted (#287). */
  record: ((payload: CanonicalIncidentPayload, card: InteractiveCard) => Promise<void>) | undefined;
  authenticateRequest(raw: FakeRaw): Promise<boolean> {
    return Promise.resolve(raw.signature === 'sig-test');
  }
  normalizePayload(raw: FakeRaw): Promise<CanonicalIncidentPayload> {
    return Promise.resolve(raw.payload);
  }
  acknowledge(): Promise<{ status: number }> {
    return Promise.resolve({ status: 200 });
  }
  postInteractive(payload: CanonicalIncidentPayload, card: InteractiveCard): Promise<void> {
    this.cards.push(card);
    return this.record?.(payload, card) ?? Promise.resolve();
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

/**
 * Answers classify by `task:schemaName`, then by task; anything else is a test bug. Wrapped in
 * withValidation like every port.
 */
function scriptedModel(
  answers: Partial<Record<string, unknown>>,
  /** Vision readings by image ref: true is a sensitive reading. An unlisted ref fails the call. */
  vision: Record<string, boolean> = {},
): ModelBackend & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    complete: () => Promise.reject(new Error('complete is not scripted')),
    vision: (request) => {
      const ref = Object.keys(vision).find((r) => request.prompt.includes(r));
      if (ref === undefined) return Promise.reject(new Error('vision is not scripted'));
      return Promise.resolve({
        model: 'scripted/test',
        readings: [{ surfaceSignals: {}, uiElements: [], plainDescription: 'a screen', sensitive: vision[ref] === true }],
      });
    },
    classify(request: ClassifyRequest<unknown>) {
      tasks.push(request.task);
      const key = `${request.task}:${request.schemaName}`;
      if (key in answers) return Promise.resolve({ value: answers[key], model: 'scripted/test' });
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
let incidents: string[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0.getTime() + 5 * 60_000;
  errors = [];
  incidents = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
});

afterEach(async () => {
  await wf.stop();
  // ADR 0015: a person's choice is a decision event; no scenario records one as a correction.
  const appended = (await Promise.all(incidents.map((id) => state.read(id)))).flat().map((e) => e.type);
  await tdb.drop();
  expect(errors).toEqual([]);
  expect(appended).not.toContain('corrected');
});

interface Scene {
  level?: AutonomyLevelId;
  anchor?: SourceMessage;
  messages?: SourceMessage[];
  segment?: unknown;
  jira?: JiraSearchHit[];
  channel?: string;
  clarify?: unknown;
  triage?: Record<string, unknown>;
  /** The step 7 answer (task triage, schema resolution); only asked when steps 1 to 6 miss. */
  resolve?: unknown;
  options?: EngineOptions;
  /** Vision readings by image ref: true is a sensitive reading. */
  readings?: Record<string, boolean>;
  /** Overrides the map's `fallbackSurface` (the example map names `web`). */
  fallbackSurface?: string;
}

interface Harness {
  engine: IncidentOrchestrator;
  adapter: FakeAdapter;
  model: ReturnType<typeof scriptedModel>;
  payload: CanonicalIncidentPayload;
  raw: FakeRaw;
}

function setup(scene: Scene = {}): Harness {
  const anchor = scene.anchor ?? ANCHOR;
  const messages = scene.messages ?? [anchor, SECOND];
  const adapter = new FakeAdapter();
  const channel = scene.channel ?? CHANNEL;
  const model = scriptedModel({
    segmentation: scene.segment ?? segmentation(messages),
    triage: { ...TRIAGE, ...scene.triage },
    ...(scene.resolve === undefined ? {} : { 'triage:resolution': scene.resolve }),
    ...(scene.clarify === undefined ? {} : { clarify: scene.clarify }),
  }, scene.readings);
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
          anchor: (p) => Promise.resolve({ channelId: p.context.channelId, message: anchor }),
        },
      ],
    ]),
    jiraSearch: fakeJira(scene.jira ?? []),
    cache: createKvCache(state),
    map: { ...withLevel(baseMap, scene.level ?? 0), ...(scene.fallbackSurface === undefined ? {} : { fallbackSurface: scene.fallbackSurface }) },
    clock: () => new Date(now),
    ...(scene.options === undefined ? {} : { options: scene.options }),
  };
  const engine = new IncidentOrchestrator(deps);
  engine.register();
  const payload: CanonicalIncidentPayload = {
    eventId: ulid(T0.getTime()),
    idempotencyKey: `slack-${channel}-${anchor.id}`,
    source: 'slack',
    reporter: { id: REPORTER.id, name: 'Pat', role: 'reporter' },
    anchorText: anchor.text,
    context: { channelId: channel, deepLink: 'https://example.test/archives/C0APPBUGS/p1', rawPayloadSnapshot: { ts: anchor.id } },
    timestamp: anchor.timestamp,
  };
  incidents.push(payload.eventId);
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

/**
 * The Jira rows the engine enqueued itself. The field writes `outboxFor` derives from the lifecycle
 * (Agent Status after `filed`, #141) are left out; test/unit/outbox-jira.test.ts covers them. The
 * engine's In Progress transition carries a status field key too (#143), so it is kept by op.
 */
async function outbox(): Promise<OutboxItem[]> {
  return (await state.drainOutbox('jira', 50)).filter((r) => r.op === 'transition' || r.batchKey?.startsWith('field:') !== true);
}

function eventOf<T extends EventType>(log: IncidentEvent[], type: T): IncidentEvent<T> | undefined {
  return log.find((e) => e.type === type) as IncidentEvent<T> | undefined;
}

interface CreateRow {
  fields: { project: { key: string }; labels: string[]; description: { content: { content: { text: string }[] }[] } };
  customFields: Record<string, unknown>;
  suggestedAssigneeEmail?: string;
}

/** The plain text of each paragraph in a create-issue description. */
function paragraphs(row: CreateRow): string[] {
  return row.fields.description.content.map((p) => p.content.map((n) => n.text).join(''));
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
  it('create-issue carries the non-sensitive screenshots to attach', async () => {
    const image = (url: string) => ({ kind: 'image' as const, url, mimeType: 'image/png' });
    const anchor: SourceMessage = {
      ...ANCHOR,
      attachments: [image('https://files.example.test/T1/crash.png?t=fake'), image('https://files.example.test/T1/secrets.png')],
    };
    const h = setup({
      level: 0,
      anchor,
      messages: [anchor, SECOND],
      readings: { 'crash.png': false, 'secrets.png': true },
      options: { loadImage: (a) => Promise.resolve({ mimeType: 'image/png', data: 'AAAA', ref: a.url }) },
    });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    const [row] = await outbox();
    expect((row?.payload as { screenshots?: unknown }).screenshots).toEqual([
      { url: 'https://files.example.test/T1/crash.png?t=fake', filename: 'crash.png', contentType: 'image/png' },
    ]);
  });

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

  it("an engineer's trigger on someone else's post: captured keeps both, and the post's author is the incident's reporter (#363)", async () => {
    const h = setup({ level: 0 });
    h.payload.reporter = { id: 'U-FAKE-ENG', name: 'mobDev', role: 'engineer' };
    h.payload.anchorAuthor = { id: REPORTER.id, name: 'Pat', role: 'reporter' };
    await inbound(h);
    const [captured] = await state.read(h.payload.eventId);
    expect(captured?.type === 'captured' ? [captured.payload.reporter.id, captured.payload.anchorAuthor?.id] : []).toEqual(['U-FAKE-ENG', REPORTER.id]);
    expect((await state.getIncident(h.payload.eventId))?.reporterId).toBe(REPORTER.id);
    // Still the reporter once filed.
    await tap(h, 'scope-preview', 'looks-right');
    await file(h, 'APP-101');
    expect((await state.getIncident(h.payload.eventId))?.reporterId).toBe(REPORTER.id);
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
    expect(transition).toMatchObject({ op: 'transition', payload: { issueKey: 'APP-102', to: 'in-progress' } });
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
    expect(transition).toMatchObject({ op: 'transition', payload: { issueKey: 'APP-103', to: 'in-progress' } });
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toBeUndefined();

    // The informational card is not awaited: nothing is parked, so a tap on it is refused.
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'fix-preview', choice: 'dismiss', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });
  });

  it('level 2, an adapter that records its cards (#287): the after-filed step appends past the record and posts the fix preview once', async () => {
    const h = setup({ level: 2 });
    let n = 0;
    h.adapter.record = async (payload, card) => {
      n += 1;
      await recordBotMessage(state, payload.eventId, { platform: 'slack', channel: CHANNEL, messageId: `1730000000.00000${n}`, role: roleOfCard(card.kind) });
    };
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    await file(h, 'APP-104');

    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);
    const log = await events(h);
    expect(log.flatMap((e) => (e.type === 'bot-message-posted' ? [e.payload.role] : []))).toEqual(['scope-preview', 'fix-preview']);
    // The step's own append landed after the fix preview's record.
    expect(log.slice(-2).map((e) => e.type)).toEqual(['bot-message-posted', 'waiting-changed']);
    const [transition] = await outbox();
    expect(transition).toMatchObject({ op: 'transition', payload: { issueKey: 'APP-104', to: 'in-progress' } });
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
    expect(await outbox()).toMatchObject([{ op: 'transition', payload: { issueKey: 'APP-104', to: 'in-progress' } }]);
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
    expect(await types(h)).toEqual([...PREFIX, 'waiting-changed', 'tapped', 'dedupe-decided', 'linked-to-existing']);
    const decided = eventOf(await events(h), 'dedupe-decided');
    expect(decided?.payload).toEqual({ decision: 'link', issueKey: 'APP-7' });
    expect(decided).toMatchObject({ actor: REPORTER, source: 'slack' });
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

  it('widens the scope with a scope-changed event and shows the preview again', async () => {
    const early = message('m0', -45, 'settings page looks odd since this morning');
    const messages = [early, ANCHOR, SECOND];
    const h = setup({ messages, segment: segmentation(messages) });
    await inbound(h);
    expect(h.adapter.cards[0]).toEqual({ kind: 'scope-preview', summary: expect.stringContaining('Reading 2 messages') as unknown });

    await tap(h, 'scope-preview', 'widen');
    expect(await types(h)).toEqual(['captured', 'context-assembled', 'waiting-changed', 'tapped', 'scope-changed']);
    expect(h.adapter.cards[1]).toEqual({ kind: 'scope-preview', summary: expect.stringContaining('Reading 3 messages') as unknown });
    const incident = await events(h);
    const assembled = eventOf(incident, 'context-assembled');
    const changed = eventOf(incident, 'scope-changed');
    expect(changed?.payload).toEqual({
      choice: 'widen',
      bundle: { artifactId: assembled?.payload.bundle.artifactId, version: 2 },
      includedCount: 3,
      excludedCount: 0,
    });
    expect(changed).toMatchObject({ actor: REPORTER, source: 'slack' });
    // The projection only stamps the decision; the status and the data columns stay.
    expect(await state.getIncident(h.payload.eventId)).toMatchObject({ status: 'assembling', lastSeq: changed?.seq, updatedAt: changed?.recordedAt });

    await tap(h, 'scope-preview', 'looks-right');
    expect((await types(h)).slice(-4)).toEqual(['tapped', 'resolved', 'dedupe-checked', 'planned']);
  });

  const HIT = { key: 'APP-7', summary: 'The app crashes when I open settings', assignee: 'mobDev' };

  it('records Not related on the dedupe card as dedupe-decided by the tapper, then files (main 6.2)', async () => {
    const h = setup({ jira: [HIT] });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    await tap(h, 'dedupe', 'not-related');
    const decided = eventOf(await events(h), 'dedupe-decided');
    expect(decided?.payload).toEqual({ decision: 'not-related' });
    expect(decided?.actor).toEqual(REPORTER);
    expect((await types(h)).slice(-4)).toEqual(['tapped', 'dedupe-decided', 'waiting-changed', 'planned']);
    expect((await outbox()).map((r) => r.op)).toEqual(['create-issue']);
  });

  it('records the dedupe timeout default as dedupe-decided with no actor (B 5)', async () => {
    const h = setup({ jira: [HIT] });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    now += DAY + 1;
    await wf.drain();
    const decided = eventOf(await events(h), 'dedupe-decided');
    expect(decided?.payload).toEqual({ decision: 'create-anyway', timedOut: true });
    expect(decided?.actor).toBeUndefined();
    expect((await types(h)).slice(-3)).toEqual(['dedupe-decided', 'waiting-changed', 'planned']);
  });

  it('asks back when the gate passes and applies a component answer to the resolution (main 7, #115)', async () => {
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
    expect(await types(h)).toEqual([...PREFIX, 'clarified', 'waiting-changed', 'tapped', 'clarify-answered', 'resolved', 'waiting-changed', 'planned']);
    const log = await events(h);
    const clarified = eventOf(log, 'clarified');
    expect(clarified?.payload).toEqual({ audience: 'reporter', question: question.text, asks: 'component', options: question.options, timedOut: false });
    const answered = eventOf(log, 'clarify-answered');
    expect(answered?.payload).toEqual({ questionSeq: clarified?.seq, answer: 'Checkout', appliesTo: { field: 'component', id: 'checkout' } });
    expect(answered).toMatchObject({ actor: REPORTER, source: 'slack' });
    const resolved = log.filter((e): e is IncidentEvent<'resolved'> => e.type === 'resolved');
    expect(resolved.map((e) => e.payload.resolvedBy)).toEqual(['channel-explicit', 'clarify']);
    expect(resolved[1]?.payload).toMatchObject({ surfaceId: 'web', componentId: 'checkout', jiraProject: 'WEB' });
    expect(await state.getIncident(h.payload.eventId)).toMatchObject({ status: 'planned', surfaceId: 'web', componentId: 'checkout' });
    const [create] = await outbox();
    const row = create?.payload as unknown as CreateRow;
    expect(row.fields.labels).not.toContain('needs-clarification');
    expect(row.fields.project.key).toBe('WEB');
  });
});

describe('reaction escalation (A 1.4, #290)', () => {
  it('a step that suppressed the ask-back skips the question, and the plan files at the escalated priority', async () => {
    const question = {
      audience: 'reporter',
      kind: 'experiential',
      asks: 'component',
      text: 'Which part of the website were you using?',
      options: ['Navigation', 'Checkout'],
      screenshotRequest: false,
    };
    const h = setup({ channel: 'C0WEBBUGS', clarify: question });
    await inbound(h);
    // Five people reacted while the scope preview waited: the ladder reached Highest (signals/score.ts).
    const log = await events(h);
    await state.append(
      h.payload.eventId,
      (
        [
          { intent: 'escalate', step: 1, action: 'post', score: 5, reactors: 5, priority: 'High', note: true },
          { intent: 'escalate', step: 2, action: 'mention', score: 5, reactors: 5, priority: 'Highest', mentionOwner: true, suppressAskBack: true },
        ] satisfies EscalatedPayload[]
      ).map((payload) => ({ workspaceId: WS, incidentId: h.payload.eventId, type: 'escalated' as const, v: 1, source: 'agent' as const, occurredAt: new Date(now).toISOString(), payload })),
      log.length,
    );
    expect(await status(h)).toBe('assembling');
    await tap(h, 'scope-preview', 'looks-right');

    expect(h.adapter.cards.map((c) => c.kind)).not.toContain('clarify');
    expect(h.model.tasks).not.toContain('clarify');
    const planned = eventOf(await events(h), 'planned');
    expect(planned?.payload.priority).toBe('Highest');
    expect(await state.getIncident(h.payload.eventId)).toMatchObject({ status: 'planned', priority: 'Highest' });
    const create = (await outbox()).find((r) => r.op === 'create-issue');
    expect((create?.payload as { fields: { priority: { name: string } } }).fields.priority).toEqual({ name: 'Highest' });
  });
});

/** `stopIncident` (fixer/stop.ts), reduced to what the engine reads: the `stopped` event itself. */
async function stop(h: Harness, reason = 'trigger reaction removed'): Promise<void> {
  const log = await events(h);
  await state.append(
    h.payload.eventId,
    [{ workspaceId: WS, incidentId: h.payload.eventId, type: 'stopped', v: 1, source: 'slack', actor: REPORTER, occurredAt: new Date(now).toISOString(), payload: { reason } }],
    log.length,
  );
}

describe('Stop before filing (#192, main 15.1)', () => {
  it('ends the job at a parked scope card: the tap is refused, the timeout does nothing, nothing is filed', async () => {
    const h = setup({ level: 0 });
    await inbound(h);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview']);

    await stop(h);
    expect(await status(h)).toBe('stopped');
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toBeUndefined();

    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'scope-preview', choice: 'looks-right', actor: REPORTER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });
    await wf.drain();
    now += DAY + 1;
    await wf.drain(); // the parked job's timeout is re-delivered and ends without appending

    expect(await types(h)).toEqual(['captured', 'context-assembled', 'waiting-changed', 'stopped']);
    expect(await outbox()).toEqual([]);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview']);
    expect(h.adapter.statuses).toEqual([]);
    expect(await status(h)).toBe('stopped');
  });

  it('refuses Fix it on a level 1 fix preview after a stop and queues no create-issue on its timeout', async () => {
    const h = setup({ level: 1 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview', 'fix-preview']);

    await stop(h, 'stop on the fix preview');
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'fix-preview', choice: 'approve_fix', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });
    now += DAY + 1;
    await wf.drain();

    expect((await types(h)).slice(-3)).toEqual(['planned', 'waiting-changed', 'stopped']);
    expect(await outbox()).toEqual([]);
  });

  it('runs no after-filed step when a create-issue row queued before the stop lands as filed', async () => {
    const h = setup({ level: 2 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(await types(h)).toEqual([...PREFIX, 'planned']);

    await stop(h);
    await file(h, 'APP-110');
    expect((await types(h)).slice(-2)).toEqual(['stopped', 'filed']);
    expect(await status(h)).toBe('filed');
    expect(await outbox()).toEqual([]); // no In Progress transition, so no fixer
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview']);
    expect(h.adapter.statuses).toEqual([]);
  });

  it('a stop between filed and the after-filed step leaves the issue in Backlog (#206)', async () => {
    const h = setup({ level: 2 });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    const rows = await outbox();
    expect(rows.find((r) => r.op === 'create-issue')?.batchKey).toBe(jiraCreateBatchKey(h.payload.eventId));
    await state.ackOutbox(rows.map((r) => r.id));
    const log = await events(h);
    await state.append(h.payload.eventId, [{ workspaceId: WS, incidentId: h.payload.eventId, type: 'filed', v: 1, source: 'jira', occurredAt: new Date(now).toISOString(), payload: { jiraKey: 'APP-111' } }], log.length);
    await stop(h);
    await h.engine.continueIncident(h.payload.eventId);
    await wf.drain();

    expect((await types(h)).slice(-3)).toEqual(['filed', 'stopped', 'waiting-changed']);
    // The stop's own projection moves the issue back to Backlog; the engine queues no In Progress, so no fixer.
    expect((await outbox()).filter((r) => r.op === 'transition').map((r) => r.payload.to)).toEqual(['backlog']);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['scope-preview']); // no fix preview
  });
});

// #114: the full plan is an artifact, so a parked level 1 job files the ticket triage wrote.
describe('stored triage plan (#114)', () => {
  const WRITE_UP = 'Opening Settings crashes the app on Android.\n\nIt started after the 4.2 release.';

  it('files a level 1 ticket after the tap with the triage write-up and the suggested assignee', async () => {
    const h = setup({ level: 1, triage: { description: WRITE_UP, suggestedAssigneeEmail: 'marcus@example.com' } });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    const planned = eventOf(await events(h), 'planned');
    const ref = planned?.payload.plan;
    expect(ref).toBeDefined();
    const artifact = await state.getArtifact(ref?.artifactId ?? '', ref?.version);
    expect(artifact).toMatchObject({ kind: 'plan', contentType: 'application/json' });
    expect(JSON.parse(artifact.body)).toMatchObject({ suggestedAssigneeEmail: 'marcus@example.com', projectKey: 'APP', autonomyLevel: 1 });

    // The job parked on the fix preview; the tap resumes it with only the log to go on.
    await tap(h, 'fix-preview', 'ticket_only', ENGINEER);
    const [create] = await outbox();
    const row = create?.payload as unknown as CreateRow;
    expect(row.suggestedAssigneeEmail).toBe('marcus@example.com');
    expect(paragraphs(row)).toEqual(expect.arrayContaining(['Opening Settings crashes the app on Android.', 'It started after the 4.2 release.']));
  });

  it('shows the stored plan in the informational fix preview after filed (level 2)', async () => {
    const h = setup({ level: 2, triage: { description: WRITE_UP, suggestedAssigneeEmail: 'marcus@example.com' } });
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    await file(h, 'APP-110');
    const preview = h.adapter.cards[1];
    expect(preview?.kind).toBe('fix-preview');
    expect(preview?.kind === 'fix-preview' ? preview.plan : undefined).toMatchObject({
      suggestedAssigneeEmail: 'marcus@example.com',
      descriptionAdf: { content: [{ content: [{ text: 'Opening Settings crashes the app on Android.' }] }, { content: [{ text: 'It started after the 4.2 release.' }] }] },
    });
  });
});

// #115: an unresolved surface is asked about; the answer routes the ticket, a timeout degrades it.
describe('unresolved surface (#115)', () => {
  const VAGUE = message('m1', 0, 'it crashes when I open settings');
  const SURFACE_QUESTION = {
    audience: 'reporter',
    kind: 'experiential',
    asks: 'surface',
    text: 'Were you on the website, the phone app, or the admin portal?',
    options: ['Website', 'Mobile App', 'B2B Admin Portal'],
    screenshotRequest: false,
  };
  const scene = (extra: Scene = {}): Scene => ({
    anchor: VAGUE,
    channel: 'C0RANDOM',
    resolve: { surfaceId: 'unknown', confidence: 0 },
    clarify: SURFACE_QUESTION,
    ...extra,
  });

  async function toQuestion(h: Harness): Promise<void> {
    await inbound(h);
    await tap(h, 'scope-preview', 'looks-right');
    expect(eventOf(await events(h), 'resolved')?.payload).toEqual({ resolvedBy: 'unresolved', confidence: 0 });
    expect(h.adapter.cards.at(-1)).toMatchObject({ kind: 'clarify', question: { asks: 'surface', options: SURFACE_QUESTION.options } });
  }

  it("an experiential question on a post an engineer flagged waits on the post's author (#365)", async () => {
    const h = setup(scene());
    h.payload.reporter = { id: 'U-FAKE-ENG', name: 'mobDev', role: 'engineer' };
    h.payload.anchorAuthor = { id: REPORTER.id, name: 'Pat', role: 'reporter' };
    await toQuestion(h);
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toMatchObject({ kind: 'human', who: REPORTER.id });
  });

  it('with no anchorAuthor the question waits on the reporter as before (#365)', async () => {
    const h = setup(scene());
    await toQuestion(h);
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toMatchObject({ kind: 'human', who: REPORTER.id });
  });

  it('resolves the surface from the answer and files the ticket to that project', async () => {
    const h = setup(scene());
    await toQuestion(h);
    await tap(h, 'clarify', 'Website');
    const log = await events(h);
    expect(eventOf(log, 'clarify-answered')?.payload).toMatchObject({ answer: 'Website', appliesTo: { field: 'surface', id: 'web' } });
    const resolved = log.filter((e): e is IncidentEvent<'resolved'> => e.type === 'resolved').at(-1);
    expect(resolved?.payload).toEqual({ surfaceId: 'web', ownerId: 'webDev1', repo: 'github.com/acme/web', jiraProject: 'WEB', resolvedBy: 'clarify', confidence: 0.9 });
    expect(eventOf(log, 'planned')?.payload.degraded).toBeUndefined();
    const [create] = await outbox();
    const row = create?.payload as unknown as CreateRow;
    expect(row.fields.project.key).toBe('WEB');
    expect(row.fields.labels).toContain('web');
    expect(row.fields.labels).not.toContain('needs-clarification');
  });

  it('files an incident still unresolved after the timeout to the fallback project, ticket only, and says so', async () => {
    const h = setup(scene({ level: 2 }));
    await toQuestion(h);
    now += DAY + 1;
    await wf.drain(); // nobody answers
    expect((await types(h)).slice(-3)).toEqual(['waiting-changed', 'waiting-changed', 'planned']);
    const planned = eventOf(await events(h), 'planned');
    expect(planned?.payload).toMatchObject({ projectKey: 'WEB', autonomyLevel: 0, degraded: 'unresolved-surface' });
    expect(planned?.payload.labels).toContain('needs-clarification');
    expect(await status(h)).toBe('planned');

    const [create] = await outbox();
    const row = create?.payload as unknown as CreateRow;
    expect(row.fields.project.key).toBe('WEB');
    expect(row.fields.labels).toContain('needs-clarification');
    expect(row.customFields['Autonomy Level']).toBe(0);
    expect(paragraphs(row)).toContainEqual(expect.stringContaining('could not tell which product this report is about'));

    await file(h, 'WEB-120');
    expect(await outbox()).toEqual([]); // ticket only: no transition, whatever the policy said
    expect(h.adapter.statuses.at(-1)?.text).toBe('Filed as WEB-120. I could not tell which product this is about, so it is in WEB for someone to route.');
  });

  it('takes the map fallback surface over the first-surface rule (#118)', async () => {
    const h = setup(scene({ fallbackSurface: 'admin' }));
    await toQuestion(h);
    now += DAY + 1;
    await wf.drain();
    expect(eventOf(await events(h), 'planned')?.payload).toMatchObject({ projectKey: 'ADM', degraded: 'unresolved-surface' });
    const [create] = await outbox();
    expect((create?.payload as unknown as CreateRow).fields.project.key).toBe('ADM');
  });

  it('takes the install fallback project over the map fallback surface', async () => {
    const h = setup(scene({ fallbackSurface: 'admin', options: { fallbackJiraProject: 'OPS' } }));
    await toQuestion(h);
    now += DAY + 1;
    await wf.drain();
    expect(eventOf(await events(h), 'planned')?.payload).toMatchObject({ projectKey: 'OPS' });
  });

  it('takes the install fallback project when one is set', async () => {
    const h = setup(scene({ options: { fallbackJiraProject: 'ADM' } }));
    await toQuestion(h);
    now += DAY + 1;
    await wf.drain();
    const [create] = await outbox();
    expect((create?.payload as unknown as CreateRow).fields.project.key).toBe('ADM');
  });
});
