// Teams personal-chat queue (main 15.2, 20.2): the `queue` command and the first install send the
// same queue Slack Home renders, as an Adaptive Card, over a real store on the dialect `SNAPWING_DB`
// selects. The Bot Connector is MSW; GitHub is recorded. The tap verbs are the interactivity verbs.

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { EventPayloads, EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createTeamsConnector } from '../../src/adapters/teams/connector.ts';
import { buildQueueCard, createTeamsQueue, type ActionSetElement, type QueueCard, type TeamsQueue } from '../../src/adapters/teams/queue.ts';
import { createQueue, HOME_SECTION_LIMIT, type QueuePullRequest } from '../../src/status/queue.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-02T14:40:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const WS = '01K6WORKSPACE0000000000000';
const SERVICE_URL = 'https://smba.test/amer/';
const V3 = 'https://smba.test/amer/v3';
const TENANT = 'tenant-1';
const BOT = 'bot-app-id';
const ENGINEER_AAD = '4b1f6a52-8c3d-4e07-9a1b-2d5f7c9e0a13';
const ENGINEER_29 = '29:1Zk3v7Lq0w9XyN2bTqRm4cJdP8sAeHfUoVgKiB5nYtXr';
const REPORTER_AAD = '7c2e9d10-1a4b-4f6e-8b3d-5e0a9c7f2b41';
const STRANGER_AAD = '0d9e8f77-6c5b-4a39-8e21-1f0a3b5c7d9e';
const PERSONAL = '19:4b1f6a52_personal@unq.gbl.spaces';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const REPO = 'github.com/acme/web';
/** The head sha the fake GitHub reports for PR `pr`. */
const headOf = (pr: number): string => String(pr).padStart(40, 'a');
const ENGINEER_SLACK = 'U0WEBDEV1';

let map: WorkspaceMap;
beforeAll(async () => {
  const parsed = await parseWorkspaceMap(exampleXml);
  const aad: Record<string, string> = { U0WEBDEV1: ENGINEER_AAD, U0SALESLEAD: REPORTER_AAD };
  map = {
    ...parsed,
    people: parsed.people.map((p) => (p.slackId !== undefined && aad[p.slackId] !== undefined ? { ...p, teamsId: aad[p.slackId] as string } : p)),
  };
});

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

interface Sent {
  conversationId: string;
  auth: string | null;
  body: { type: string; text: string; attachments: { contentType: string; content: QueueCard }[] };
}

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let errors: unknown[];
let linked: Set<string>;
let prs: Map<number, QueuePullRequest>;
let teams: TeamsQueue;
let sent: Sent[];
let created: unknown[];

function queueOver(open: OpenedState) {
  return createQueue({
    state: open,
    workspaceId: WS,
    getMap: () => Promise.resolve(map),
    identity: {
      getLinkedIdentity: (u) => Promise.resolve(linked.has(u.userId) ? { githubLogin: 'dana-gh' } : null),
      isLinked: (u) => Promise.resolve(linked.has(u.userId)),
    },
    pullRequest: (_repo, n) => {
      const pr = prs.get(n);
      return pr === undefined ? Promise.reject(new Error(`no PR ${n}`)) : Promise.resolve(pr);
    },
    clock: () => new Date(now),
    onError: (e) => errors.push(e),
  });
}

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
  errors = [];
  linked = new Set();
  prs = new Map();
  sent = [];
  created = [];
  server.use(
    http.post(`${V3}/conversations/:id/activities`, async ({ request, params }) => {
      sent.push({ conversationId: String(params['id']), auth: request.headers.get('authorization'), body: (await request.json()) as Sent['body'] });
      return HttpResponse.json({ id: '1790000300001' });
    }),
    http.post(`${V3}/conversations`, async ({ request }) => {
      created.push(await request.json());
      return HttpResponse.json({ id: PERSONAL, activityId: '1790000200001', serviceUrl: SERVICE_URL });
    }),
  );
  teams = createTeamsQueue({
    connector: createTeamsConnector({ token: async () => 'teams-test-token', botId: BOT }),
    queue: queueOver(state),
    botId: BOT,
    onError: (e) => errors.push(e),
  });
});

afterEach(async () => {
  server.resetHandlers();
  expect(errors).toEqual([]);
  await tdb.drop();
});

// Log ---------------------------------------------------------------------------------------------

