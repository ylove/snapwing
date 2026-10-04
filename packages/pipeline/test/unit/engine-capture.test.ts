// Lookup-first for capture sources (#377, main 15.3, 15.4, 14.2): a Raycast or CLI capture has no scope
// card and, after resolve and dedupe, shows exactly one of the dedupe card, `file-confirm`, or the
// surface question. Cancel and every timeout end it `not-filed` with no Jira row. The process job runs
// on the in-process WorkflowPort over a real state store (SNAPWING_DB picks the dialect); the adapter,
// Jira search, repo trees, and the model are fakes, as in engine.test.ts.

import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { IngestionAdapter, InteractiveCard, StatusUpdate } from '../../src/contracts/adapters.ts';
import type { EventActorRole, EventType, IncidentEvent } from '../../src/contracts/events.ts';
import type { CanonicalIncidentPayload, ChannelSource } from '../../src/contracts/incident.ts';
import type { OutboxItem } from '../../src/contracts/state.ts';
import type { JiraSearchHit } from '../../src/dedupe/index.ts';
import type { CardKind } from '../../src/engine/cursor.ts';
import { captureIdempotencyKey, idempotencyTtlSec, RAYCAST_IDEMPOTENCY_TTL_SEC, type EngineDeps } from '../../src/engine/deps.ts';
import { IncidentOrchestrator, type TapInput } from '../../src/engine/orchestrator.ts';
import { hintedResolution, SURFACE_QUESTION } from '../../src/engine/steps.ts';
import { parseWorkspaceMap } from '../../src/map/parse.ts';
import type { WorkspaceMap } from '../../src/map/types.ts';
import { withValidation } from '../../src/models/router.ts';
import type { ClassifyRequest, ModelBackend } from '../../src/ports/model.ts';
import type { OpenedState } from '../../src/ports/state.ts';
import { createKvCache } from '../../src/providers/local/cache.ts';
import type { RepoTrees } from '../../src/resolve/paths.ts';
import { StateStore } from '../../src/state/store.ts';
import { ulid } from '../../src/util/ulid.ts';
import { InProcessWorkflow } from '../../src/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../helpers/db.ts';

const exampleXml = readFileSync(fileURLToPath(new URL('../../../../examples/workspace-context.example.xml', import.meta.url)), 'utf8');

