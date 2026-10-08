// The user-side check before filing (A 5.2, main 7.2). A screenshot reading with a user-side
// indicator at or above the playbook's confidence floor turns the ask-back round into one favor with
// That fixed it / Still broken / I meant <env>. The engine runs on the in-process workflow over a real
// store (SNAPWING_DB picks the dialect) with a scripted model and a fake chat adapter, as in
// engine.test.ts and claims.test.ts; the Jira outbox worker is simulated by reading the outbox.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  ANSWER_FIXED,
  ANSWER_STILL_BROKEN,
  checkRecord,
  checkText,
  fixedNote,
  pickIndicator,
  readAnswer,
  ticketNote,
  userSideCheck,
  type CheckBudget,
} from '../../src/clarify/user-side.ts';
import { defaultPlaybook, type Playbook } from '../../src/config/playbook.ts';
import type { ChatReader } from '../../src/context/chat-reader.ts';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '../../src/contracts/adapters.ts';
import type { EventActor, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload, ContextBundle, ImageReading, SourceMessage, UserSideIndicator } from '../../src/contracts/incident.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { CardKind } from '../../src/engine/cursor.ts';
import type { EngineDeps } from '../../src/engine/deps.ts';
import { IncidentOrchestrator } from '../../src/engine/orchestrator.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { withValidation } from '../../src/models/router.ts';
import { USER_SIDE_KINDS } from '../../src/models/user-side.ts';
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
const REPORTER: EventActor = { id: 'U0SALESLEAD', role: 'reporter', name: 'Pat' };
const REPORTER_NAME = 'Pat Example';
const SHOT = 'https://files.example.test/T1/cart.png';
const STAGING: UserSideIndicator = { kind: 'wrong-environment', evidence: 'URL bar shows staging.example.test.', confidence: 0.92 };
const NEVER = /user error|mistake|your fault|wrong of you/i;

function at(minutes: number): string {
  return new Date(T0.getTime() + minutes * 60_000).toISOString();
}

const ANCHOR: SourceMessage = {
  id: 'm1',
  authorId: REPORTER.id,
  text: 'the cart total is blank',
  timestamp: at(0),
  replyCount: 0,
  mentions: [],
  reactions: [],
  attachments: [{ kind: 'image', url: SHOT, mimeType: 'image/png' }],
};

const TRIAGE = { action: 'create_issue', issueType: 'Bug', summary: 'Cart total is blank', description: 'The cart total shows nothing.', priority: 'Medium', labels: ['cart'] };

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

/** Classify by task (no `clarify`: a gap question asked by the model would fail the job); one vision reading. */
function scriptedModel(reading: ImageReading, answers: Record<string, unknown>): ModelBackend & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    complete: () => Promise.reject(new Error('complete is not scripted')),
    vision: () => Promise.resolve({ model: 'scripted/test', readings: [reading] }),
    classify(request: ClassifyRequest<unknown>) {
      tasks.push(request.task);
      if (!(request.task in answers)) return Promise.reject(new Error(`classify ${request.task} is not scripted`));
      return Promise.resolve({ value: answers[request.task], model: 'scripted/test' });
    },
  };
}

function readingWith(indicators: UserSideIndicator[], extra: Partial<ImageReading> = {}): ImageReading {
  return { surfaceSignals: {}, uiElements: [], plainDescription: 'the cart total is blank', sensitive: false, userSideIndicators: indicators, ...extra };
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
  reading?: ImageReading;
  /** C0APPBUGS (mobile, no component gap) by default; C0WEBBUGS leaves a component gap. */
  channel?: string;
  playbook?: Playbook;
  askBack?: { maxQuestionsPerIncident: number; suppressWhenReportersAtLeast: number };
  reportersInWindow?: number;
}

interface Harness {
  engine: IncidentOrchestrator;
  adapter: FakeAdapter;
  model: ReturnType<typeof scriptedModel>;
  id: string;
}