function ev<T extends EventType>(id: string, type: T, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId: WS, incidentId: id, type, v: 1, source: 'agent', occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

let n = 0;
interface Seeded {
  id: string;
  key: string;
}

/** Filed incident on `surface`; `owner` is the resolved owner's map handle. `seq` is where to append next. */
async function filed(surface: string, summary: string, opts: { owner?: string; reporter?: string; component?: string } = {}): Promise<Seeded & { seq: number }> {
  n += 1;
  const id = `01K6TEAMS0000000000000${String(n).padStart(4, '0')}`;
  const key = `${surface === 'web' ? 'WEB' : 'MOB'}-${3000 + n}`;
  await state.append(
    id,
    [
      ev(id, 'captured', {
        kind: 'incident',
        idempotencyKey: `teams-queue-${n}`,
        source: 'teams',
        reporter: { id: opts.reporter ?? REPORTER_AAD, name: 'reporter', role: 'reporter' },
        anchorText: summary,
        anchorId: `1759395600.0002${String(n).padStart(2, '0')}`,
        channelId: 'C0WEBBUGS',
        rawPayloadSnapshot: { type: 'message', text: summary },
      }),
      ev(id, 'context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
      ev(id, 'resolved', {
        surfaceId: surface,
        ...(opts.component === undefined ? {} : { componentId: opts.component }),
        repo: REPO,
        resolvedBy: 'channel-explicit',
        confidence: 0.9,
        ...(opts.owner === undefined ? {} : { ownerId: opts.owner }),
      }),
      ev(id, 'dedupe-checked', { candidates: [], decision: 'none' }),
      ev(id, 'planned', {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary,
        priority: 'High',
        labels: ['snapwing'],
        autonomyLevel: 2,
        implementationRequest: { artifactId: '01K6REQUEST000000000000001', version: 1 },
      }),
      ev(id, 'filed', { jiraKey: key }),
    ],
    0,
  );
  return { id, key, seq: 6 };
}

async function fixing(inc: Seeded & { seq: number }): Promise<void> {
  await state.append(inc.id, [ev(inc.id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 })], inc.seq);
}

/** Fixer started, PR opened, review passed, CI green: mergeable, with `pr` open on GitHub. */
async function mergeable(surface: string, summary: string, pr: number, reviewers: string[]): Promise<Seeded & { seq: number }> {
  const inc = await filed(surface, summary);
  await state.append(
    inc.id,
    [
      ev(inc.id, 'fixer-started', { runId: 'run-1', harness: 'claude-code', attempt: 1 }),
      ev(inc.id, 'pr-opened', { prNumber: pr, branch: `snapwing/${inc.key}` }),
      ev(inc.id, 'review-passed', { prNumber: pr }),
      ev(inc.id, 'ci-green', { prNumber: pr, headSha: 'abc123' }),
    ],
    inc.seq,
  );
  prs.set(pr, { state: 'open', merged: false, htmlUrl: `https://github.com/acme/web/pull/${pr}`, headSha: headOf(pr), requestedReviewers: reviewers });
  return { ...inc, seq: inc.seq + 4 };
}

/** Mergeable, then merged (and optionally reverted), with the store clock at `at`. */
async function finished(summary: string, pr: number, at: number, revert = false): Promise<Seeded> {
  const before = now;
  now = at;
  const inc = await mergeable('web', summary, pr, []);
  await state.append(inc.id, [ev(inc.id, 'merged', { prNumber: pr, mergeCommitSha: 'def456', levelAtMergeTime: 2 })], inc.seq);
  if (revert) await state.append(inc.id, [ev(inc.id, 'reverted', { prNumber: pr })], inc.seq + 1);
  now = before;
  return inc;
}

// Reading a card ----------------------------------------------------------------------------------

const inbound = (text: string, from: Record<string, unknown>): Record<string, unknown> => ({
  type: 'message',
  id: 'a1',
  text,
  serviceUrl: SERVICE_URL,
  from,
  recipient: { id: BOT },
  conversation: { id: PERSONAL, conversationType: 'personal', tenantId: TENANT },
  channelData: { tenant: { id: TENANT } },
});

const inChannel = (text: string, from: Record<string, unknown>): Record<string, unknown> => ({
  ...inbound(text, from),
  conversation: { id: CHANNEL, conversationType: 'channel', tenantId: TENANT },
});

const engineerFrom = { id: ENGINEER_29, aadObjectId: ENGINEER_AAD };

function cardOf(i = 0): QueueCard {
  const out = sent[i]?.body.attachments[0]?.content;
  expect(out).toBeDefined();
  return out as QueueCard;
}

const isHeading = (b: QueueCard['body'][number]): boolean => b.type === 'TextBlock' && b.weight === 'Bolder';

/** A section's heading and the blocks under it, as JSON. */
function sectionOf(card: QueueCard, title: string): string {
  const start = card.body.findIndex((b) => b.type === 'TextBlock' && b.weight === 'Bolder' && b.text.startsWith(title));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = card.body.slice(start + 1);
  const end = rest.findIndex(isHeading);
  return JSON.stringify([card.body[start], ...(end === -1 ? rest : rest.slice(0, end))]);
}

const actionsIn = (card: QueueCard): ActionSetElement[] => card.body.filter((b): b is ActionSetElement => b.type === 'ActionSet');

describe('an engineer with items in every section', () => {
  it('lists each on its section with the interactivity verbs, and leaves out what is not theirs', async () => {
    const mine = await filed('web', 'Nav menu missing on pricing page', { owner: 'webDev1', component: 'nav' });
    await fixing(mine);
    const notMine = await filed('mobile', 'Push badge stuck', { owner: 'mobDev' });
    await fixing(notMine);
    const review = await mergeable('web', 'Cart total blank', 31, ['dana-gh']);
    const other = await mergeable('web', 'Footer link dead', 32, ['someone-else']);
    const merged = await finished('Checkout button misaligned', 41, T0 - 2 * DAY);
    const reverted = await finished('Banner flicker', 42, T0 - 1 * DAY, true);
    const stale = await finished('Old tooltip typo', 43, T0 - 10 * DAY);
    linked.add(ENGINEER_AAD);

    const command = inbound('<at>Snapwing</at> queue', engineerFrom);
    expect(teams.isQueueCommand(command)).toBe(true);
    expect(await teams.handle(command)).toBe(true);

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ conversationId: PERSONAL, auth: 'Bearer teams-test-token' });
    expect(created).toEqual([]);
    const body = sent[0]!.body;
    expect(body.type).toBe('message');
    expect(body.attachments[0]?.contentType).toBe('application/vnd.microsoft.card.adaptive');
    const card = cardOf();
    expect(card).toMatchObject({ type: 'AdaptiveCard', version: '1.5' });
    expect(body.text).toBe(card.fallbackText);

    const assigned = sectionOf(card, 'Assigned to me');
    expect(assigned).toContain(mine.key);
    expect(assigned).toContain('Nav menu missing on pricing page');
    expect(assigned).not.toContain(notMine.key);

    const fixingNow = sectionOf(card, 'Fixing now');
    expect(fixingNow).toContain(mine.key);
    expect(fixingNow).not.toContain(notMine.key);
    expect(fixingNow).toContain(`"type":"Action.Execute","title":"Stop","verb":"stop","data":{"incidentId":"${mine.id}"}`);

    const waiting = sectionOf(card, 'Waiting on you');
    expect(waiting).toContain(review.key);
    expect(waiting).not.toContain(other.key);
    expect(waiting).toContain('"type":"Action.OpenUrl","title":"Open PR","url":"https://github.com/acme/web/pull/31"');
    // Merge carries the PR and the head the queue read (#264).
    expect(waiting).toContain(`"type":"Action.Execute","title":"Merge","verb":"merge","data":{"incidentId":"${review.id}","prNumber":"31","sha":"${headOf(31)}"}`);

    const recent = sectionOf(card, 'Recently merged or reverted');
    expect(recent).toContain(merged.key);
    expect(recent).toContain(reverted.key);
    expect(recent).toContain('reverted 2026-10-01');
    expect(recent).not.toContain(stale.key);
    expect(recent).not.toContain('Action.');

    for (const set of actionsIn(card)) expect(set.actions.length).toBeLessThanOrEqual(6);
  });

  it('offers Open PR only when the engineer has no linked GitHub identity', async () => {
    const review = await mergeable('web', 'Cart total blank', 31, ['webDev1']);
    await teams.handle(inbound('queue', engineerFrom));
    const waiting = sectionOf(cardOf(), 'Waiting on you');
    expect(waiting).toContain(review.key);
    expect(waiting).toContain('Open PR');
    expect(waiting).not.toContain('"verb":"merge"');
  });

  it('renders the model Slack Home renders from: the same queue for the same person on either platform', async () => {
    const mine = await filed('web', 'Nav menu missing', { owner: 'webDev1', component: 'nav' });
    await fixing(mine);
    await mergeable('web', 'Cart total blank', 31, ['dana-gh']);
    linked.add(ENGINEER_AAD);
    linked.add(ENGINEER_SLACK);
    const model = queueOver(state);
    const onTeams = await model.queueFor({ chat: 'teams', userId: ENGINEER_AAD });
    const onSlack = await model.queueFor({ chat: 'slack', userId: ENGINEER_SLACK });
    expect(onTeams).toEqual(onSlack);
    expect(onTeams.sections.map((s) => s.title)).toEqual(['Assigned to me', 'Fixing now', 'Waiting on you', 'Recently merged or reverted']);
    const headings = buildQueueCard(onTeams)
      .body.filter(isHeading)
      .map((b) => (b as { text: string }).text.replace(/ \(\d+\)$/, ''));
    expect(headings).toEqual(['Your queue', ...onTeams.sections.map((s) => s.title)]);
  });

  it('counts what it does not list and stays under the card size cap', async () => {
    for (let i = 0; i < HOME_SECTION_LIMIT + 3; i += 1) {
      await filed('web', `Bug number ${i} ${'x'.repeat(100)}`, { owner: 'webDev1' });
    }
    await teams.handle(inbound('queue', engineerFrom));
    const assigned = sectionOf(cardOf(), 'Assigned to me');
    expect(assigned).toContain(`(${HOME_SECTION_LIMIT + 3})`);
    expect(assigned).toContain('and 3 more');
    expect(new TextEncoder().encode(JSON.stringify(cardOf())).length).toBeLessThan(28 * 1024);
  });
});

