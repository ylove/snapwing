// Teams status projector (#393; main 12, 15.2, A 4.4, B 7.1): drains `target='teams'` `update-status` and
// `notify` rows against an in-memory Bot Connector behind MSW, on the dialect `SNAPWING_DB` selects. The
// clock is shared by the store and the projector, so pauses and backoff move only when a test moves it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { teamsStatusKey } from '../../src/adapters/teams/adapter.ts';
import { createTeamsConnector } from '../../src/adapters/teams/connector.ts';
import { rememberTeamsConversation } from '../../src/adapters/teams/conversations.ts';
import {
  createTeamsStatusProjector,
  mirrorKey,
  type TeamsStatusProjector,
  type TeamsStatusProjectorOptions,
} from '../../src/adapters/teams/status-projector.ts';

const T0 = Date.parse('2026-10-03T12:00:00.000Z');
const WS = '01K0000000000000000000WS01';
const SERVICE_URL = 'https://smba.test/amer/';
const V3 = 'https://smba.test/amer/v3';
const TENANT = 'tenant-1';
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const BUGS = '19:0b1c2d3e4f5a6b7c8d9e@thread.tacv2';
const ROOT = '1790000100123';
const PAT = '11111111-1111-4111-8111-111111111111';
const DANA = '22222222-2222-4222-8222-222222222222';
const RAE = '33333333-3333-4333-8333-333333333333';
const RAE_TEAMS = '29:rae-teams-user-id';

// An in-memory Bot Connector ---------------------------------------------------------------------

interface FakeActivity {
  conversation: string;
  id: string;
  text: string;
  entities: { id: string; name: string }[];
  replyToId?: string;
}

interface Failure {
  op: 'send' | 'reply' | 'update' | 'create';
  skip?: number;
  status: number;
  retryAfter?: string;
  code?: string;
}

class FakeTeams {
  activities: FakeActivity[] = [];
  calls: string[] = [];
  /** AAD object ids the app is installed for (a personal chat can be opened). */
  installed = new Set<string>([PAT]);
  /** The bodies of `createPersonalConversation`. */
  created: Record<string, unknown>[] = [];
  failures: Failure[] = [];
  seq = 0;

  fail(f: Failure): void {
    this.failures.push(f);
  }

  take(op: Failure['op']): Response | undefined {
    const i = this.failures.findIndex((f) => f.op === op);
    if (i === -1) return undefined;
    const pending = this.failures[i]!;
    if ((pending.skip ?? 0) > 0) {
      pending.skip = (pending.skip ?? 0) - 1;
      return undefined;
    }
    this.failures.splice(i, 1);
    return HttpResponse.json({ error: { code: pending.code ?? 'Failure', message: 'nope' } }, { status: pending.status, headers: pending.retryAfter === undefined ? {} : { 'retry-after': pending.retryAfter } });
  }

  in(conversation: string): FakeActivity[] {
    return this.activities.filter((a) => a.conversation.split(';')[0] === conversation);
  }

  add(conversation: string, body: Record<string, unknown>, replyToId?: string): FakeActivity {
    const content = ((body['attachments'] as { content?: Record<string, unknown> }[] | undefined) ?? [])[0]?.content ?? {};
    const body0 = ((content['body'] as { text?: string }[] | undefined) ?? []).map((b) => b.text ?? '').join('\n');
    const entities = ((content['msteams'] as { entities?: { mentioned: { id: string; name: string } }[] } | undefined)?.entities ?? []).map((e) => e.mentioned);
    const activity: FakeActivity = {
      conversation,
      id: `1790000200${String(++this.seq).padStart(3, '0')}`,
      text: body0 === '' ? String(body['text'] ?? '') : body0,
      entities,
      ...(replyToId === undefined ? {} : { replyToId }),
    };
    this.activities.push(activity);
    return activity;
  }