function setup(scene: Scene = {}): Harness {
  const adapter = new FakeAdapter();
  const model = scriptedModel(scene.reading ?? readingWith([STAGING]), { segmentation: { included: ['m1'], excluded: [], resolutionMessageId: '' }, triage: TRIAGE });
  if (!(state instanceof StateStore)) throw new Error('expected a StateStore');
  const map: WorkspaceMap = {
    ...baseMap,
    policies: {
      ...baseMap.policies,
      autonomy: { ...baseMap.policies.autonomy, default: 0, overrides: [] },
      ...(scene.askBack === undefined ? {} : { askBack: scene.askBack }),
    },
  };
  const reporters = scene.reportersInWindow;
  const deps: EngineDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    model: withValidation(model),
    adapters: new Map([['slack', adapter]]),
    context: new Map([['slack', { reader: fakeReader([ANCHOR]), anchor: (p) => Promise.resolve({ channelId: p.context.channelId, message: ANCHOR }) }]]),
    jiraSearch: { search: () => Promise.resolve([]) },
    cache: createKvCache(state),
    map,
    ...(scene.playbook === undefined ? {} : { playbook: () => scene.playbook as Playbook }),
    ...(reporters === undefined ? {} : { evidence: () => Promise.resolve({ reportersInWindow: reporters }) }),
    clock: () => new Date(now),
    options: { loadImage: (a) => Promise.resolve({ mimeType: 'image/png', data: 'AAAA', ref: a.url }) },
  };
  const engine = new IncidentOrchestrator(deps);
  engine.register();
  return { engine, adapter, model, id: ulid(T0.getTime()) };
}

async function inbound(h: Harness, channel = 'C0APPBUGS'): Promise<void> {
  const payload: CanonicalIncidentPayload = {
    eventId: h.id,
    idempotencyKey: `slack-${channel}-${ANCHOR.id}`,
    source: 'slack',
    reporter: { id: REPORTER.id, name: REPORTER_NAME, role: 'reporter' },
    anchorText: ANCHOR.text,
    context: { channelId: channel, deepLink: 'https://example.test/archives/C0APPBUGS/p1', rawPayloadSnapshot: { ts: ANCHOR.id } },
    timestamp: ANCHOR.timestamp,
  };
  await h.engine.handleInbound('slack', payload);
  await wf.drain();
  await tap(h, 'scope-preview', 'looks-right');
}

async function tap(h: Harness, card: CardKind, choice: string): Promise<void> {
  expect(await h.engine.handleTap({ eventId: h.id, card, choice, actor: { id: REPORTER.id, role: 'reporter' } })).toEqual({ accepted: true, resumed: true });
  await wf.drain();
}

async function log(h: Harness): Promise<IncidentEvent[]> {
  return state.read(h.id);
}

async function types(h: Harness): Promise<EventType[]> {
  return (await log(h)).map((e) => e.type);
}

function eventOf<T extends EventType>(events: IncidentEvent[], type: T): IncidentEvent<T> | undefined {
  return events.find((e) => e.type === type) as IncidentEvent<T> | undefined;
}

async function rows(): Promise<OutboxItem[]> {
  return state.drainOutbox('jira', 50);
}

interface CreateRow {
  fields: { labels: string[]; description: unknown };
}

async function created(): Promise<{ labels: string[]; description: string }> {
  const create = (await rows()).find((r) => r.op === 'create-issue');
  expect(create).toBeDefined();
  const row = create?.payload as unknown as CreateRow;
  return { labels: row.fields.labels, description: JSON.stringify(row.fields.description) };
}

function clarifyCards(h: Harness): Extract<InteractiveCard, { kind: 'clarify' }>[] {
  return h.adapter.cards.filter((c): c is Extract<InteractiveCard, { kind: 'clarify' }> => c.kind === 'clarify');
}

const CHECK_TEXT = 'Before I file this, one thing in your screenshot: URL bar shows staging.example.test. That looks like the test site. Could you try the same thing on the live site?';

// Engine ------------------------------------------------------------------------------------------