describe('an empty queue', () => {
  it('says so in every section', async () => {
    await teams.handle(inbound('queue', engineerFrom));
    const card = cardOf();
    expect(sectionOf(card, 'Assigned to me')).toContain('Nothing is assigned to you.');
    expect(sectionOf(card, 'Fixing now')).toContain('No fixer is running on your surfaces.');
    expect(sectionOf(card, 'Waiting on you')).toContain('No pull request is waiting on your review.');
    expect(sectionOf(card, 'Recently merged or reverted')).toContain('Nothing merged or reverted on your surfaces in the last 7 days.');
    expect(actionsIn(card)).toEqual([]);
  });
});

describe('a reporter', () => {
  it('sees only their own open reports, with no buttons', async () => {
    const mine = await filed('web', 'Search box ignores Enter');
    const theirs = await filed('web', 'Somebody else', { reporter: STRANGER_AAD });
    const done = await finished('Already merged bug', 51, T0 - DAY);
    await teams.handle(inbound('queue', { id: '29:reporter', aadObjectId: REPORTER_AAD }));
    const card = cardOf();
    const text = JSON.stringify(card);
    expect(card.body[0]).toMatchObject({ text: 'Snapwing' });
    expect(sectionOf(card, 'Your reports')).toContain(mine.key);
    expect(text).not.toContain(theirs.key);
    expect(text).not.toContain(done.key);
    expect(text).not.toContain('Assigned to me');
    expect(actionsIn(card)).toEqual([]);
  });

  it('shows an unmapped user the empty reports view', async () => {
    await teams.handle(inbound('queue', { id: '29:nobody', aadObjectId: STRANGER_AAD }));
    expect(sectionOf(cardOf(), 'Your reports')).toContain('You have no open reports.');
  });
});

