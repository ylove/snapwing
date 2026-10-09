// Slack notifications (A 4.4, A 1.3, B 7.1): the Slack projector's `notify` op against an
// in-memory Slack behind MSW, on the dialect `SNAPWING_DB` selects. Covers one milestone, a merged
// burst (rows of one batch_key become one message), a DM, and the staging request's record as the
// `staging-check` role, which the A 8 verification flow resolves a reaction through. Also a DM about a
// Teams incident to someone who asked on Slack: it comes to Slack, with no Slack thread behind it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { resolveTarget } from '@snapwing/pipeline/signals/target.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createSlackStatusProjector, mergeNotifyText } from '../../src/adapters/slack/status-projector.ts';
import { createSlackStatusQuery } from '../../src/adapters/slack/status-query.ts';
import { createSlackWeb } from '../../src/adapters/slack/web.ts';

const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const WS = '01K0000000000000000000WS01';
const API = 'https://slack.com/api/';
const CHANNEL = 'C0WEB';
const THREAD = '1700000000.000100';

interface FakeMessage {
  channel: string;
  ts: string;
  text: string;
  thread_ts?: string;
}

class FakeSlack {
  messages: FakeMessage[] = [];
  calls: string[] = [];
  seq = 0;

  handlers() {
    return [
      http.post(`${API}chat.postMessage`, async ({ request }) => {
        this.calls.push('chat.postMessage');
        const body = (await request.json()) as Record<string, unknown>;
        const message: FakeMessage = {
          channel: String(body['channel']),
          ts: `1700000${String(++this.seq).padStart(3, '0')}.000100`,
          text: String(body['text']),
          ...(body['thread_ts'] === undefined ? {} : { thread_ts: String(body['thread_ts']) }),
        };
        this.messages.push(message);
        return HttpResponse.json({ ok: true, channel: message.channel, ts: message.ts });
      }),
      http.post(`${API}pins.add`, () => {
        this.calls.push('pins.add');
        return HttpResponse.json({ ok: true });
      }),
    ];
  }
}

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
let time = T0;
let slack: FakeSlack;

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  await tdb.drop();
});

beforeEach(() => {
  time = T0;
  slack = new FakeSlack();
  server.use(...slack.handlers());
});
afterEach(() => server.resetHandlers());

const web = createSlackWeb({ token: 'xoxb-test' });

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-02T00:00:00Z',
  surfaces: [],
  channels: [],
  triggers: { messageActions: [], emoji: [] },
  vocabulary: [],
  people: [
    { slackId: 'U0PAT', handle: 'pat', role: 'engineer', owns: [] },
    { slackId: 'U0DANA', handle: 'dana', role: 'engineer', owns: [] },
    { slackId: 'U0REPORTER', handle: 'rae', role: 'reporter', owns: [] },
  ],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

function projector() {
  if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
  return createSlackStatusProjector({ state, web, cache: createKvCache(state), workspaceId: WS, getMap: () => Promise.resolve(map), now: () => new Date(time) });
}

async function capture(): Promise<string> {
  const incidentId = ulid(time);
  const captured: NewEvent<'captured'> = {
    workspaceId: WS,
    incidentId,
    type: 'captured',
    v: 1,
    source: 'slack',
    occurredAt: new Date(time).toISOString(),
    payload: {
      kind: 'incident',
      idempotencyKey: `slack-${incidentId}`,
      source: 'slack',
      reporter: { id: 'U0REPORTER', name: 'Rae', role: 'reporter' },
      anchorText: 'Cart total is blank',
      anchorId: '1700000000.000200',
      channelId: CHANNEL,
      threadId: THREAD,
    },
  };
  await state.append(incidentId, [captured], 0);
  return incidentId;
}

let serial = 0;
function notify(incidentId: string, text: string, extra: { delivery?: 'thread' | 'dm'; mentions?: string[]; reason?: string; batch?: string; due?: number } = {}): OutboxItem {
  const at = new Date(time).toISOString();
  return {
    id: `${ulid(time).slice(0, 10)}${String(++serial).padStart(16, '0')}`,
    workspaceId: WS,
    target: 'slack',
    incidentId,
    op: 'notify',
    payload: { delivery: extra.delivery ?? 'thread', mentions: extra.mentions ?? [], milestone: 'merged', text, reason: extra.reason ?? 'watch', windowKey: 'w1' },
    batchKey: extra.batch ?? 'notify:w1:thread',
    attempts: 0,
    nextAttempt: new Date(extra.due ?? time).toISOString(),
    createdAt: at,
  };
}