const T0 = new Date('2026-10-03T09:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const WS = '01K6WORKSPACE0000000000000';
const ENGINEER = { id: 'U0WEBDEV1', role: 'engineer' as EventActorRole };
const LABELS = ['Website', 'Mobile App', 'B2B Admin Portal'];

/** "the app" is the example map's vocabulary for the mobile surface. */
const APP_TEXT = 'the app crashes when I open settings';
/** Names nothing the map knows: resolve falls to the model, which answers unknown. */
const VAGUE_TEXT = 'the total is blank after applying a promo code';
const TRACE = 'TypeError: Cannot read properties of undefined\n    at total (/usr/src/app/src/cart/total.ts:42:7)';

// Fakes -------------------------------------------------------------------------------------------

class FakeCaptureAdapter implements IngestionAdapter<CanonicalIncidentPayload, { status: number }> {
  readonly cards: InteractiveCard[] = [];
  readonly statuses: StatusUpdate[] = [];
  constructor(readonly channelSource: ChannelSource) {}
  authenticateRequest(): Promise<boolean> {
    return Promise.resolve(true);
  }
  normalizePayload(raw: CanonicalIncidentPayload): Promise<CanonicalIncidentPayload> {
    return Promise.resolve(raw);
  }
  acknowledge(): Promise<{ status: number }> {
    return Promise.resolve({ status: 202 });
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

function scriptedModel(answers: Partial<Record<string, unknown>>): ModelBackend & { tasks: string[] } {
  const tasks: string[] = [];
  return {
    tasks,
    complete: () => Promise.reject(new Error('complete is not scripted')),
    vision: () => Promise.reject(new Error('vision is not scripted')),
    classify(request: ClassifyRequest<unknown>) {
      const key = `${request.task}:${request.schemaName}`;
      tasks.push(key);
      if (key in answers) return Promise.resolve({ value: answers[key], model: 'scripted/test' });
      if (!(request.task in answers)) return Promise.reject(new Error(`classify ${key} is not scripted`));
      return Promise.resolve({ value: answers[request.task], model: 'scripted/test' });
    },
  };
}

const TRIAGE = {
  action: 'create_issue',
  issueType: 'Bug',
  summary: 'Settings crashes the app',
  description: 'Opening Settings crashes the app.',
  priority: 'Medium',
  labels: ['crash'],
};

// Harness -----------------------------------------------------------------------------------------

let baseMap: WorkspaceMap;
beforeAll(async () => {
  const parsed = await parseWorkspaceMap(exampleXml);
  // Level 0 everywhere: the lookup is what is under test, not the fix preview.
  baseMap = { ...parsed, policies: { ...parsed.policies, autonomy: { ...parsed.policies.autonomy, default: 0, overrides: [] } } };
});

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0.getTime();
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
  source?: 'cli' | 'raycast';
  text?: string;
  surfaceHint?: string;
  jira?: JiraSearchHit[];
  trees?: Record<string, readonly string[]>;
  /** Layer 1 evidence that would suppress any gated ask-back (more reporters than the map allows). */
  crowd?: boolean;
}

interface Harness {
  engine: IncidentOrchestrator;
  deps: EngineDeps;
  adapter: FakeCaptureAdapter;
  model: ReturnType<typeof scriptedModel>;
  jql: string[];
  treeReads: string[];
  payload: CanonicalIncidentPayload;
}

function capturePayload(source: 'cli' | 'raycast', text: string, surfaceHint?: string, at = T0.getTime()): CanonicalIncidentPayload {
  return {
    eventId: ulid(at),
    idempotencyKey: captureIdempotencyKey(source, text),
    source,
    reporter: { id: 'webDev1', name: 'Dana', email: 'dana@example.com', role: 'engineer' },
    anchorText: text,
    context: { channelId: `${source}:webDev1`, ...(surfaceHint === undefined ? {} : { surfaceHint }), rawPayloadSnapshot: { text } },
    timestamp: new Date(at).toISOString(),
  };
}

function setup(scene: Scene = {}): Harness {
  const source = scene.source ?? 'cli';
  const adapter = new FakeCaptureAdapter(source);
  const model = scriptedModel({ 'triage:resolution': { surfaceId: 'unknown', confidence: 0 }, triage: TRIAGE, clarify: { ask: false } });
  const jql: string[] = [];
  const treeReads: string[] = [];
  const repoTrees: RepoTrees = (repo) => {
    treeReads.push(repo);
    return Promise.resolve(scene.trees?.[repo]);
  };
  if (!(state instanceof StateStore)) throw new Error('expected a StateStore');
  const deps: EngineDeps = {
    workspaceId: WS,
    state,
    workflow: wf,
    model: withValidation(model),
    adapters: new Map([[source, adapter]]),
    jiraSearch: {
      search(q) {
        jql.push(q);
        return Promise.resolve(scene.jira ?? []);
      },
    },
    cache: createKvCache(state),
    map: baseMap,
    repoTrees,
    clock: () => new Date(now),
    ...(scene.crowd === true ? { evidence: () => Promise.resolve({ reportersInWindow: 9 }) } : {}),
  };
  const engine = new IncidentOrchestrator(deps);
  engine.register();
  const payload = capturePayload(source, scene.text ?? APP_TEXT, scene.surfaceHint);
  return { engine, deps, adapter, model, jql, treeReads, payload };
}

async function inbound(h: Harness, payload = h.payload): Promise<void> {
  expect(await h.engine.handleInbound(payload.source, payload)).toEqual({ status: 202 });
  await wf.drain();
}

async function tap(h: Harness, card: CardKind, choice: string, actor: TapInput['actor'] = ENGINEER): Promise<void> {
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

/** Every Jira row the engine enqueued (lifecycle field rows only follow `filed`, which no test appends). */
function jiraRows(): Promise<OutboxItem[]> {
  return state.drainOutbox('jira', 50);
}

function eventOf<T extends EventType>(log: IncidentEvent[], type: T): IncidentEvent<T> | undefined {
  return log.findLast((e) => e.type === type) as IncidentEvent<T> | undefined;
}

const LOOKUP: EventType[] = ['captured', 'context-assembled', 'resolved', 'dedupe-checked', 'waiting-changed'];

/** The project key of the one create-issue row. */
async function filedProject(): Promise<string | undefined> {
  const rows = await jiraRows();
  expect(rows.map((r) => r.op)).toEqual(['create-issue']);
  return (rows[0]?.payload as { fields: { project: { key: string } } }).fields.project.key;
}

// Tests -------------------------------------------------------------------------------------------

describe('file-confirm: new, and the surface resolved', () => {
  it('has no scope card and no ask-back: resolve, dedupe, then the one card; File it files', async () => {
    const h = setup();
    await inbound(h);
    expect(await types(h)).toEqual(LOOKUP);
    expect(h.adapter.cards).toEqual([{ kind: 'file-confirm', surfaceId: 'mobile', surfaceLabel: 'Mobile App' }]);
    expect(h.jql.length).toBeGreaterThan(0); // dedupe ran
    expect(await jiraRows()).toEqual([]); // a lookup, not a ticket
    expect((await state.getIncident(h.payload.eventId))?.waitingOn).toMatchObject({ kind: 'human', who: 'webDev1' });

    await tap(h, 'file-confirm', 'file-it');
    expect(await types(h)).toEqual([...LOOKUP, 'tapped', 'planned']);
    expect(await status(h)).toBe('planned');
    expect(await filedProject()).toBe('APP');
    expect(h.adapter.cards).toHaveLength(1);
    expect(h.model.tasks.some((t) => t.startsWith('clarify'))).toBe(false);
  });

  it('a file path in the trace resolves against the repo trees and the card says where it came from', async () => {
    const h = setup({ source: 'raycast', text: TRACE, trees: { 'github.com/acme/web': ['src/cart/total.ts', 'src/index.ts'] } });
    await inbound(h);
    expect(h.treeReads).toContain('github.com/acme/web');
    const resolved = eventOf(await events(h), 'resolved');
    expect(resolved?.payload).toMatchObject({ surfaceId: 'web', resolvedBy: 'file-path', evidence: { path: 'src/cart/total.ts' } });
    expect(h.adapter.cards).toEqual([{ kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website', evidence: 'src/cart/total.ts' }]);
  });

  it('Not this surface asks the surface question; the answer re-resolves and files there', async () => {
    const h = setup();
    await inbound(h);
    await tap(h, 'file-confirm', 'not-this-surface');
    expect(await types(h)).toEqual([...LOOKUP, 'tapped', 'clarified']);
    expect(h.adapter.cards[1]).toEqual({
      kind: 'clarify',
      question: { audience: 'reporter', text: SURFACE_QUESTION, options: LABELS, asks: 'surface', gatePassed: true, gateFailures: [] },
    });

    await tap(h, 'clarify', 'B2B Admin Portal');
    const log = await events(h);
    expect(log.slice(-4).map((e) => e.type)).toEqual(['clarify-answered', 'resolved', 'waiting-changed', 'planned']);
    expect(eventOf(log, 'resolved')?.payload).toMatchObject({ surfaceId: 'admin', resolvedBy: 'clarify' });
    expect(await filedProject()).toBe('ADM');
    expect(h.adapter.cards).toHaveLength(2);
  });

  it('Cancel ends it not-filed with no Jira row', async () => {
    const h = setup();
    await inbound(h);
    await tap(h, 'file-confirm', 'cancel');
    const log = await events(h);
    expect(log.map((e) => e.type)).toEqual([...LOOKUP, 'tapped', 'waiting-changed', 'capture-cancelled']);
    const cancelled = eventOf(log, 'capture-cancelled');
    expect(cancelled?.payload).toEqual({ card: 'file-confirm' });
    expect(cancelled?.actor).toMatchObject({ id: ENGINEER.id });
    expect(await status(h)).toBe('not-filed');
    expect(await jiraRows()).toEqual([]);
    // Nothing is waiting any more.
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'file-confirm', choice: 'file-it', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'not-pending',
    });
  });

  it('a timeout files nothing, unlike chat where silence goes on', async () => {
    const h = setup();
    await inbound(h);
    now += DAY + 1;
    await wf.drain();
    expect(eventOf(await events(h), 'capture-cancelled')?.payload).toEqual({ card: 'file-confirm', timedOut: true });
    expect(await status(h)).toBe('not-filed');
    expect(await jiraRows()).toEqual([]);
    expect(h.adapter.cards).toHaveLength(1);
  });

  it('refuses a choice the card does not offer', async () => {
    const h = setup();
    await inbound(h);
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'file-confirm', choice: 'approve_fix', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'invalid-choice',
    });
  });
});

describe('the surface question: new, and the surface did not resolve', () => {
  it('lists the map surfaces, asked even when the ask-back gate would stay quiet', async () => {
    const h = setup({ text: VAGUE_TEXT, crowd: true });
    await inbound(h);
    expect(await types(h)).toEqual(['captured', 'context-assembled', 'resolved', 'dedupe-checked', 'clarified', 'waiting-changed']);
    expect(eventOf(await events(h), 'resolved')?.payload).toMatchObject({ resolvedBy: 'unresolved' });
    expect(h.adapter.cards).toEqual([
      { kind: 'clarify', question: { audience: 'reporter', text: SURFACE_QUESTION, options: LABELS, asks: 'surface', gatePassed: true, gateFailures: [] } },
    ]);

    // Free text is not a surface.
    expect(await h.engine.handleTap({ eventId: h.payload.eventId, card: 'clarify', choice: 'the checkout page', actor: ENGINEER })).toEqual({
      accepted: false,
      reason: 'invalid-choice',
    });
    await tap(h, 'clarify', 'Website');
    expect(eventOf(await events(h), 'resolved')?.payload).toMatchObject({ surfaceId: 'web', resolvedBy: 'clarify' });
    expect(await filedProject()).toBe('WEB');
    expect(h.adapter.cards).toHaveLength(1);
  });

  it('Cancel ends it not-filed', async () => {
    const h = setup({ text: VAGUE_TEXT });
    await inbound(h);
    await tap(h, 'clarify', 'cancel');
    expect(eventOf(await events(h), 'capture-cancelled')?.payload).toEqual({ card: 'clarify' });
    expect(await status(h)).toBe('not-filed');
    expect(await jiraRows()).toEqual([]);
  });

  it('a timeout files nothing', async () => {
    const h = setup({ text: VAGUE_TEXT });
    await inbound(h);
    now += DAY + 1;
    await wf.drain();
    expect((await types(h)).slice(-2)).toEqual(['waiting-changed', 'capture-cancelled']);
    expect(eventOf(await events(h), 'capture-cancelled')?.payload).toEqual({ card: 'clarify', timedOut: true });
    expect(await status(h)).toBe('not-filed');
    expect(await jiraRows()).toEqual([]);
  });
});

describe('the dedupe card: already tracked', () => {
  const HIT: JiraSearchHit = { key: 'APP-7', summary: 'The app crashes when I open settings', assignee: 'mobDev' };

  it('is the one card; Open it links the capture to the existing issue', async () => {
    const h = setup({ jira: [HIT] });
    await inbound(h);
    expect(h.adapter.cards).toEqual([{ kind: 'dedupe', issueKey: 'APP-7', summary: HIT.summary, assignee: 'mobDev' }]);
    await tap(h, 'dedupe', 'link');
    expect((await types(h)).slice(-2)).toEqual(['dedupe-decided', 'linked-to-existing']);
    expect(await status(h)).toBe('linked-to-existing');
    expect((await jiraRows()).map((r) => [r.op, (r.payload as { issueKey: string }).issueKey])).toEqual([['add-comment', 'APP-7']]);
  });

  it('Create anyway files with the resolved surface and shows no second card', async () => {
    const h = setup({ jira: [HIT] });
    await inbound(h);
    await tap(h, 'dedupe', 'create-anyway');
    expect((await types(h)).slice(-4)).toEqual(['tapped', 'dedupe-decided', 'waiting-changed', 'planned']);
    expect(await filedProject()).toBe('APP');
    expect(h.adapter.cards).toHaveLength(1);
  });

  it('Create anyway with no surface asks which surface', async () => {
    const h = setup({ text: VAGUE_TEXT, jira: [{ key: 'WEB-830', summary: 'The total is blank after applying a promo code' }] });
    await inbound(h);
    await tap(h, 'dedupe', 'create-anyway');
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['dedupe', 'clarify']);
    await tap(h, 'clarify', 'Website');
    expect(await filedProject()).toBe('WEB');
  });

  it('a timeout files nothing', async () => {
    const h = setup({ jira: [HIT] });
    await inbound(h);
    now += DAY + 1;
    await wf.drain();
    expect(eventOf(await events(h), 'capture-cancelled')?.payload).toEqual({ card: 'dedupe', timedOut: true });
    expect(await types(h)).not.toContain('dedupe-decided');
    expect(await status(h)).toBe('not-filed');
    expect(await jiraRows()).toEqual([]);
  });
});

describe('context.surfaceHint (--surface)', () => {
  it('skips inference and the question, and dedupe still runs', async () => {
    const h = setup({ text: VAGUE_TEXT, surfaceHint: 'web', trees: { 'github.com/acme/web': ['src/cart/total.ts'] } });
    await inbound(h);
    const log = await events(h);
    expect(eventOf(log, 'captured')?.payload.surfaceHint).toBe('web');
    expect(eventOf(log, 'resolved')?.payload).toEqual({ surfaceId: 'web', ownerId: 'webDev1', repo: 'github.com/acme/web', jiraProject: 'WEB', resolvedBy: 'surface-hint', confidence: 0.9 });
    expect(h.model.tasks).not.toContain('triage:resolution');
    expect(h.treeReads).toEqual([]);
    expect(h.jql.some((q) => q.includes('project = WEB') || q.includes('WEB'))).toBe(true);
    expect(h.adapter.cards).toEqual([{ kind: 'file-confirm', surfaceId: 'web', surfaceLabel: 'Website' }]);
  });

  it('still shows the dedupe card when the issue is already tracked', async () => {
    const h = setup({ surfaceHint: 'Mobile App', jira: [{ key: 'APP-7', summary: 'The app crashes when I open settings' }] });
    await inbound(h);
    expect(h.adapter.cards.map((c) => c.kind)).toEqual(['dedupe']);
  });

  it('matches a surface by id or label, ignoring case; an unknown hint resolves as usual', async () => {
    expect(hintedResolution(baseMap, 'ADMIN')?.surfaceId).toBe('admin');
    expect(hintedResolution(baseMap, ' b2b  admin portal ')?.surfaceId).toBe('admin');
    expect(hintedResolution(baseMap, 'billing')).toBeUndefined();
    expect(hintedResolution(baseMap, undefined)).toBeUndefined();

    const h = setup({ surfaceHint: 'billing' });
    await inbound(h);
    expect(eventOf(await events(h), 'resolved')?.payload).toMatchObject({ surfaceId: 'mobile', resolvedBy: 'vocabulary' });
  });
});

describe('idempotency (main 14.2)', () => {
  it('keys a capture as {source}-{sha256 of the text or image bytes}', () => {
    const sha = (b: string | Uint8Array) => createHash('sha256').update(b).digest('hex');
    expect(captureIdempotencyKey('cli', 'checkout total is blank')).toBe(`cli-${sha('checkout total is blank')}`);
    const png = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);
    expect(captureIdempotencyKey('raycast', png)).toBe(`raycast-${sha(png)}`);
  });

  it('the CLI has the Raycast 24 h window: the same text is dropped within it and taken after', async () => {
    const h = setup();
    expect(idempotencyTtlSec(h.deps, 'cli')).toBe(RAYCAST_IDEMPOTENCY_TTL_SEC);
    expect(idempotencyTtlSec(h.deps, 'raycast')).toBe(RAYCAST_IDEMPOTENCY_TTL_SEC);
    expect(idempotencyTtlSec(h.deps, 'slack')).toBe(7 * RAYCAST_IDEMPOTENCY_TTL_SEC);
    await inbound(h);

    now += DAY / 2;
    const again = capturePayload('cli', APP_TEXT, undefined, now);
    await inbound(h, again);
    expect(await state.read(again.eventId)).toEqual([]);

    now += DAY;
    const nextWeek = capturePayload('cli', APP_TEXT, undefined, now);
    await inbound(h, nextWeek);
    expect((await state.read(nextWeek.eventId)).map((e) => e.type)).toEqual(LOOKUP);
  });
});
