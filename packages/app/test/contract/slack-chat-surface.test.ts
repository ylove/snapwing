// The Slack chat surface's text posts (main 16, A 4): only the mentions the surface emits ping anyone.
// Over `chat.postMessage` on MSW and a real store on the dialect `SNAPWING_DB` selects, through the router
// as compose reaches it: an escalation step, a digest to a channel and to a person, the ux friction post,
// and a thread post that addresses someone. A `<@U...>`, `<!here>`, `<!channel>`, `<!subteam^...>` or
// `<at>...</at>` inside user text (an incident summary, a digest line, a task summary) is escaped and
// pings nobody. Also the card fallbacks Slack notifies from, which escape the same way.

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { renderDigest } from '@snapwing/pipeline/notify/digest.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import type { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { buildCard } from '../../src/adapters/slack/cards/cards.ts';
import { createSlackChatSurface, type SlackChatSurface } from '../../src/adapters/slack/chat-surface.ts';
import { createSlackWeb } from '../../src/adapters/slack/web.ts';
import { createChatRouter, type ChatRouter } from '../../src/server/chat.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-03T10:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const API = 'https://slack.com/api/';
const CHANNEL = 'C0WEBBUGS';
const ANCHOR = '1790000000.000100';
const INCIDENT = '01K6SLACKCHAT00000000000001';

/** User text carrying every kind of Slack mention syntax, a Teams tag, and an ampersand. */
const SPOOF = 'Checkout fails for <@U0WEBDEV1> & <!here>, <!channel>, <!subteam^S0WEBTEAM>, <at>teamsReviewer</at>';
const SHOWN = 'Checkout fails for &lt;@U0WEBDEV1&gt; &amp; &lt;!here&gt;, &lt;!channel&gt;, &lt;!subteam^S0WEBTEAM&gt;, &lt;at&gt;teamsReviewer&lt;/at&gt;';

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
let posts: Record<string, string>[];
let errors: string[];
let surface: SlackChatSurface;
let router: ChatRouter;

beforeEach(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(T0) });
  posts = [];
  errors = [];
  let seq = 0;
  server.use(
    http.post(`${API}chat.postMessage`, async ({ request }) => {
      const body = (await request.json()) as Record<string, string>;
      posts.push(body);
      return HttpResponse.json({ ok: true, channel: body['channel'], ts: `1790000100.00010${String(++seq)}` });
    }),
  );
  const captured: NewEvent<'captured'> = {
    workspaceId: WS,
    incidentId: INCIDENT,
    type: 'captured',
    v: 1,
    source: 'agent',
    occurredAt: new Date(T0).toISOString(),
    payload: {
      kind: 'incident',
      idempotencyKey: `slack-chat-${INCIDENT}`,
      source: 'slack',
      reporter: { id: 'U0SALESLEAD', name: 'Pat', role: 'reporter' },
      anchorText: 'checkout is broken',
      anchorId: ANCHOR,
      threadId: ANCHOR,
      channelId: CHANNEL,
    },
  };
  await state.append(INCIDENT, [captured as NewEvent<EventType>], 0);
  const log = { info: () => undefined, error: (l: string) => errors.push(l) };
  surface = createSlackChatSurface({
    web: createSlackWeb({ token: 'xoxb-test' }),
    state,
    cache: createKvCache(state as unknown as StateStore),
    getMap: () => Promise.resolve(map),
    identity: { isLinked: () => Promise.resolve(false) },
    log,
  });
  router = createChatRouter({ surfaces: [surface], state, map: () => Promise.resolve(map), clock: () => new Date(T0), log });
});

afterEach(async () => {
  server.resetHandlers();
  expect(errors).toEqual([]);
  await tdb.drop();
});

/** Every `<@...>` and `<!...>` in a posted text: the mentions Slack would ping. */
function pings(text: string | undefined): string[] {
  return [...(text ?? '').matchAll(/<[@!][^>]*>/g)].map((m) => m[0]);
}

describe('mentions the surface emits', () => {
  it('render as <@U...> for every reference a ladder step or digest uses', async () => {
    for (const ref of ['@webDev1', 'dana@example.com', 'U0WEBDEV1']) await surface.channelPost('#web-bugs', `${surface.mention(map, ref)} over to you`);
    await surface.channelPost('#web-bugs', `${surface.mentionUser('U0WEBDEV1')} over to you`);
    await surface.channelPost('#web-bugs', `${surface.mention(map, 'U0OUTSIDER')} too`);
    expect(posts.map((p) => [p['channel'], p['text']])).toEqual([
      [CHANNEL, '<@U0WEBDEV1> over to you'],
      [CHANNEL, '<@U0WEBDEV1> over to you'],
      [CHANNEL, '<@U0WEBDEV1> over to you'],
      [CHANNEL, '<@U0WEBDEV1> over to you'],
      [CHANNEL, '<@U0OUTSIDER> too'],
    ]);
    expect(surface.mention(map, '@nobody')).toBe('@nobody');
  });
});