describe('the user-side check before filing (A 5.2)', () => {
  it('asks one favor with That fixed it, Still broken, I meant staging, recorded as the ask-back round', async () => {
    const h = setup();
    await inbound(h);
    const [card, ...more] = clarifyCards(h);
    expect(more).toEqual([]);
    expect(card?.question).toEqual({
      audience: 'reporter',
      text: CHECK_TEXT,
      options: ['That fixed it', 'Still broken', 'I meant staging'],
      asks: 'other',
      gatePassed: true,
      gateFailures: [],
    });
    expect(card?.question.text).not.toMatch(NEVER);
    const clarified = eventOf(await log(h), 'clarified');
    expect(clarified?.payload).toEqual({
      audience: 'reporter',
      question: CHECK_TEXT,
      asks: 'other',
      options: ['That fixed it', 'Still broken', 'I meant staging'],
      userSide: { kind: 'wrong-environment', evidence: 'URL bar shows staging.example.test', environment: 'staging' },
      timedOut: false,
    });
    expect((await state.getIncident(h.id))?.waitingOn).toMatchObject({ kind: 'human', who: REPORTER.id });
    expect(await rows()).toEqual([]);
  });

  it('That fixed it: no ticket, a user-side event with the kind, a friendly note, nothing for Jira', async () => {
    const h = setup();
    await inbound(h);
    await tap(h, 'clarify', ANSWER_FIXED);

    expect((await types(h)).slice(-5)).toEqual(['waiting-changed', 'tapped', 'clarify-answered', 'waiting-changed', 'user-side']);
    const events = await log(h);
    const clarified = eventOf(events, 'clarified');
    const userSide = eventOf(events, 'user-side');
    expect(userSide?.payload).toEqual({ kind: 'wrong-environment', evidence: 'URL bar shows staging.example.test', questionSeq: clarified?.seq, surfaceId: 'mobile' });
    expect(userSide?.actor).toMatchObject({ id: REPORTER.id });
    expect(eventOf(events, 'planned')).toBeUndefined();
    expect(await state.getIncident(h.id)).toMatchObject({ status: 'not-filed' });

    // No Jira row at all, so the reporter's name reaches no issue.
    const jira = await rows();
    expect(jira).toEqual([]);
    expect(JSON.stringify(jira)).not.toContain(REPORTER_NAME);
    expect(h.model.tasks).not.toContain('triage');

    expect(h.adapter.statuses.map((s) => s.text)).toEqual(['Great, no bug then. Flagging that the staging link is easy to land on.']);
    expect(h.adapter.statuses[0]?.text).not.toMatch(NEVER);

    // The job is done: a resumed delivery appends nothing.
    await h.engine.continueIncident(h.id);
    await wf.drain();
    expect((await types(h)).at(-1)).toBe('user-side');
  });

  it('Still broken: files normally with the check recorded on the ticket', async () => {
    const h = setup();
    await inbound(h);
    await tap(h, 'clarify', ANSWER_STILL_BROKEN);

    expect((await types(h)).slice(-4)).toEqual(['tapped', 'clarify-answered', 'waiting-changed', 'planned']);
    const answered = eventOf(await log(h), 'clarify-answered');
    expect(answered?.payload).toMatchObject({ answer: 'Still broken' });
    expect(eventOf(await log(h), 'user-side')).toBeUndefined();
    const { labels, description } = await created();
    expect(labels).not.toContain('needs-clarification');
    expect(description).toContain(
      'Already checked before filing: the screenshot showed URL bar shows staging.example.test, so the reporter was asked to try the same thing on the live site. Still broken.',
    );
    expect(description).not.toMatch(NEVER);
  });

  it('I meant staging: files with the environment set', async () => {
    const h = setup();
    await inbound(h);
    await tap(h, 'clarify', 'I meant staging');

    expect((await types(h)).at(-1)).toBe('planned');
    const { description } = await created();
    expect(description).toContain('The reporter confirmed this is on staging (the screenshot showed URL bar shows staging.example.test).');
    // The Environment line: the surface, then the confirmed environment.
    expect(description).toContain('Mobile App, staging, reported via slack');
  });

  it('a timed out check files normally, notes that no answer came, and adds no needs-clarification', async () => {
    const h = setup();
    await inbound(h);
    now += DAY + 1;
    await wf.drain(); // the check times out

    expect((await types(h)).slice(-2)).toEqual(['waiting-changed', 'planned']);
    const { labels, description } = await created();
    expect(labels).not.toContain('needs-clarification');
    expect(description).toContain('no answer came back');
  });

  it('is the one question: a component gap goes unasked (no model clarify call) and the ticket gets needs-clarification', async () => {
    const h = setup();
    await inbound(h, 'C0WEBBUGS');
    expect(clarifyCards(h)).toHaveLength(1);
    await tap(h, 'clarify', ANSWER_STILL_BROKEN);
    expect(h.model.tasks).not.toContain('clarify');
    expect((await types(h)).filter((t) => t === 'clarified')).toHaveLength(1);
    expect((await created()).labels).toContain('needs-clarification');
  });

  it('counts against the ask-back budget: with a budget of 0 nothing is asked and it files as usual', async () => {
    const h = setup({ askBack: { maxQuestionsPerIncident: 0, suppressWhenReportersAtLeast: 3 } });
    await inbound(h);
    expect(clarifyCards(h)).toEqual([]);
    expect(await types(h)).not.toContain('clarified');
    expect((await types(h)).at(-1)).toBe('planned');
  });

  it('follows the volume rule: three reporters make it an incident, not a question', async () => {
    const h = setup({ reportersInWindow: 3 });
    await inbound(h);
    expect(clarifyCards(h)).toEqual([]);
    expect((await types(h)).at(-1)).toBe('planned');
  });

  it('is off with userSide check="false"', async () => {
    const off = defaultPlaybook();
    off.userSide.check = false;
    const h = setup({ playbook: off });
    await inbound(h);
    expect(clarifyCards(h)).toEqual([]);
    expect((await types(h)).at(-1)).toBe('planned');
  });

  it('skips an indicator under the confidence floor', async () => {
    const low = setup({ reading: readingWith([{ ...STAGING, confidence: 0.6 }]) });
    await inbound(low);
    expect(clarifyCards(low)).toEqual([]);
    expect((await types(low)).at(-1)).toBe('planned');
  });
});

