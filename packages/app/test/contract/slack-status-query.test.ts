// Status pull in Slack (#296; A 4.3, main 15.1): a mention in a thread, a mention anywhere, a DM, and
// `/status`, each answered in place through `answer()`, shaped to the asker's role from the map, over a
// real store on the dialect `SNAPWING_DB` selects. Slack's Web API and a command's `response_url` are
// recorded, not called.

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import type { SlackAdapter } from '../../src/adapters/slack/adapter.ts';
import { createSlackStatusQuery, looksLikeStatusQuestion, type SlackStatusQuery } from '../../src/adapters/slack/status-query.ts';
import { createSlackDispatcher } from '../../src/adapters/slack/transport.ts';
import type { PostEphemeralArgs, PostMessageArgs, SlackWeb } from '../../src/adapters/slack/web.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-02T14:40:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const CHANNEL = 'C0WEBBUGS';
const OTHER_CHANNEL = 'C0ELSEWHERE';
const DM = 'D0ASKER';
const BOT = 'U0BOT';
const REPORTER = 'U0SALESLEAD';
const ENGINEER = 'U0WEBDEV1';
const STRANGER = 'U0NOBODY';
const NAV = { id: '01K6STATUSQ0000000000000001', key: 'WEB-1042', anchor: '1759395600.000100' };
const CART_A = { id: '01K6STATUSQ0000000000000002', key: 'WEB-1051', anchor: '1759395700.000100' };
const CART_B = { id: '01K6STATUSQ0000000000000003', key: 'WEB-1060', anchor: '1759395800.000100' };
type Seed = { id: string; key: string; anchor: string };

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

let tdb: TestDatabase;
let state: OpenedState;
let posts: PostMessageArgs[];
let ephemerals: PostEphemeralArgs[];
let responses: { url: string; body: Record<string, unknown> }[];
let errors: unknown[];
let sq: SlackStatusQuery;

beforeEach(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(T0) });
  posts = [];
  ephemerals = [];
  responses = [];
  errors = [];
  const web: Pick<SlackWeb, 'postMessage' | 'postEphemeral'> = {
    postMessage: (a) => (posts.push(a), Promise.resolve({ channel: a.channel, ts: '1759396000.000900' })),
    postEphemeral: (a) => (ephemerals.push(a), Promise.resolve({})),
  };
  sq = createSlackStatusQuery({
    web: web as SlackWeb,
    state,
    workspaceId: WS,
    getMap: () => Promise.resolve(map),
    botUserId: BOT,
    clock: () => new Date(T0),
    fetch: (url, init) => {
      responses.push({ url: String(url), body: JSON.parse(String(init?.body)) as Record<string, unknown> });
      return Promise.resolve(new Response('ok'));
    },
    onError: (e) => errors.push(e),
  });
});

afterEach(async () => {
  expect(errors).toEqual([]);
  await tdb.drop();
});

// Log ---------------------------------------------------------------------------------------------

function ev<T extends EventType>(id: string, type: T, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId: WS, incidentId: id, type, v: 1, source: 'agent', occurredAt: new Date(T0 - 600_000).toISOString(), payload } as unknown as NewEvent<T>;
}