describe('notify rows', () => {
  it('posts one milestone in the thread, mentioning the watcher, without pinning', async () => {
    const incidentId = await capture();
    const row = notify(incidentId, '<@pat> The fix for WEB-1 is merged.', { mentions: ['pat'] });
    await state.enqueueOutbox(row);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([row.id]);
    expect(slack.messages).toEqual([{ channel: CHANNEL, ts: expect.any(String), thread_ts: THREAD, text: '<@U0PAT> The fix for WEB-1 is merged.' }]);
    expect(slack.calls).toEqual(['chat.postMessage']);
    expect(await state.drainOutbox('slack', 10, WS)).toEqual([]);
    // Not the pinned status message: nothing is recorded for it.
    expect((await state.read(incidentId)).filter((e) => e.type === 'bot-message-posted')).toEqual([]);
  });

  it('merges a burst of rows with one batch_key into one message, mentions once', async () => {
    const incidentId = await capture();
    const a = notify(incidentId, '<@pat> <@dana> WEB-1 is filed.', { mentions: ['pat', 'dana'] });
    const b = notify(incidentId, '<@pat> A fix is up for WEB-1.', { mentions: ['pat'] });
    const c = notify(incidentId, '<@dana> The fix for WEB-1 is merged.', { mentions: ['dana'] });
    await state.enqueueOutbox(a);
    await state.enqueueOutbox(b);
    await state.enqueueOutbox(c);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([a.id, b.id, c.id]);
    expect(slack.messages).toHaveLength(1);
    expect(slack.messages[0]?.text).toBe('<@U0PAT> <@U0DANA>\nWEB-1 is filed.\nA fix is up for WEB-1.\nThe fix for WEB-1 is merged.');
    expect(await state.drainOutbox('slack', 10, WS)).toEqual([]);
  });

  it('keeps a lone row\'s text as it is, and rows of different batches apart', async () => {
    expect(mergeNotifyText([{ delivery: 'thread', mentions: ['pat'], text: '<@pat> hi', reason: 'watch' }])).toBe('<@pat> hi');
    const incidentId = await capture();
    await state.enqueueOutbox(notify(incidentId, '<@pat> one', { mentions: ['pat'], batch: 'notify:w1:thread' }));
    await state.enqueueOutbox(notify(incidentId, 'two', { delivery: 'dm', mentions: ['dana'], batch: 'notify:w1:dm:dana' }));
    await projector().drainOnce();
    expect(slack.messages.map((m) => [m.channel, m.text])).toEqual([
      [CHANNEL, '<@U0PAT> one'],
      ['U0DANA', 'two'],
    ]);
  });

  it('sends a DM to the watcher\'s Slack id, outside any thread', async () => {
    const incidentId = await capture();
    const row = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['pat'], batch: 'notify:w1:dm:pat' });
    await state.enqueueOutbox(row);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([row.id]);
    expect(slack.messages).toEqual([{ channel: 'U0PAT', ts: expect.any(String), text: 'WEB-1 is live.' }]);
  });

  it('waits for the burst window: a row not yet due is not sent, then goes out when due', async () => {
    const incidentId = await capture();
    const row = notify(incidentId, 'later', { due: time + 300_000 });
    await state.enqueueOutbox(row);
    expect((await projector().drainOnce()).sent).toEqual([]);
    time += 300_000;
    expect((await projector().drainOnce()).sent).toEqual([row.id]);
  });

  it('parks a DM whose user does not resolve to a Slack id', async () => {
    const incidentId = await capture();
    const row = notify(incidentId, 'WEB-1 is live.', { delivery: 'dm', mentions: ['ghost'], batch: 'notify:w1:dm:ghost' });
    await state.enqueueOutbox(row);
    const report = await projector().drainOnce();
    expect(report.parked).toEqual([row.id]);
    expect(slack.messages).toEqual([]);
  });
});

describe('the staging request (A 1.3)', () => {
  it('is recorded as role staging-check, so a reaction on it resolves to the verification target', async () => {
    const incidentId = await capture();
    const row = notify(incidentId, '<@rae> The fix for WEB-1 is on staging. Can you check?', {
      mentions: ['rae'],
      reason: 'request',
      batch: 'notify:w2:request',
    });
    await state.enqueueOutbox(row);

    await projector().drainOnce();

    const [message] = slack.messages;
    expect(message).toMatchObject({ channel: CHANNEL, thread_ts: THREAD, text: '<@U0REPORTER> The fix for WEB-1 is on staging. Can you check?' });
    const record = (await state.read(incidentId)).find((e) => e.type === 'bot-message-posted');
    expect(record?.payload).toEqual({ platform: 'slack', channel: CHANNEL, messageId: message?.ts, role: 'staging-check' });
    expect(await resolveTarget(state, { platform: 'slack', channel: CHANNEL, messageId: message?.ts ?? '' })).toMatchObject({ incidentId, role: 'staging-check' });
  });

  it('is not merged into a watcher notification', async () => {
    const incidentId = await capture();
    await state.enqueueOutbox(notify(incidentId, '<@rae> on staging. Can you check?', { mentions: ['rae'], reason: 'request', batch: 'notify:w3:request' }));
    await state.enqueueOutbox(notify(incidentId, '<@pat> The fix for WEB-1 is on staging.', { mentions: ['pat'], batch: 'notify:w4:thread' }));
    await projector().drainOnce();
    expect(slack.messages.map((m) => m.text)).toEqual(['<@U0REPORTER> on staging. Can you check?', '<@U0PAT> The fix for WEB-1 is on staging.']);
    const roles = (await state.read(incidentId)).filter((e) => e.type === 'bot-message-posted').map((e) => e.payload.role);
    expect(roles).toEqual(['staging-check']);
  });
});