// The check itself ---------------------------------------------------------------------------------

const BUDGET: CheckBudget = { maxQuestionsPerIncident: 1, suppressWhenReportersAtLeast: 3, questionsAsked: 0, reportersInWindow: 1 };

function bundleWith(...readings: ImageReading[]): ContextBundle {
  return {
    anchorId: 'm1',
    included: [{ ...ANCHOR, attachments: readings.map((reading, i) => ({ kind: 'image' as const, url: `${SHOT}?${i}`, reading })) }],
    excluded: [],
    windowUsed: { oldest: at(0), latest: at(0), cap: 40 },
  };
}

describe('userSideCheck', () => {
  it('reads the floor from signals/lexicon/@confidenceFloor and picks the strongest indicator', () => {
    const playbook = defaultPlaybook();
    const account: UserSideIndicator = { kind: 'wrong-account', evidence: 'header shows another account', confidence: 0.6 };
    expect(userSideCheck(bundleWith(readingWith([account])), playbook, BUDGET)).toBeUndefined();
    playbook.signals.lexicon.confidenceFloor = 0.5;
    expect(userSideCheck(bundleWith(readingWith([account])), playbook, BUDGET)?.record.kind).toBe('wrong-account');
    expect(pickIndicator(bundleWith(readingWith([account]), readingWith([STAGING])), 0.5)?.indicator).toEqual(STAGING);
    // At the floor counts.
    expect(pickIndicator(bundleWith(readingWith([{ ...account, confidence: 0.5 }])), 0.5)).toBeDefined();
  });

  it('never quotes a sensitive reading', () => {
    expect(userSideCheck(bundleWith(readingWith([STAGING], { sensitive: true })), defaultPlaybook(), BUDGET)).toBeUndefined();
  });

  it('fails the gate on budget and volume, listing why', () => {
    const spent = userSideCheck(bundleWith(readingWith([STAGING])), defaultPlaybook(), { ...BUDGET, questionsAsked: 1 });
    expect(spent?.question.gatePassed).toBe(false);
    expect(spent?.question.gateFailures.join(' ')).toContain('budget-exceeded');
    const loud = userSideCheck(bundleWith(readingWith([STAGING])), defaultPlaybook(), { ...BUDGET, reportersInWindow: 3 });
    expect(loud?.question.gateFailures.join(' ')).toContain('suppressed-by-volume');
  });

  it('offers I meant <env> only when the screenshot names an environment', () => {
    const plain = userSideCheck(bundleWith(readingWith([{ kind: 'wrong-environment', evidence: 'URL bar shows a different address', confidence: 0.9 }])), defaultPlaybook(), BUDGET);
    expect(plain?.question.options).toEqual(['That fixed it', 'Still broken']);
    expect(plain?.question.gatePassed).toBe(true);
    const local = userSideCheck(bundleWith(readingWith([{ kind: 'wrong-environment', evidence: 'URL bar shows localhost:3000', confidence: 0.9 }])), defaultPlaybook(), BUDGET);
    expect(local?.question.options).toEqual(['That fixed it', 'Still broken', 'I meant localhost']);
  });

  it('passes the gate for every indicator kind and never says "user error"', () => {
    for (const kind of USER_SIDE_KINDS) {
      // Evidence quotes the reporter's screen, technical words included; the favor itself stays plain.
      const indicator: UserSideIndicator = { kind, evidence: 'URL bar shows staging.example.test with a server error banner', confidence: 0.9 };
      const check = userSideCheck(bundleWith(readingWith([indicator])), defaultPlaybook(), BUDGET);
      expect(check?.question.gateFailures, kind).toEqual([]);
      const record = checkRecord(indicator);
      for (const text of [checkText(record), fixedNote(record), ticketNote(record, undefined), ticketNote(record, readAnswer(record, ANSWER_STILL_BROKEN))]) {
        expect(text, kind).not.toMatch(NEVER);
      }
    }
  });

  it('reads answers: an unknown answer files normally', () => {
    const record = checkRecord(STAGING);
    expect(readAnswer(record, 'that fixed it')).toEqual({ kind: 'fixed' });
    expect(readAnswer(record, 'I meant staging')).toEqual({ kind: 'meant', environment: 'staging' });
    expect(readAnswer(record, 'I meant production')).toEqual({ kind: 'still-broken' });
  });
});