/** Filed on web/`component` with the fixer running; `threadId` is the thread the anchor was a reply in. */
async function seed(inc: Seed, summary: string, component: string, opts: { channel?: string; threadId?: string } = {}): Promise<void> {
  await state.append(
    inc.id,
    [
      ev(inc.id, 'captured', {
        kind: 'incident',
        idempotencyKey: `slack-${inc.anchor}-bug`,
        source: 'slack',
        reporter: { id: REPORTER, name: 'salesLead', role: 'reporter' },
        anchorText: summary,
        anchorId: inc.anchor,
        channelId: opts.channel ?? CHANNEL,
        ...(opts.threadId === undefined ? {} : { threadId: opts.threadId }),
        rawPayloadSnapshot: { type: 'reaction_added', reaction: 'bug', ts: inc.anchor },
      }),
      ev(inc.id, 'context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
      ev(inc.id, 'resolved', { surfaceId: 'web', componentId: component, repo: 'github.com/acme/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
      ev(inc.id, 'dedupe-checked', { candidates: [], decision: 'none' }),
      ev(inc.id, 'planned', {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary,
        priority: 'High',
        labels: ['snapwing'],
        autonomyLevel: 2,
        implementationRequest: { artifactId: '01K6REQUEST000000000000001', version: 1 },
      }),
      ev(inc.id, 'filed', { jiraKey: inc.key }),
      ev(inc.id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }),
    ],
    0,
  );
}

// Payloads ----------------------------------------------------------------------------------------

let eventSeq = 0;
function mention(user: string, text: string, opts: { channel?: string; ts?: string; threadTs?: string } = {}): unknown {
  eventSeq += 1;
  return {
    type: 'event_callback',
    event_id: `Ev${eventSeq}`,
    event: {
      type: 'app_mention',
      user,
      text: `<@${BOT}> ${text}`,
      channel: opts.channel ?? CHANNEL,
      ts: opts.ts ?? '1759396100.000500',
      ...(opts.threadTs === undefined ? {} : { thread_ts: opts.threadTs }),
    },
  };
}

function dm(user: string, text: string): unknown {
  eventSeq += 1;
  return { type: 'event_callback', event_id: `Ev${eventSeq}`, event: { type: 'message', channel_type: 'im', user, text, channel: DM, ts: '1759396200.000600' } };
}

function command(user: string, text: string, channel = CHANNEL): Record<string, string> {
  return { command: '/snapwing-status', text, user_id: user, channel_id: channel, response_url: 'https://hooks.slack.test/commands/T1/1/abc' };
}

async function answerTo(payload: unknown): Promise<string> {
  expect(sq.intercepts(payload)).toBe(true);
  await sq.handleEvent(payload);
  expect(posts).toHaveLength(1);
  return posts[0]?.text ?? '';
}

// Entry points ------------------------------------------------------------------------------------

describe('a mention in a thread', () => {
  it('answers in that thread for the thread incident', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(mention(REPORTER, 'where are we with this?', { threadTs: NAV.anchor }));
    expect(posts[0]).toMatchObject({ channel: CHANNEL, thread_ts: NAV.anchor });
    expect(text).toContain('WEB-1042');
    expect(text).not.toContain('WEB-1051');
    expect(text).not.toMatch(/\bPR\b/);
    expect(posts[0]?.blocks).toHaveLength(1);
  });

  it('finds the incident through captured.threadId, which lives only in the log', async () => {
    const parent = '1759395500.000050';
    await seed(NAV, 'Nav menu missing on pricing page', 'nav', { threadId: parent });
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(mention(REPORTER, 'where are we with this?', { threadTs: parent }));
    expect(text).toContain('WEB-1042');
    expect(posts[0]).toMatchObject({ thread_ts: parent });
  });

  it('shapes the answer to the asker: engineer, reporter, and a stranger get three shapes', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const as = async (user: string, tag: string) => {
      posts.length = 0;
      await sq.handleEvent(mention(user, 'WEB-1042', { ts: tag }));
      return posts[0]?.text ?? '';
    };
    const engineer = await as(ENGINEER, '1759396101.000001');
    const reporter = await as(REPORTER, '1759396102.000001');
    const lead = await as(STRANGER, '1759396103.000001');
    expect(new Set([engineer, reporter, lead]).size).toBe(3);
    expect(engineer).toContain('High');
    expect(reporter).not.toContain('High');
    expect(lead).toContain('High');
  });

  it('gives an engineer the Stop button the interactivity handler owns', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await answerTo(mention(ENGINEER, 'where are we with this?', { threadTs: NAV.anchor }));
    expect(JSON.stringify(posts[0]?.blocks)).toContain('"action_id":"stop"');
  });
});

describe('a mention anywhere', () => {
  it('matches the words against open incidents and answers under the mention', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout', { channel: OTHER_CHANNEL });
    const text = await answerTo(mention(REPORTER, 'status on the cart total', { channel: 'C0GENERAL', ts: '1759396300.000700' }));
    expect(text).toContain('WEB-1051');
    expect(posts[0]).toMatchObject({ channel: 'C0GENERAL', thread_ts: '1759396300.000700' });
  });

  it('takes an explicit key', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    expect(await answerTo(mention(ENGINEER, 'WEB-1042'))).toContain('WEB-1042');
  });

  it('asks which one when two candidates tie, naming both', async () => {
    await seed(CART_A, 'Cart total blank', 'checkout');
    await seed(CART_B, 'Cart total wrong', 'checkout');
    const text = await answerTo(mention(REPORTER, 'status on the cart total'));
    expect(text).toContain('WEB-1051');
    expect(text).toContain('WEB-1060');
    expect(text).toContain('?');
  });

  it('ignores the bot and other bots', () => {
    expect(sq.intercepts(mention(BOT, 'status'))).toBe(false);
    const fromBot = mention(REPORTER, 'status') as { event: Record<string, unknown> };
    fromBot.event['bot_id'] = 'B1';
    expect(sq.intercepts(fromBot)).toBe(false);
  });
});