  handlers() {
    const seen = (op: string) => this.calls.push(op);
    return [
      http.post(`${V3}/conversations`, async ({ request }) => {
        seen('create');
        const body = (await request.json()) as Record<string, unknown>;
        this.created.push(body);
        const injected = this.take('create');
        if (injected) return injected;
        const member = (body['members'] as { aadObjectId: string }[])[0]!;
        if (!this.installed.has(member.aadObjectId)) return HttpResponse.json({ error: { code: 'BotNotInConversationRoster' } }, { status: 403 });
        return HttpResponse.json({ id: `a:chat-${member.aadObjectId}` });
      }),
      http.post(`${V3}/conversations/:id/activities`, async ({ request, params }) => {
        seen('send');
        const body = (await request.json()) as Record<string, unknown>;
        const injected = this.take('send');
        if (injected) return injected;
        return HttpResponse.json({ id: this.add(decodeURIComponent(String(params['id'])), body).id });
      }),
      http.post(`${V3}/conversations/:id/activities/:activityId`, async ({ request, params }) => {
        seen('reply');
        const body = (await request.json()) as Record<string, unknown>;
        const injected = this.take('reply');
        if (injected) return injected;
        return HttpResponse.json({ id: this.add(decodeURIComponent(String(params['id'])), body, String(params['activityId'])).id });
      }),
      http.put(`${V3}/conversations/:id/activities/:activityId`, async ({ request, params }) => {
        seen('update');
        const body = (await request.json()) as Record<string, unknown>;
        const injected = this.take('update');
        if (injected) return injected;
        const found = this.activities.find((a) => a.id === params['activityId']);
        if (found === undefined) return HttpResponse.json({ error: { code: 'ActivityNotFoundInConversation' } }, { status: 404 });
        const next = this.add(found.conversation, body);
        this.activities.splice(this.activities.indexOf(next), 1);
        found.text = next.text;
        found.entities = next.entities;
        return HttpResponse.json({ id: found.id });
      }),
    ];
  }
}

// Fixture ---------------------------------------------------------------------------------------

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
let time = T0;
let teams: FakeTeams;

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  await tdb.drop();
});

beforeEach(async () => {
  time = T0 + 365 * 24 * 3600 * 1000;
  for (let rows = await state.drainOutbox('teams', 1000); rows.length > 0; rows = await state.drainOutbox('teams', 1000)) {
    await state.ackOutbox(rows.map((r) => r.id));
  }
  time = T0;
  teams = new FakeTeams();
  server.use(...teams.handlers());
});
afterEach(() => server.resetHandlers());

function kvCache() {
  if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
  return createKvCache(state);
}