describe('where the card goes', () => {
  it('answers the queue command from a channel in the personal chat, opened with the 29: id', async () => {
    await filed('web', 'Nav menu missing', { owner: 'webDev1' });
    await teams.handle(inChannel('<at>Snapwing</at>&nbsp;Queue ', engineerFrom));
    expect(created).toEqual([
      {
        isGroup: false,
        bot: { id: BOT },
        members: [{ id: ENGINEER_29, aadObjectId: ENGINEER_AAD }],
        tenantId: TENANT,
        channelData: { tenant: { id: TENANT } },
      },
    ]);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.conversationId).toBe(PERSONAL);
    expect(sectionOf(cardOf(), 'Assigned to me')).toContain('Nav menu missing');
  });

  it('falls back to the AAD object id when the activity carried no 29: id', async () => {
    await teams.handle(inChannel('queue', { id: 'unexpected', aadObjectId: ENGINEER_AAD }));
    expect((created[0] as { members: unknown }).members).toEqual([{ id: ENGINEER_AAD, aadObjectId: ENGINEER_AAD }]);
  });

  it('sends the first queue when the app is installed for the user', async () => {
    const install = { ...inbound('', engineerFrom), type: 'installationUpdate', action: 'add' };
    expect(teams.isInstall(install)).toBe(true);
    expect(await teams.handle(install)).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]?.conversationId).toBe(PERSONAL);
    expect(cardOf().body[0]).toMatchObject({ text: 'Your queue' });
  });

  it('treats the bot being added to a personal chat as an install; a removal and other text are not', async () => {
    const added = { ...inbound('', engineerFrom), type: 'conversationUpdate', membersAdded: [{ id: BOT }] };
    expect(await teams.handle(added)).toBe(true);
    expect(sent).toHaveLength(1);
    const removed = { ...inbound('', engineerFrom), type: 'installationUpdate', action: 'remove' };
    expect(await teams.handle(removed)).toBe(false);
    expect(await teams.handle(inbound('what is the weather', engineerFrom))).toBe(false);
    expect(sent).toHaveLength(1);
  });

  it('reports a Connector failure to onError and does not throw', async () => {
    server.use(http.post(`${V3}/conversations/:id/activities`, () => HttpResponse.json({ error: { code: 'BotNotInConversationRoster' } }, { status: 403 })));
    await teams.handle(inbound('queue', engineerFrom));
    expect(errors).toHaveLength(1);
    errors = [];
  });
});
