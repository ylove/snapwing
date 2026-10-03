// Slack App Home (#297; main 20.2): `app_home_opened` publishes the opener's queue, shaped by their role
// in the map, over a real store on the dialect `SNAPWING_DB` selects. Slack's Web API and GitHub are
// recorded, not called. The buttons are checked end to end through the existing interactivity handler.

import { readFileSync } from 'node:fs';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { parseWorkspaceMap } from '@snapwing/pipeline/map/parse.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import type { StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import type { SlackAdapter } from '../../src/adapters/slack/adapter.ts';
import { createSlackHome, type HomePullRequest, type HomeView, type SlackHome } from '../../src/adapters/slack/home.ts';
import { createSlackInteractivity } from '../../src/adapters/slack/interactivity.ts';
import { createSlackDispatcher } from '../../src/adapters/slack/transport.ts';
import type { PostMessageArgs, SlackWeb } from '../../src/adapters/slack/web.ts';

const exampleXml = readFileSync(new URL('../../../../examples/workspace-context.example.xml', import.meta.url), 'utf8');

const T0 = Date.parse('2026-10-02T14:40:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const WS = '01K6WORKSPACE0000000000000';
const ENGINEER = 'U0WEBDEV1';
const MOBILE_ENGINEER = 'U0MOBDEV';
const REPORTER = 'U0SALESLEAD';
const STRANGER = 'U0NOBODY';
const REPO = 'github.com/acme/web';

let map: WorkspaceMap;
beforeAll(async () => {
  map = await parseWorkspaceMap(exampleXml);
});

let tdb: TestDatabase;
let state: OpenedState;
let now: number;
let published: { userId: string; view: { type: 'home'; blocks: readonly unknown[] } }[];
let errors: unknown[];
let linked: Set<string>;
let prs: Map<number, HomePullRequest>;
let home: SlackHome;

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  state = await tdb.open({ now: () => new Date(now) });
  published = [];
  errors = [];
  linked = new Set();
  prs = new Map();
  const web: Pick<SlackWeb, 'viewsPublish'> = { viewsPublish: (a) => (published.push(a), Promise.resolve()) };
  home = createSlackHome({
    web,
    state,
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
});

afterEach(async () => {
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
  const id = `01K6HOME0000000000000000${String(n).padStart(2, '0')}`;
  const key = `${surface === 'web' ? 'WEB' : 'MOB'}-${2000 + n}`;
  await state.append(
    id,
    [
      ev(id, 'captured', {
        kind: 'incident',
        idempotencyKey: `slack-home-${n}`,
        source: 'slack',
        reporter: { id: opts.reporter ?? REPORTER, name: 'reporter', role: 'reporter' },
        anchorText: summary,
        anchorId: `1759395600.0001${String(n).padStart(2, '0')}`,
        channelId: 'C0WEBBUGS',
        rawPayloadSnapshot: { type: 'reaction_added', reaction: 'bug', ts: '1759395600.000100' },
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
  prs.set(pr, { state: 'open', merged: false, htmlUrl: `https://github.com/acme/web/pull/${pr}`, requestedReviewers: reviewers });
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

// Reading a view ----------------------------------------------------------------------------------

const textOf = (view: HomeView): string => JSON.stringify(view.blocks);

/** The blocks from a section's heading to the next divider, as JSON. */
function sectionOf(view: HomeView, title: string): string {
  const blocks = view.blocks;
  const start = blocks.findIndex((b) => b.type === 'section' && b.text.text.startsWith(`*${title}*`));
  expect(start).toBeGreaterThanOrEqual(0);
  const rest = blocks.slice(start);
  const end = rest.findIndex((b) => b.type === 'divider');
  return JSON.stringify(end === -1 ? rest : rest.slice(0, end));
}

function opened(user: string, tab = 'home'): unknown {
  n += 1;
  return { type: 'event_callback', event_id: `Ev${n}`, event: { type: 'app_home_opened', user, tab, channel: 'D0HOME' } };
}

// Tests -------------------------------------------------------------------------------------------

describe('an engineer with items in every section', () => {
  it('lists each on its section with the right buttons, and leaves out what is not theirs', async () => {
    const mine = await filed('web', 'Nav menu missing on pricing page', { owner: 'webDev1', component: 'nav' });
    await fixing(mine);
    const notMine = await filed('mobile', 'Push badge stuck', { owner: 'mobDev' });
    await fixing(notMine);
    const review = await mergeable('web', 'Cart total blank', 31, ['dana-gh']);
    const other = await mergeable('web', 'Footer link dead', 32, ['someone-else']);
    const merged = await finished('Checkout button misaligned', 41, T0 - 2 * DAY);
    const reverted = await finished('Banner flicker', 42, T0 - 1 * DAY, true);
    const stale = await finished('Old tooltip typo', 43, T0 - 10 * DAY);
    linked.add(ENGINEER);

    const event = opened(ENGINEER);
    expect(home.intercepts(event)).toBe(true);
    await home.handleEvent(event);
    expect(published).toHaveLength(1);
    expect(published[0]?.userId).toBe(ENGINEER);
    expect(published[0]?.view.type).toBe('home');
    const view = await home.viewFor(ENGINEER);

    const assigned = sectionOf(view, 'Assigned to me');
    expect(assigned).toContain(mine.key);
    expect(assigned).not.toContain(notMine.key);

    const fixingNow = sectionOf(view, 'Fixing now');
    expect(fixingNow).toContain(mine.key);
    expect(fixingNow).not.toContain(notMine.key);
    expect(fixingNow).toContain('"action_id":"stop"');
    expect(fixingNow).toContain(`"value":"${mine.id}"`);
    expect(fixingNow).toContain(`"block_id":"status_actions:${mine.id}"`);

    const waiting = sectionOf(view, 'Waiting on you');
    expect(waiting).toContain(review.key);
    expect(waiting).not.toContain(other.key);
    expect(waiting).toContain('"action_id":"open_pr"');
    expect(waiting).toContain('https://github.com/acme/web/pull/31');
    expect(waiting).toContain('"action_id":"merge"');
    expect(waiting).toContain(`"block_id":"pr_actions:${review.id}"`);

    const recent = sectionOf(view, 'Recently merged or reverted');
    expect(recent).toContain(merged.key);
    expect(recent).toContain(reverted.key);
    expect(recent).toContain('reverted 2026-10-0');
    expect(recent).not.toContain(stale.key);
    expect(recent).not.toContain('"action_id"');
  });

  it('offers Open PR but not Merge to a reviewer with no linked GitHub identity', async () => {
    const review = await mergeable('web', 'Cart total blank', 31, ['webDev1']);
    const waiting = sectionOf(await home.viewFor(ENGINEER), 'Waiting on you');
    expect(waiting).toContain(review.key);
    expect(waiting).toContain('"action_id":"open_pr"');
    expect(waiting).not.toContain('"action_id":"merge"');
  });

  it('skips a PR already merged on GitHub, and keeps going when one lookup fails', async () => {
    await mergeable('web', 'Closed on GitHub', 51, ['dana-gh']);
    prs.set(51, { state: 'closed', merged: true, htmlUrl: 'https://github.com/acme/web/pull/51', requestedReviewers: ['dana-gh'] });
    const gone = await mergeable('web', 'Lookup fails', 52, ['dana-gh']);
    prs.delete(52);
    const ok = await mergeable('web', 'Still open', 53, ['dana-gh']);
    linked.add(ENGINEER);
    const waiting = sectionOf(await home.viewFor(ENGINEER), 'Waiting on you');
    expect(waiting).toContain(ok.key);
    expect(waiting).not.toContain(gone.key);
    expect(waiting).not.toContain('Closed on GitHub');
    expect(errors).toHaveLength(1);
    errors.length = 0;
  });

  it('counts what it does not list when a section is long', async () => {
    for (let i = 0; i < 10; i += 1) {
      const inc = await filed('web', `Bug number ${i}`, { owner: 'webDev1' });
      await fixing(inc);
    }
    const view = await home.viewFor(ENGINEER);
    expect(sectionOf(view, 'Assigned to me')).toContain('and 2 more');
    expect(view.blocks.length).toBeLessThanOrEqual(100);
  });
});

describe('an engineer with nothing to do', () => {
  it('sees every section with its empty line', async () => {
    const view = await home.viewFor(MOBILE_ENGINEER);
    for (const title of ['Assigned to me', 'Fixing now', 'Waiting on you', 'Recently merged or reverted']) {
      expect(sectionOf(view, title)).toContain('context');
    }
    expect(textOf(view)).toContain('Nothing is assigned to you.');
    expect(textOf(view)).toContain('No fixer is running on your surfaces.');
    expect(textOf(view)).toContain('No pull request is waiting on your review.');
    expect(textOf(view)).toContain('in the last 7 days');
    expect(textOf(view)).not.toContain('"action_id"');
  });
});

describe('a reporter', () => {
  it('gets the minimal view: their own open reports and no queue sections or buttons', async () => {
    const mine = await filed('web', 'Nav menu missing on pricing page');
    await finished('Already fixed', 60, T0 - DAY);
    const view = await home.viewFor(REPORTER);
    const text = textOf(view);
    expect(text).toContain('Your reports');
    expect(text).toContain(mine.key);
    expect(text).not.toContain('Already fixed');
    expect(text).not.toContain('Assigned to me');
    expect(text).not.toContain('Waiting on you');
    expect(text).not.toContain('"action_id"');
    expect(view.blocks.length).toBeLessThan(10);
  });

  it('says so when they have no open reports, and an unmapped user gets the same shape', async () => {
    expect(textOf(await home.viewFor(REPORTER))).toContain('You have no open reports.');
    const stranger = await home.viewFor(STRANGER);
    expect(textOf(stranger)).toContain('Your reports');
    expect(textOf(stranger)).not.toContain('Fixing now');
  });
});

describe('events and wiring', () => {
  it('handles app_home_opened on the Home tab only', async () => {
    expect(home.intercepts(opened(ENGINEER, 'messages'))).toBe(false);
    expect(home.intercepts({ type: 'event_callback', event: { type: 'message', user: ENGINEER } })).toBe(false);
    expect(home.intercepts({ type: 'event_callback', event: { type: 'app_home_opened', user: '', tab: 'home' } })).toBe(false);
    await home.handleEvent(opened(ENGINEER, 'messages'));
    expect(published).toEqual([]);
  });

  it('a publish failure goes to onError and never throws', async () => {
    const failing = createSlackHome({
      web: { viewsPublish: () => Promise.reject(new Error('not_authed')) },
      state,
      workspaceId: WS,
      getMap: () => Promise.resolve(map),
      identity: { getLinkedIdentity: () => Promise.resolve(null), isLinked: () => Promise.resolve(false) },
      pullRequest: () => Promise.reject(new Error('unused')),
      onError: (e) => errors.push(e),
    });
    await failing.handleEvent(opened(ENGINEER));
    expect(errors).toHaveLength(1);
    errors.length = 0;
  });

  it('the dispatcher publishes on app_home_opened without handing it to the pipeline', async () => {
    const inbound: unknown[] = [];
    const dispatcher = createSlackDispatcher({
      adapter: { authenticateRequest: () => Promise.resolve(true) } as unknown as SlackAdapter,
      handleInbound: (_source, raw) => (inbound.push(raw), Promise.resolve()),
      onAction: () => undefined,
      home,
    });
    const res = await dispatcher.dispatch({ transport: 'socket', payload: opened(ENGINEER) });
    expect(res.status).toBe(200);
    await dispatcher.idle();
    expect(inbound).toEqual([]);
    expect(published).toHaveLength(1);
  });

  it('Stop in the Home goes through the interactivity handler, replies by DM, and refreshes the view', async () => {
    const mine = await filed('web', 'Nav menu missing on pricing page', { owner: 'webDev1', component: 'nav' });
    await fixing(mine);
    const stops: string[] = [];
    const posts: PostMessageArgs[] = [];
    const ix = createSlackInteractivity({
      web: {
        postMessage: (a) => (posts.push(a), Promise.resolve({ channel: a.channel, ts: '1' })),
        updateMessage: (a) => Promise.resolve({ channel: a.channel, ts: a.ts }),
        postEphemeral: () => Promise.reject(new Error('no channel in the Home')),
      },
      state,
      workspaceId: WS,
      orchestrator: { handleTap: () => Promise.reject(new Error('not a card tap')) },
      stopIncident: (input) => (stops.push(input.incidentId), Promise.resolve({ stopped: true } as unknown as StopOutcome)),
      prActions: { merge: () => Promise.resolve(), requestChanges: () => Promise.resolve(), revert: () => Promise.resolve() },
      getMap: () => Promise.resolve(map),
      githubLinked: (u) => linked.has(u),
      botUserId: 'U0BOT',
      clock: () => new Date(now),
    });
    const dispatcher = createSlackDispatcher({
      adapter: { authenticateRequest: () => Promise.resolve(true) } as unknown as SlackAdapter,
      handleInbound: () => Promise.resolve(),
      onAction: (p) => ix.onAction(p),
      home,
    });
    const tap = {
      type: 'block_actions',
      user: { id: ENGINEER },
      container: { type: 'view', view_id: 'V1' },
      view: { type: 'home' },
      actions: [{ action_id: 'stop', block_id: `status_actions:${mine.id}`, value: mine.id, text: { type: 'plain_text', text: 'Stop' } }],
    };
    await dispatcher.dispatch({ transport: 'socket', payload: tap });
    await dispatcher.idle();
    expect(stops).toEqual([mine.id]);
    expect(posts).toEqual([]);
    expect(published).toHaveLength(1);
    expect(published[0]?.userId).toBe(ENGINEER);

    // A refused tap (Merge without a linked GitHub identity) answers by direct message: the Home has no channel.
    const merge = { ...tap, actions: [{ action_id: 'merge', block_id: `pr_actions:${mine.id}`, value: mine.id, text: { type: 'plain_text', text: 'Merge' } }] };
    expect(await ix.handleAction(merge)).toMatchObject({ kind: 'denied', reason: 'linked-identity-required' });
    expect(posts).toHaveLength(1);
    expect(posts[0]).toMatchObject({ channel: ENGINEER });
  });
});