describe('mention syntax inside user text', () => {
  it('an escalation step pings its own person, never one the incident summary names', async () => {
    await router.escalation.post({
      incidentId: INCIDENT,
      ladder: 'outage',
      step: 1,
      where: { kind: 'thread', channel: CHANNEL, threadId: ANCHOR },
      mention: '@mobDev',
      text: `Escalating (outage, step 1 of 2): WEB-1042 ${SPOOF}`,
    });
    expect(posts).toEqual([{ channel: CHANNEL, thread_ts: ANCHOR, text: `<@U0MOBDEV> Escalating (outage, step 1 of 2): WEB-1042 ${SHOWN}` }]);
    expect(pings(posts[0]?.['text'])).toEqual(['<@U0MOBDEV>']);
  });

  it('a digest line posts to a channel and to a person with no ping', async () => {
    const text = renderDigest({
      window: { from: new Date(T0 - 86_400_000), to: new Date(T0) },
      opened: 1,
      closed: 0,
      pullRequests: 0,
      autopilotMerges: 0,
      reverts: 0,
      oldestOpen: [{ incidentId: INCIDENT, label: 'WEB-1042', summary: SPOOF, openedAt: new Date(T0 - 3_600_000).toISOString(), ageMs: 3_600_000, waitingOn: 'human' }],
    });
    await router.postTo('#web-bugs', text);
    await router.postTo('@webDev1', text);
    expect(posts.map((p) => p['channel'])).toEqual([CHANNEL, 'U0WEBDEV1']);
    for (const p of posts) {
      expect(p['text']).toContain(`- WEB-1042, ${SHOWN}: open 1h, waiting on an engineer.`);
      expect(pings(p['text'])).toEqual([]);
    }
  });

  it('a ux friction task summary posts to the bug channel with no ping', async () => {
    await router.channelPost('#web-bugs', `${SPOOF}. When several people hit the same thing, the product is inviting it: filed a WEB Task labeled ux-friction.`);
    expect(posts).toEqual([{ channel: CHANNEL, text: `${SHOWN}. When several people hit the same thing, the product is inviting it: filed a WEB Task labeled ux-friction.` }]);
    expect(pings(posts[0]?.['text'])).toEqual([]);
  });

  it('a thread post pings the person it addresses, never one the text it carries names', async () => {
    await router.threadPost(INCIDENT, { text: `@webDev1, still on it? ${SPOOF}`, mentionUserId: 'U0WEBDEV1' });
    expect(posts).toEqual([{ channel: CHANNEL, thread_ts: ANCHOR, text: `<@U0WEBDEV1>, still on it? ${SHOWN}` }]);
    expect(pings(posts[0]?.['text'])).toEqual(['<@U0WEBDEV1>']);
  });

  it('a string shaped like a mark in user text is not one', async () => {
    await surface.threadPost({ channel: CHANNEL, threadId: ANCHOR }, 'see \u0002U0WEBDEV1\u0003');
    expect(pings(posts[0]?.['text'])).toEqual([]);
  });
});

describe('card fallbacks Slack notifies from', () => {
  it('the scope-change card escapes the reporter words in its text', async () => {
    await surface.textCards.postScopeCard(INCIDENT, {
      kind: 'scope-change',
      text: 'Sounds like a second issue on <!channel>. File it separately?',
      messageId: '1790000000.000200',
      choices: [{ id: 'yes', label: 'Yes' }],
    } as never);
    expect(posts[0]?.['text']).toBe('Sounds like a second issue on &lt;!channel&gt;. File it separately?');
  });

  it('the scope preview, dedupe, clarify and fix preview cards escape a summary in their text', () => {
    const plan = { action: 'create_issue', projectKey: 'WEB', issueType: 'Bug', summary: SPOOF, priority: 'High', labels: [], autonomyLevel: 1 };
    const cards = [
      buildCard(INCIDENT, { kind: 'scope-preview', summary: SPOOF }),
      buildCard(INCIDENT, { kind: 'dedupe', issueKey: 'WEB-812', summary: SPOOF }),
      buildCard(INCIDENT, { kind: 'clarify', question: { audience: 'reporter', text: SPOOF, gatePassed: true, gateFailures: [] } } as never),
      buildCard(INCIDENT, { kind: 'fix-preview', plan } as never),
    ];
    expect(cards.map((c) => c.text)).toEqual([SHOWN, `This looks like WEB-812: ${SHOWN}`, SHOWN, `Diagnosis: ${SHOWN}`]);
  });
});