describe('a direct message', () => {
  it('answers a status question in the DM, with no thread', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const text = await answerTo(dm(STRANGER, "what's open on the website?"));
    expect(posts[0]).toMatchObject({ channel: DM });
    expect(posts[0]?.thread_ts).toBeUndefined();
    expect(text).toContain('WEB-1042');
    expect(text).toContain('WEB-1051');
  });

  it('leaves a bug report alone so it is captured', () => {
    expect(sq.intercepts(dm(REPORTER, 'the nav menu is gone on safari, status page too'))).toBe(false);
    expect(sq.intercepts(dm(REPORTER, 'checkout is broken'))).toBe(false);
    expect(looksLikeStatusQuestion('WEB-1042?')).toBe(true);
    expect(looksLikeStatusQuestion('any update on the nav thing')).toBe(true);
  });
});

describe('/snapwing-status (A 4.3 `/status`, a name Slack reserves)', () => {
  it('answers ephemerally through the response_url, for the words given', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    const parsed = sq.commandOf({ transport: 'socket', payload: command(ENGINEER, 'WEB-1051') });
    expect(parsed).toBeDefined();
    await sq.handleCommand(parsed!);
    expect(responses).toHaveLength(1);
    expect(responses[0]?.url).toBe('https://hooks.slack.test/commands/T1/1/abc');
    expect(responses[0]?.body['response_type']).toBe('ephemeral');
    expect(String(responses[0]?.body['text'])).toContain('WEB-1051');
    expect(posts).toHaveLength(0);
  });

  it('reads the form body an HTTP delivery carries, and nothing else', () => {
    expect(sq.commandOf({ transport: 'socket', payload: { ...command(REPORTER, 'x'), command: '/status' } })?.text).toBe('x');
    const body = new URLSearchParams(command(REPORTER, 'checkout')).toString();
    expect(sq.commandOf({ transport: 'http', body })?.text).toBe('checkout');
    expect(sq.commandOf({ transport: 'http', body: new URLSearchParams({ ...command(REPORTER, ''), command: '/other' }).toString() })).toBeUndefined();
    expect(sq.commandOf({ transport: 'http', body: 'payload=%7B%7D' })).toBeUndefined();
  });

  it('with no words, lists the open incidents on the surface', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    await seed(CART_A, 'Cart total blank', 'checkout');
    await sq.handleCommand(sq.commandOf({ transport: 'socket', payload: command(STRANGER, '') })!);
    const text = String(responses[0]?.body['text']);
    expect(text).toContain('WEB-1042');
    expect(text).toContain('WEB-1051');
  });
});

describe('wiring and speed', () => {
  it('the dispatcher answers a mention and a command without handing them to the pipeline', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    const inbound: unknown[] = [];
    const dispatcher = createSlackDispatcher({
      adapter: { authenticateRequest: () => Promise.resolve(true) } as unknown as SlackAdapter,
      handleInbound: (_source, raw) => (inbound.push(raw), Promise.resolve()),
      onAction: () => undefined,
      status: sq,
    });
    const a = await dispatcher.dispatch({ transport: 'socket', payload: mention(REPORTER, 'where are we?', { threadTs: NAV.anchor }) });
    const b = await dispatcher.dispatch({ transport: 'socket', payload: command(ENGINEER, 'WEB-1042') });
    expect([a.status, b.status]).toEqual([200, 200]);
    await dispatcher.idle();
    expect(inbound).toEqual([]);
    expect(posts).toHaveLength(1);
    expect(responses).toHaveLength(1);
  });

  it('answers over thirty open incidents in under a second', async () => {
    await seed(NAV, 'Nav menu missing on pricing page', 'nav');
    for (let i = 0; i < 30; i += 1) {
      const n = String(i).padStart(2, '0');
      await seed({ id: `01K6STATUSQ00000000000010${n}`, key: `WEB-${2000 + i}`, anchor: `1759390000.0001${n}` }, `Filler report ${i}`, 'nav');
    }
    const started = Date.now();
    const text = await answerTo(mention(ENGINEER, 'where are we with this?', { threadTs: NAV.anchor }));
    expect(Date.now() - started).toBeLessThan(1000);
    expect(text).toContain('WEB-1042');
  });
});