const connector = createTeamsConnector({ token: () => Promise.resolve('teams-test-token'), botId: 'bot-app-id' });

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-03T00:00:00Z',
  surfaces: [],
  channels: [{ id: BUGS, name: 'web-bugs', surface: 'web', platform: 'teams', teamId: 'team-1', triggerEmoji: [] }],
  triggers: { messageActions: [], emoji: [] },
  vocabulary: [],
  people: [
    { teamsId: PAT, handle: 'pat', role: 'engineer', owns: [] },
    { teamsId: DANA, handle: 'dana', role: 'engineer', owns: [] },
    { teamsId: RAE, handle: 'rae', role: 'reporter', owns: [] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

function projector(overrides: Partial<TeamsStatusProjectorOptions> = {}): TeamsStatusProjector {
  return createTeamsStatusProjector({
    state,
    connector,
    cache: kvCache(),
    workspaceId: WS,
    getMap: () => Promise.resolve(map),
    defaultServiceUrl: SERVICE_URL,
    tenantId: TENANT,
    now: () => new Date(time),
    ...overrides,
  });
}

let serial = 0;
function row(incidentId: string, text: string, extra: Partial<OutboxItem> = {}): OutboxItem {
  const at = new Date(time).toISOString();
  const id = `${ulid(time).slice(0, 10)}${String(++serial).padStart(16, '0')}`;
  const status: StatusUpdate = { issueKey: 'WEB-1', stage: 'fixing', text };
  return {
    id,
    workspaceId: WS,
    target: 'teams',
    incidentId,
    op: 'update-status',
    payload: { status },
    batchKey: `status:${incidentId}`,
    attempts: 0,
    nextAttempt: at,
    createdAt: at,
    ...extra,
  };
}

function notify(incidentId: string, text: string, extra: { delivery?: 'thread' | 'dm'; mentions?: string[]; reason?: string; batch?: string } = {}): OutboxItem {
  const at = new Date(time).toISOString();
  return {
    id: `${ulid(time).slice(0, 10)}${String(++serial).padStart(16, '0')}`,
    workspaceId: WS,
    target: 'teams',
    incidentId,
    op: 'notify',
    payload: { delivery: extra.delivery ?? 'thread', mentions: extra.mentions ?? [], milestone: 'merged', text, reason: extra.reason ?? 'watch', windowKey: 'w1' },
    batchKey: extra.batch ?? 'notify:w1:thread',
    attempts: 0,
    nextAttempt: at,
    createdAt: at,
  };
}

/** Captures a Teams incident: a channel thread rooted at `ROOT`, or a personal chat. */
async function capture(channelId: string, extra: { personal?: boolean; threadId?: string; snapshot?: Record<string, unknown> } = {}): Promise<string> {
  const incidentId = ulid(time);
  const captured: NewEvent<'captured'> = {
    workspaceId: WS,
    incidentId,
    type: 'captured',
    v: 1,
    source: 'teams',
    occurredAt: new Date(time).toISOString(),
    payload: {
      kind: 'incident',
      idempotencyKey: `teams-${channelId}-${incidentId}`,
      source: 'teams',
      reporter: { id: RAE, name: 'Rae', role: 'reporter' },
      anchorText: 'Cart total is blank',
      anchorId: ROOT,
      channelId,
      ...(extra.threadId === undefined ? {} : { threadId: extra.threadId }),
      rawPayloadSnapshot: { type: 'action-command', conversationType: extra.personal === true ? 'personal' : 'channel', channelId, ...extra.snapshot },
    },
  };
  await state.append(incidentId, [captured], 0);
  await rememberTeamsConversation(kvCache(), {
    serviceUrl: SERVICE_URL,
    tenantId: TENANT,
    channelId,
    conversationType: extra.personal === true ? 'personal' : 'channel',
    updatedAt: new Date(time).toISOString(),
  });
  return incidentId;
}

async function enqueue(...rows: OutboxItem[]): Promise<void> {
  for (const r of rows) await state.enqueueOutbox(r);
}

async function postedEvents(incidentId: string) {
  return (await state.read(incidentId)).filter((e) => e.type === 'status-message-posted');
}

async function botMessages(incidentId: string) {
  return (await state.read(incidentId)).flatMap((e) => (e.type === 'bot-message-posted' ? [e.payload] : []));
}

const THREAD = `${CHANNEL};messageid=${ROOT}`;

// Tests -----------------------------------------------------------------------------------------

describe('first post', () => {
  it('replies in the anchor thread, appends status-message-posted and the status role, and never pins', async () => {
    const incidentId = await capture(CHANNEL);
    const first = row(incidentId, 'On it. A fix is being written.');
    await enqueue(first);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([first.id]);
    expect(teams.calls).toEqual(['reply']);
    const [message] = teams.in(CHANNEL);
    expect(message).toMatchObject({ replyToId: ROOT });
    expect(message!.text).toContain('A fix is being written');
    const posted = await postedEvents(incidentId);
    expect(posted.map((e) => [e.source, e.payload])).toEqual([['teams', { messageId: message!.id }]]);
    // A 1.3: the same append records the message's role, after status-message-posted.
    const record = (await state.read(incidentId)).find((e) => e.type === 'bot-message-posted');
    expect(record?.payload).toEqual({ platform: 'teams', channel: CHANNEL, messageId: message!.id, role: 'status' });
    expect(record?.seq).toBe(posted[0]!.seq + 1);
    expect((await state.getIncident(incidentId))?.statusMsgId).toBe(message!.id);
    expect(JSON.parse((await kvCache().get(teamsStatusKey(incidentId))) ?? '{}')).toEqual({ channelId: CHANNEL, conversationId: THREAD, activityId: message!.id });
    expect(await state.drainOutbox('teams', 10, WS)).toEqual([]);
  });

  it('threads on the captured thread when the capture carried one', async () => {
    const incidentId = await capture(CHANNEL, { threadId: '1790000999000' });
    await enqueue(row(incidentId, 'Looking into it.'));
    await projector().drainOnce();
    expect(teams.in(CHANNEL)[0]?.replyToId).toBe('1790000999000');
  });

  it('retries the append from a fresh read on an expectedSeq conflict', async () => {
    const incidentId = await capture(CHANNEL);
    await enqueue(row(incidentId, 'Looking into it.'));
    let raced = false;
    const racing = new Proxy(state, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return async (id: string, events: NewEvent[], expectedSeq: number) => {
            if (!raced) {
              raced = true;
              await target.append(id, [{ workspaceId: WS, incidentId: id, type: 'waiting-changed', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: {} }], expectedSeq);
            }
            return target.append(id, events, expectedSeq);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });

    await projector({ state: racing }).drainOnce();

    expect((await postedEvents(incidentId)).map((e) => e.seq)).toEqual([3]);
    expect(teams.in(CHANNEL)).toHaveLength(1);
  });

  it('a failed append after posting is retried by editing that message, never by posting a second', async () => {
    const incidentId = await capture(CHANNEL);
    await enqueue(row(incidentId, 'Looking into it.'));
    let failed = false;
    const flaky = new Proxy(state, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return (id: string, events: NewEvent[], expectedSeq: number) => {
            if (!failed) {
              failed = true;
              return Promise.reject(new Error('database is locked'));
            }
            return target.append(id, events, expectedSeq);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const p = projector({ state: flaky });

    expect((await p.drainOnce()).deferred).toHaveLength(1);
    expect(await postedEvents(incidentId)).toHaveLength(0);
    expect(teams.in(CHANNEL)).toHaveLength(1);

    time += 5000;
    const report = await p.drainOnce();

    expect(report.parked).toEqual([]);
    expect(teams.in(CHANNEL)).toHaveLength(1);
    expect((await postedEvents(incidentId)).map((e) => e.payload)).toEqual([{ messageId: teams.in(CHANNEL)[0]!.id }]);
  });

  it('maps a handle mention to an <at> with its entity', async () => {
    const incidentId = await capture(CHANNEL);
    await enqueue(row(incidentId, 'Ready for review, <@pat>.'));
    await projector().drainOnce();
    const [message] = teams.in(CHANNEL);
    expect(message?.text).toContain('<at>pat</at>');
    expect(message?.entities).toEqual([{ id: PAT, name: 'pat' }]);
  });
});

describe('edit in place', () => {
  it('three later rows edit the one message, in order, without a second post or any pin', async () => {
    const incidentId = await capture(CHANNEL);
    const p = projector();
    await enqueue(row(incidentId, 'one'));
    await p.drainOnce();
    for (const text of ['two', 'three', 'four']) {
      await enqueue(row(incidentId, text));
      await p.drainOnce();
    }
    expect(teams.in(CHANNEL)).toHaveLength(1);
    expect(teams.in(CHANNEL)[0]!.text).toContain('four');
    expect(teams.calls.filter((c) => c === 'update')).toHaveLength(3);
    expect(teams.calls.filter((c) => c === 'reply')).toHaveLength(1);
    expect(await postedEvents(incidentId)).toHaveLength(1);
  });

  it('edits through the thread conversation even when the kv ref was lost', async () => {
    const incidentId = await capture(CHANNEL);
    const p = projector();
    await enqueue(row(incidentId, 'one'));
    await p.drainOnce();
    await kvCache().set(teamsStatusKey(incidentId), 'not json');
    await enqueue(row(incidentId, 'two'));
    await p.drainOnce();
    expect(teams.in(CHANNEL)).toHaveLength(1);
    expect(teams.in(CHANNEL)[0]!.text).toContain('two');
  });

  it('collapses rows that piled up to the latest', async () => {
    const incidentId = await capture(CHANNEL);
    const [a, b, c] = [row(incidentId, 'one'), row(incidentId, 'two'), row(incidentId, 'three')];
    await enqueue(a, b, c);

    const report = await projector().drainOnce();

    expect(report.superseded).toEqual([a.id, b.id]);
    expect(report.sent).toEqual([c.id]);
    expect(teams.in(CHANNEL)).toHaveLength(1);
    expect(teams.in(CHANNEL)[0]!.text).toContain('three');
  });

  it('posts a new message when the activity was deleted, and records it', async () => {
    const incidentId = await capture(CHANNEL);
    const p = projector();
    await enqueue(row(incidentId, 'one'));
    await p.drainOnce();
    teams.activities = []; // someone deleted it

    await enqueue(row(incidentId, 'two'));
    await p.drainOnce();

    const [message] = teams.in(CHANNEL);
    expect(message!.text).toContain('two');
    expect(await postedEvents(incidentId)).toHaveLength(2);
    expect((await state.getIncident(incidentId))?.statusMsgId).toBe(message!.id);
    expect((await botMessages(incidentId)).map((m) => m.role)).toEqual(['status', 'status']);
  });
});

describe('personal chat incidents (main 15.1)', () => {
  it('posts in the chat unthreaded, mirrors into the surface bug channel once it is known, then edits the mirror', async () => {
    const chat = 'a:1Rae-personal-chat';
    const incidentId = await capture(chat, { personal: true });
    const cache = kvCache();
    const p = projector({ cache });
    await enqueue(row(incidentId, 'Scoping this.'));
    await p.drainOnce();
    // No surface yet: the chat message only, not threaded, and no mirror.
    expect(teams.in(chat)).toHaveLength(1);
    expect(teams.in(chat)[0]!.replyToId).toBeUndefined();
    expect(teams.calls).toEqual(['send']);
    expect(teams.in(BUGS)).toHaveLength(0);

    await state.append(
      incidentId,
      [{ workspaceId: WS, incidentId, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      (await state.read(incidentId)).at(-1)!.seq,
    );
    await enqueue(row(incidentId, 'A fix is being written.'));
    await p.drainOnce();
    expect(teams.in(BUGS)).toHaveLength(1);
    expect(teams.in(BUGS)[0]!.text).toContain('A fix is being written');
    expect(teams.in(BUGS)[0]!.replyToId).toBeUndefined();
    expect(await cache.get(mirrorKey(incidentId))).not.toBeNull();
    // Both the chat message and its mirror are status messages a reaction can land on (A 1.3).
    expect((await botMessages(incidentId)).map((m) => [m.channel, m.role])).toEqual([
      [chat, 'status'],
      [BUGS, 'status'],
    ]);

    await enqueue(row(incidentId, 'PR is open.'));
    await p.drainOnce();
    expect(teams.in(BUGS)).toHaveLength(1);
    expect(teams.in(BUGS)[0]!.text).toContain('PR is open');
    expect(teams.in(chat)[0]!.text).toContain('PR is open');
  });

  it('mirrors into the Teams bug channel even when a Slack channel for the same surface is listed first', async () => {
    const chat = 'a:1Rae-personal-chat-3';
    const incidentId = await capture(chat, { personal: true });
    await state.append(
      incidentId,
      [{ workspaceId: WS, incidentId, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      (await state.read(incidentId)).at(-1)!.seq,
    );
    const mixed: WorkspaceMap = { ...map, channels: [{ id: 'C0WEBBUGS', name: 'web-bugs', surface: 'web', triggerEmoji: [] }, ...map.channels] };
    await enqueue(row(incidentId, 'A fix is being written.'));
    await projector({ getMap: () => Promise.resolve(mixed) }).drainOnce();
    expect(teams.in(BUGS)).toHaveLength(1);
    expect(teams.in('C0WEBBUGS')).toHaveLength(0);
  });

  it('does not mirror a channel incident, and a failing mirror does not fail the row', async () => {
    const channelIncident = await capture(CHANNEL);
    await state.append(
      channelIncident,
      [{ workspaceId: WS, incidentId: channelIncident, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      1,
    );
    await enqueue(row(channelIncident, 'Looking.'));
    await projector().drainOnce();
    expect(teams.in(BUGS)).toHaveLength(0);

    const chat = 'a:1Rae-personal-chat-2';
    const dm = await capture(chat, { personal: true });
    await state.append(
      dm,
      [{ workspaceId: WS, incidentId: dm, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      1,
    );
    const errors: unknown[] = [];
    const sent = row(dm, 'Looking.');
    await enqueue(sent);
    teams.fail({ op: 'send', skip: 1, status: 403, code: 'BotNotInConversationRoster' }); // the chat post goes first, then the mirror fails
    const report = await projector({ onError: (e) => errors.push(e) }).drainOnce();
    expect(report.sent).toEqual([sent.id]);
    expect(errors).toHaveLength(1);
    expect(teams.in(chat)).toHaveLength(1);
  });
});

describe('notify rows (A 4.4)', () => {
  it('merges the rows of one batch key into one thread message with <at> mentions, not pinned', async () => {
    const incidentId = await capture(CHANNEL);
    const a = notify(incidentId, '<@pat> <@dana> WEB-1 is filed.', { mentions: ['pat', 'dana'] });
    const b = notify(incidentId, '<@pat> A fix is up for WEB-1.', { mentions: ['pat'] });
    const c = notify(incidentId, '<@dana> The fix for WEB-1 is merged.', { mentions: ['dana'] });
    await enqueue(a, b, c);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([a.id, b.id, c.id]);
    expect(teams.calls).toEqual(['reply']);
    const [message] = teams.in(CHANNEL);
    expect(message?.replyToId).toBe(ROOT);
    expect(message?.text).toBe('<at>pat</at> <at>dana</at>\nWEB-1 is filed.\nA fix is up for WEB-1.\nThe fix for WEB-1 is merged.');
    expect(message?.entities).toEqual([
      { id: PAT, name: 'pat' },
      { id: DANA, name: 'dana' },
    ]);
    expect(await botMessages(incidentId)).toEqual([]);
  });

  it('records the reporter staging request as role staging-check', async () => {
    const incidentId = await capture(CHANNEL);
    await enqueue(notify(incidentId, '<@rae> The fix for WEB-1 is on staging. Can you check?', { mentions: ['rae'], reason: 'request', batch: 'notify:w2:request' }));
    await projector().drainOnce();
    const [message] = teams.in(CHANNEL);
    expect(await botMessages(incidentId)).toEqual([{ platform: 'teams', channel: CHANNEL, messageId: message!.id, role: 'staging-check' }]);
  });

  it('sends a DM row to the watcher personal chat when the app is installed for them', async () => {
    const incidentId = await capture(CHANNEL);
    const row1 = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['pat'], batch: 'notify:w1:dm:pat' });
    await enqueue(row1);

    const report = await projector({ botId: 'bot-app-id' }).drainOnce();

    expect(report.sent).toEqual([row1.id]);
    expect(teams.in(`a:chat-${PAT}`).map((a) => a.text)).toEqual(['WEB-1 is live.']);
    expect(teams.in(CHANNEL)).toHaveLength(0);
    // The call names the AAD id (no `29:` id is known for a watcher who is not the reporter) and the bot.
    expect(teams.created[0]).toMatchObject({ isGroup: false, members: [{ id: PAT, aadObjectId: PAT }], bot: { id: 'bot-app-id' }, tenantId: TENANT });
  });

  it('prefers the 29: id from the activity for the reporter, keeping the AAD id in aadObjectId', async () => {
    teams.installed.add(RAE);
    const incidentId = await capture(CHANNEL, { snapshot: { reporterTeamsId: RAE_TEAMS } });
    await enqueue(notify(incidentId, 'Fixed.', { delivery: 'dm', mentions: ['rae'], batch: 'notify:w1:dm:rae' }));
    await projector().drainOnce();
    expect(teams.created[0]).toMatchObject({ members: [{ id: RAE_TEAMS, aadObjectId: RAE }], bot: { id: 'bot-app-id' } });
    expect(teams.in(`a:chat-${RAE}`)).toHaveLength(1);
  });

  it('mentions a watcher without a personal install in the thread, and logs it once', async () => {
    const incidentId = await capture(CHANNEL);
    const errors: unknown[] = [];
    const p = projector({ onError: (e) => errors.push(e) });
    const first = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w1:dm:dana' });
    const second = notify(incidentId, 'WEB-1 is closed.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w9:dm:dana' });
    await enqueue(first);
    const report = await p.drainOnce();
    await enqueue(second);
    await p.drainOnce();

    expect(report.sent).toEqual([first.id]);
    const messages = teams.in(CHANNEL);
    expect(messages.map((m) => m.text)).toEqual(['<at>dana</at> WEB-1 is live.', '<at>dana</at> WEB-1 is closed.']);
    expect(messages.every((m) => m.replyToId === ROOT)).toBe(true);
    expect(messages[0]?.entities).toEqual([{ id: DANA, name: 'dana' }]);
    expect(errors).toHaveLength(1);
    expect(String((errors[0] as Error).message)).toContain('dana');
  });

  it('does not double the mention when a DM batch of two rows falls back to the thread', async () => {
    const incidentId = await capture(CHANNEL);
    const a = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w1:dm:dana' });
    const b = notify(incidentId, 'WEB-2 is live.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w1:dm:dana' });
    await enqueue(a, b);
    await projector().drainOnce();
    expect(teams.in(CHANNEL).map((m) => m.text)).toEqual(['<at>dana</at>\nWEB-1 is live.\nWEB-2 is live.']);
  });

  it('a watcher fallback for a personal-chat incident goes to the Teams bug channel, never the reporter chat', async () => {
    const chat = 'a:1Rae-personal-chat-4';
    const incidentId = await capture(chat, { personal: true });
    await state.append(
      incidentId,
      [{ workspaceId: WS, incidentId, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      (await state.read(incidentId)).at(-1)!.seq,
    );
    await enqueue(notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w1:dm:dana' }));
    await projector({ onError: () => {} }).drainOnce();
    expect(teams.in(chat)).toHaveLength(0);
    expect(teams.in(BUGS).map((m) => m.text)).toEqual(['<at>dana</at> WEB-1 is live.']);
  });

  it('a watcher fallback for a personal-chat incident with no Teams bug channel is logged once and acknowledged unposted', async () => {
    const chat = 'a:1Rae-personal-chat-5';
    const incidentId = await capture(chat, { personal: true });
    const errors: unknown[] = [];
    const first = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w1:dm:dana' });
    const second = notify(incidentId, 'WEB-1 is closed.', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w9:dm:dana' });
    const p = projector({ onError: (e) => errors.push(e) });
    await enqueue(first);
    const report = await p.drainOnce();
    await enqueue(second);
    await p.drainOnce();
    expect(report.sent).toEqual([first.id]);
    expect(teams.in(chat)).toHaveLength(0);
    expect(teams.in(BUGS)).toHaveLength(0);
    expect(errors).toHaveLength(1);
  });

  it('falls back to the thread for a watcher who resolves to nobody', async () => {
    const incidentId = await capture(CHANNEL);
    await enqueue(notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['ghost'], batch: 'notify:w1:dm:ghost' }));
    await projector().drainOnce();
    expect(teams.in(CHANNEL).map((m) => m.text)).toEqual(['@ghost WEB-1 is live.']);
  });

  it('a 429 while opening the chat pauses the drain instead of falling back', async () => {
    const incidentId = await capture(CHANNEL);
    const dm = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['pat'], batch: 'notify:w1:dm:pat' });
    await enqueue(dm);
    teams.fail({ op: 'create', status: 429, retryAfter: '20' });
    const p = projector();
    const report = await p.drainOnce();
    expect(report.pausedUntil).toBe(new Date(T0 + 20_000).toISOString());
    expect(teams.in(CHANNEL)).toHaveLength(0);
    expect((await state.drainOutbox('teams', 10, WS)).map((r) => r.id)).toEqual([dm.id]);
  });
});

describe('rate limits and failures (B 11)', () => {
  it('a 429 pauses the whole drain for Retry-After and leaves the row as it was', async () => {
    const a = await capture(CHANNEL);
    const b = await capture(BUGS);
    const first = row(a, 'one');
    await enqueue(first, row(b, 'other incident'));
    teams.fail({ op: 'reply', status: 429, retryAfter: '30' });
    const p = projector();

    const report = await p.drainOnce();

    expect(report.pausedUntil).toBe(new Date(T0 + 30_000).toISOString());
    expect(report.sent).toEqual([]);
    expect(teams.calls).toEqual(['reply']);
    const [left] = await state.drainOutbox('teams', 10, WS);
    expect(left).toMatchObject({ id: first.id, attempts: 0 });

    time = T0 + 29_000;
    expect((await p.drainOnce()).drained).toBe(0);
    time = T0 + 30_000;
    const resumed = await p.drainOnce();
    expect(resumed.sent).toHaveLength(2);
    expect(p.pausedUntil()).toBeUndefined();
  });

  it('defers a failed send with a doubling delay and parks a row that cannot succeed', async () => {
    const incidentId = await capture(CHANNEL);
    const flaky = row(incidentId, 'one');
    await enqueue(flaky);
    teams.fail({ op: 'reply', status: 500 });
    const p = projector();
    expect((await p.drainOnce()).deferred).toEqual([flaky.id]);

    time = T0 + 1000;
    expect((await p.drainOnce()).sent).toEqual([flaky.id]);

    const gone = await capture('19:gone@thread.tacv2');
    const doomed = row(gone, 'one');
    await enqueue(doomed);
    teams.fail({ op: 'reply', status: 403, code: 'BotNotInConversationRoster' });
    expect((await p.drainOnce()).parked).toEqual([doomed.id]);
    expect(await state.drainOutbox('teams', 10, WS)).toEqual([]);
  });

  it('parks a row whose incident is unknown', async () => {
    const orphan = row(ulid(time), 'one');
    await enqueue(orphan);
    expect((await projector().drainOnce()).parked).toEqual([orphan.id]);
  });

  it('parks a row when no serviceUrl is known for the conversation', async () => {
    const incidentId = ulid(time);
    await state.append(
      incidentId,
      [
        {
          workspaceId: WS,
          incidentId,
          type: 'captured',
          v: 1,
          source: 'teams',
          occurredAt: new Date(time).toISOString(),
          payload: { kind: 'incident', idempotencyKey: `teams-${incidentId}`, source: 'teams', reporter: { id: RAE, name: 'Rae', role: 'reporter' }, anchorText: 'x', anchorId: ROOT, channelId: '19:unknown@thread.tacv2' },
        } as NewEvent<'captured'>,
      ],
      0,
    );
    const lost = row(incidentId, 'one');
    await enqueue(lost);
    expect((await projector({ defaultServiceUrl: '' }).drainOnce()).parked).toEqual([lost.id]);
  });
});

describe('metrics', () => {
  it('prints the pause and each parked row with its error', async () => {
    const incidentId = await capture(CHANNEL);
    const doomed = row(incidentId, 'one');
    await enqueue(doomed);
    teams.fail({ op: 'reply', status: 403, code: 'BotNotInConversationRoster' });
    const p = projector();
    await p.drainOnce();
    const text = await p.metrics();
    expect(text).toContain(`snapwing_teams_drain_paused_seconds{workspace="${WS}"} 0`);
    expect(text).toContain(`snapwing_outbox_parked_rows{target="teams",workspace="${WS}"}`);
    expect(text).toContain(`id="${doomed.id}",op="update-status",incident="${incidentId}"`);
    expect(text).toContain('forbidden');

    teams.fail({ op: 'reply', status: 429, retryAfter: '30' });
    await enqueue(row(await capture(BUGS), 'two'));
    await p.drainOnce();
    expect(await p.metrics()).toContain(`snapwing_teams_drain_paused_seconds{workspace="${WS}"} 30`);
  });
});