describe('a standing subscription asked for in a DM (A 4.4)', () => {
  const dmMap: WorkspaceMap = {
    ...map,
    surfaces: [{ id: 'web', label: 'Website', repo: 'fake-org/web', jira: { project: 'WEB', defaultIssueType: 'Bug' }, components: [] }],
  };

  function dm(user: string, text: string, id: string): unknown {
    return { type: 'event_callback', event_id: id, event: { type: 'message', channel_type: 'im', user, text, channel: 'D0PAT', ts: '1759396200.000600' } };
  }

  it('writes a surface row, confirms in the DM, and the next milestone on that surface mentions the person', async () => {
    const query = createSlackStatusQuery({ web, state, standing: state, workspaceId: WS, getMap: () => Promise.resolve(dmMap), botUserId: 'U0BOT', clock: () => new Date(time) });
    const event = dm('U0PAT', 'keep me posted on the website', 'EvStanding1');
    expect(query.intercepts(event)).toBe(true);
    await query.handleEvent(event);
    expect(slack.messages.map((m) => [m.channel, m.text])).toEqual([['D0PAT', 'Done. I will keep you posted on every incident on Website.']]);

    // A new incident on `web` sees it (getSubscriptions covers the incident's surface).
    const incidentId = await capture();
    await state.append(
      incidentId,
      [{ workspaceId: WS, incidentId, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web', componentId: 'x', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 } }],
      1,
    );
    expect((await state.getSubscriptions(incidentId)).map((s) => [s.userId, s.scopeKind, s.scopeId, s.channel, s.platform])).toEqual([['U0PAT', 'surface', 'web', 'dm', 'slack']]);

    await query.handleEvent(dm('U0PAT', 'stop keeping me posted on the website', 'EvStanding2'));
    expect((await state.getSubscriptions(incidentId)).filter((s) => s.userId === 'U0PAT')).toEqual([]);
  });

  it('tells a standing watcher on Slack nothing about a Teams incident: that channel is never theirs (#272)', async () => {
    const query = createSlackStatusQuery({ web, state, standing: state, workspaceId: WS, getMap: () => Promise.resolve(dmMap), botUserId: 'U0BOT', clock: () => new Date(time) });
    await query.handleEvent(dm('U0PAT', 'keep me posted on the website', 'EvStanding4'));
    slack.messages = [];

    const incidentId = ulid(time);
    const at = new Date(time).toISOString();
    const e = (type: NewEvent['type'], payload: unknown, source: NewEvent['source'] = 'agent'): NewEvent =>
      ({ workspaceId: WS, incidentId, type, v: 1, source, occurredAt: at, payload }) as unknown as NewEvent;
    await state.append(
      incidentId,
      [
        e(
          'captured',
          {
            kind: 'incident',
            idempotencyKey: `teams-${incidentId}`,
            source: 'teams',
            reporter: { id: '00000000-0000-4000-8000-00000000fa11', name: 'Rae', role: 'reporter' },
            anchorText: 'Cart total is blank',
            anchorId: 'teams-root-1',
            channelId: '19:fake-web-bugs@thread.tacv2',
          },
          'teams',
        ),
        e('context-assembled', { bundle: { artifactId: '01JZ00000000000000000000F1', version: 1 }, includedCount: 1, excludedCount: 0 }),
        e('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
        e('dedupe-checked', { candidates: [], decision: 'none' }),
        e('planned', {
          action: 'create_issue',
          projectKey: 'WEB',
          issueType: 'Bug',
          summary: 'Cart total is blank',
          priority: 'Medium',
          labels: ['snapwing'],
          autonomyLevel: 2,
          implementationRequest: { artifactId: '01JZ00000000000000000000F2', version: 1 },
        }),
        e('filed', { jiraKey: 'WEB-7' }),
      ],
      0,
    );
    time += 300_000; // the burst window closes

    const report = await projector().drainOnce();

    expect(report.parked).toEqual([]);
    expect(report.sent).toEqual([]);
    expect(slack.messages).toEqual([]);
    expect(await state.drainOutbox('slack', 10, WS)).toEqual([]);
    // The Teams thread's own rows stay on the teams queue, with no notify row for the Slack watcher.
    expect((await state.drainOutbox('teams', 10, WS)).filter((r) => r.incidentId === incidentId).map((r) => r.op)).toEqual(['update-status']);
    await query.handleEvent(dm('U0PAT', 'stop keeping me posted on the website', 'EvStanding5'));
  });

  it('leaves an ordinary DM alone', () => {
    const query = createSlackStatusQuery({ web, state, standing: state, workspaceId: WS, getMap: () => Promise.resolve(dmMap), botUserId: 'U0BOT' });
    expect(query.intercepts(dm('U0PAT', 'the cart total is blank', 'EvStanding3'))).toBe(false);
  });
});
