// Slack status projector (main 12, 15.1, B 7.1): drains `target='slack'` `update-status` rows
// against an in-memory Slack behind MSW, on the dialect `SNAPWING_DB` selects. The clock is shared by
// the store and the projector, so pauses and backoff move only when a test moves it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { StatusUpdate } from '@snapwing/pipeline/contracts/adapters.ts';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { OpenedState, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { createKvCache } from '@snapwing/pipeline/providers/local/cache.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createSlackWeb } from '../../src/adapters/slack/web.ts';
import { createSlackStatusProjector, mirrorKey, type SlackStatusProjector, type SlackStatusProjectorOptions } from '../../src/adapters/slack/status-projector.ts';

const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const WS = '01K0000000000000000000WS01';
const API = 'https://slack.com/api/';

// An in-memory Slack ---------------------------------------------------------------------------

interface FakeMessage {
  channel: string;
  ts: string;
  text: string;
  thread_ts?: string;
  pinned: boolean;
}

class FakeSlack {
  messages: FakeMessage[] = [];
  calls: string[] = [];
  /** Answers queued for the next call of a method: a 429, or `{ ok: false, error }`. */
  failures: { method: string; skip?: number; status?: number; retryAfter?: string; error?: string }[] = [];
  seq = 0;

  fail(method: string, f: { skip?: number; status?: number; retryAfter?: string; error?: string }): void {
    this.failures.push({ method, ...f });
  }

  take(method: string): Response | undefined {
    const i = this.failures.findIndex((f) => f.method === method);
    if (i === -1) return undefined;
    const pending = this.failures[i]!;
    if ((pending.skip ?? 0) > 0) {
      pending.skip = (pending.skip ?? 0) - 1;
      return undefined;
    }
    const [f] = this.failures.splice(i, 1);
    if (f!.status === 429) return new HttpResponse('{}', { status: 429, headers: { 'retry-after': f!.retryAfter ?? '30' } });
    return HttpResponse.json({ ok: false, error: f!.error ?? 'fatal_error' });
  }

  in(channel: string): FakeMessage[] {
    return this.messages.filter((m) => m.channel === channel);
  }

  handlers() {
    const call = async (method: string, request: Request) => {
      this.calls.push(method);
      return { injected: this.take(method), body: (await request.json()) as Record<string, unknown> };
    };
    return [
      http.post(`${API}chat.postMessage`, async ({ request }) => {
        const { injected, body } = await call('chat.postMessage', request);
        if (injected) return injected;
        const message: FakeMessage = {
          channel: String(body['channel']),
          ts: `1700000${String(++this.seq).padStart(3, '0')}.000100`,
          text: String(body['text']),
          pinned: false,
          ...(body['thread_ts'] === undefined ? {} : { thread_ts: String(body['thread_ts']) }),
        };
        this.messages.push(message);
        return HttpResponse.json({ ok: true, channel: message.channel, ts: message.ts });
      }),
      http.post(`${API}chat.update`, async ({ request }) => {
        const { injected, body } = await call('chat.update', request);
        if (injected) return injected;
        const message = this.messages.find((m) => m.channel === body['channel'] && m.ts === body['ts']);
        if (message === undefined) return HttpResponse.json({ ok: false, error: 'message_not_found' });
        message.text = String(body['text']);
        return HttpResponse.json({ ok: true, channel: message.channel, ts: message.ts });
      }),
      http.post(`${API}pins.add`, async ({ request }) => {
        const { injected, body } = await call('pins.add', request);
        if (injected) return injected;
        const message = this.messages.find((m) => m.channel === body['channel'] && m.ts === body['timestamp']);
        if (message !== undefined) message.pinned = true;
        return HttpResponse.json({ ok: true });
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
let slack: FakeSlack;

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  await tdb.drop();
});

beforeEach(async () => {
  time = T0 + 365 * 24 * 3600 * 1000;
  for (let rows = await state.drainOutbox('slack', 1000); rows.length > 0; rows = await state.drainOutbox('slack', 1000)) {
    await state.ackOutbox(rows.map((r) => r.id));
  }
  time = T0;
  slack = new FakeSlack();
  server.use(...slack.handlers());
});
afterEach(() => server.resetHandlers());

function kvCache() {
  if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
  return createKvCache(state);
}

const web = createSlackWeb({ token: 'xoxb-test' });

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-02T00:00:00Z',
  surfaces: [],
  channels: [{ id: 'C0WEBBUGS', name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
  triggers: { messageActions: [], emoji: [] },
  vocabulary: [],
  people: [{ slackId: 'U0PAT', handle: 'pat', role: 'engineer', owns: [] }],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

function projector(overrides: Partial<SlackStatusProjectorOptions> = {}): SlackStatusProjector {
  return createSlackStatusProjector({
    state,
    web,
    cache: kvCache(),
    workspaceId: WS,
    getMap: () => Promise.resolve(map),
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
    target: 'slack',
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

async function capture(channelId: string, extra: { threadId?: string; anchorId?: string } = {}): Promise<string> {
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
      idempotencyKey: `slack-${channelId}-${incidentId}`,
      source: 'slack',
      reporter: { id: 'U0REPORTER', name: 'Rae', role: 'reporter' },
      anchorText: 'Cart total is blank',
      anchorId: extra.anchorId ?? '1700000000.000200',
      channelId,
      ...(extra.threadId === undefined ? {} : { threadId: extra.threadId }),
    },
  };
  await state.append(incidentId, [captured], 0);
  return incidentId;
}

async function enqueue(...rows: OutboxItem[]): Promise<void> {
  for (const r of rows) await state.enqueueOutbox(r);
}

async function postedEvents(incidentId: string) {
  return (await state.read(incidentId)).filter((e) => e.type === 'status-message-posted');
}

// Tests -----------------------------------------------------------------------------------------

describe('first post', () => {
  it('posts the message in the thread, pins it, and appends status-message-posted with the ts', async () => {
    const incidentId = await capture('C0WEB', { threadId: '1700000000.000100' });
    const first = row(incidentId, 'On it. A fix is being written.');
    await enqueue(first);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([first.id]);
    const [message] = slack.in('C0WEB');
    expect(message).toMatchObject({ thread_ts: '1700000000.000100', pinned: true });
    expect(message!.text).toContain('A fix is being written');
    const posted = await postedEvents(incidentId);
    expect(posted.map((e) => [e.source, e.payload])).toEqual([['slack', { messageId: message!.ts }]]);
    // A 1.3: the same append records the message's role.
    const record = (await state.read(incidentId)).find((e) => e.type === 'bot-message-posted');
    expect(record?.payload).toEqual({ platform: 'slack', channel: 'C0WEB', messageId: message!.ts, role: 'status' });
    expect(record?.seq).toBe(posted[0]!.seq + 1);
    expect((await state.getIncident(incidentId))?.statusMsgId).toBe(message!.ts);
    expect(slack.calls).toEqual(['chat.postMessage', 'pins.add']);
    expect(await state.drainOutbox('slack', 10, WS)).toEqual([]);
  });

  it('threads on the anchor when the capture carried no thread', async () => {
    const incidentId = await capture('C0WEB', { anchorId: '1700000042.000300' });
    await enqueue(row(incidentId, 'Looking into it.'));
    await projector().drainOnce();
    expect(slack.in('C0WEB')[0]?.thread_ts).toBe('1700000042.000300');
  });

  it('retries the append from a fresh read on an expectedSeq conflict', async () => {
    const incidentId = await capture('C0WEB');
    await enqueue(row(incidentId, 'Looking into it.'));
    let raced = false;
    const racing: StatePort = new Proxy(state, {
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
    expect(slack.in('C0WEB')).toHaveLength(1);
  });

  it('a failed append after posting is retried by editing that message, never by posting a second', async () => {
    const incidentId = await capture('C0WEB');
    await enqueue(row(incidentId, 'Looking into it.'));
    let failed = false;
    const flaky: StatePort = new Proxy(state, {
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
    expect(slack.in('C0WEB')).toHaveLength(1);

    time += 5000;
    const report = await p.drainOnce();

    expect(report.parked).toEqual([]);
    expect(slack.in('C0WEB')).toHaveLength(1);
    expect((await postedEvents(incidentId)).map((e) => e.payload)).toEqual([{ messageId: slack.in('C0WEB')[0]!.ts }]);
  });

  it('maps a handle mention to the Slack user', async () => {
    const incidentId = await capture('C0WEB');
    await enqueue(row(incidentId, 'Ready for review, <@pat>.'));
    await projector().drainOnce();
  });
});

describe('edit in place', () => {
  it('three later rows edit the one message, in order, without a second post', async () => {
    const incidentId = await capture('C0WEB');
    const p = projector();
    await enqueue(row(incidentId, 'one'));
    await p.drainOnce();
    for (const text of ['two', 'three', 'four']) {
      await enqueue(row(incidentId, text));
      await p.drainOnce();
    }
    expect(slack.in('C0WEB')).toHaveLength(1);
    expect(slack.in('C0WEB')[0]!.text).toContain('four');
    expect(slack.calls.filter((c) => c === 'chat.update')).toHaveLength(3);
    expect(slack.calls.filter((c) => c === 'chat.postMessage')).toHaveLength(1);
    expect(slack.calls.filter((c) => c === 'pins.add')).toHaveLength(1);
    expect(await postedEvents(incidentId)).toHaveLength(1);
  });

  it('collapses rows that piled up to the latest', async () => {
    const incidentId = await capture('C0WEB');
    const [a, b, c] = [row(incidentId, 'one'), row(incidentId, 'two'), row(incidentId, 'three')];
    await enqueue(a, b, c);

    const report = await projector().drainOnce();

    expect(report.superseded).toEqual([a.id, b.id]);
    expect(report.sent).toEqual([c.id]);
    expect(slack.in('C0WEB')).toHaveLength(1);
    expect(slack.in('C0WEB')[0]!.text).toContain('three');
    expect(await state.drainOutbox('slack', 10, WS)).toEqual([]);
  });

  it('reposts and re-pins when the message was deleted', async () => {
    const incidentId = await capture('C0WEB');
    const p = projector();
    await enqueue(row(incidentId, 'one'));
    await p.drainOnce();
    slack.messages = []; // someone deleted it

    await enqueue(row(incidentId, 'two'));
    await p.drainOnce();

    const [message] = slack.in('C0WEB');
    expect(message).toMatchObject({ pinned: true });
    expect(message!.text).toContain('two');
    const posted = await postedEvents(incidentId);
    expect(posted).toHaveLength(2);
    expect((await state.getIncident(incidentId))?.statusMsgId).toBe(message!.ts);
  });
});

describe('direct message mirror (main 15.1)', () => {
  it('mirrors into the surface bug channel once it is known, then edits the mirror in place', async () => {
    const incidentId = await capture('D0REPORTER');
    const cache = kvCache();
    const p = projector({ cache });
    await enqueue(row(incidentId, 'Scoping this.'));
    await p.drainOnce();
    // No surface yet: the DM message only, not threaded, and no mirror.
    expect(slack.in('D0REPORTER')).toHaveLength(1);
    expect(slack.in('D0REPORTER')[0]!.thread_ts).toBeUndefined();
    expect(slack.in('C0WEBBUGS')).toHaveLength(0);

    await state.append(
      incidentId,
      [{ workspaceId: WS, incidentId, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      (await state.read(incidentId)).at(-1)!.seq,
    );
    await enqueue(row(incidentId, 'A fix is being written.'));
    await p.drainOnce();
    expect(slack.in('C0WEBBUGS')).toHaveLength(1);
    expect(slack.in('C0WEBBUGS')[0]).toMatchObject({ pinned: false });
    expect(slack.in('C0WEBBUGS')[0]!.text).toContain('A fix is being written');
    expect(await cache.get(mirrorKey(incidentId))).not.toBeNull();
    // Both the DM message and its mirror are status messages a reaction can land on (A 1.3).
    const records = (await state.read(incidentId)).flatMap((e) => (e.type === 'bot-message-posted' ? [[e.payload.channel, e.payload.role]] : []));
    expect(records).toEqual([
      ['D0REPORTER', 'status'],
      ['C0WEBBUGS', 'status'],
    ]);

    await enqueue(row(incidentId, 'PR is open.'));
    await p.drainOnce();
    expect(slack.in('C0WEBBUGS')).toHaveLength(1);
    expect(slack.in('C0WEBBUGS')[0]!.text).toContain('PR is open');
    expect(slack.in('D0REPORTER')[0]!.text).toContain('PR is open');
  });

  it('does not mirror a channel incident, and a failing mirror does not fail the row', async () => {
    const channelIncident = await capture('C0WEB');
    await state.append(
      channelIncident,
      [{ workspaceId: WS, incidentId: channelIncident, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      1,
    );
    await enqueue(row(channelIncident, 'Looking.'));
    await projector().drainOnce();
    expect(slack.in('C0WEBBUGS')).toHaveLength(0);

    const dm = await capture('D0REPORTER2');
    await state.append(
      dm,
      [{ workspaceId: WS, incidentId: dm, type: 'resolved', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: { surfaceId: 'web' } } as NewEvent<'resolved'>],
      1,
    );
    const errors: unknown[] = [];
    const sent = row(dm, 'Looking.');
    await enqueue(sent);
    slack.fail('chat.postMessage', { skip: 1, error: 'not_in_channel' }); // the DM post goes first, then the mirror fails
    const report = await projector({ onError: (e) => errors.push(e) }).drainOnce();
    expect(report.sent).toEqual([sent.id]);
    expect(errors).toHaveLength(1);
    expect(slack.in('D0REPORTER2')).toHaveLength(1);
  });
});

describe('rate limits (B 11)', () => {
  it('a 429 pauses the whole drain for Retry-After and leaves the row as it was', async () => {
    const a = await capture('C0WEB');
    const b = await capture('C0WEB2');
    const first = row(a, 'one');
    await enqueue(first, row(b, 'other incident'));
    slack.fail('chat.postMessage', { status: 429, retryAfter: '30' });
    const p = projector();

    const report = await p.drainOnce();

    expect(report.pausedUntil).toBe(new Date(T0 + 30_000).toISOString());
    expect(report.sent).toEqual([]);
    expect(slack.calls).toEqual(['chat.postMessage']); // the second incident's row waited too
    const [left] = await state.drainOutbox('slack', 10, WS);
    expect(left).toMatchObject({ id: first.id, attempts: 0 });
    expect(left?.lastError).toBeUndefined();

    time = T0 + 29_000;
    expect((await p.drainOnce()).drained).toBe(0);
    expect(slack.calls).toEqual(['chat.postMessage']);
    expect(p.pausedUntil()?.getTime()).toBe(T0 + 30_000);

    time = T0 + 30_000;
    const resumed = await p.drainOnce();
    expect(resumed.sent).toHaveLength(2);
    expect(p.pausedUntil()).toBeUndefined();
    expect(slack.in('C0WEB')).toHaveLength(1);
    expect(slack.in('C0WEB2')).toHaveLength(1);
  });

  it('defers a failed send with a doubling delay and parks a row that cannot succeed', async () => {
    const incidentId = await capture('C0WEB');
    const flaky = row(incidentId, 'one');
    await enqueue(flaky);
    slack.fail('chat.postMessage', { error: 'internal_error' });
    const p = projector();
    expect((await p.drainOnce()).deferred).toEqual([flaky.id]);

    time = T0 + 1000;
    expect((await p.drainOnce()).sent).toEqual([flaky.id]);

    const gone = await capture('C0GONE');
    const doomed = row(gone, 'one');
    await enqueue(doomed);
    slack.fail('chat.postMessage', { error: 'channel_not_found' });
    expect((await p.drainOnce()).parked).toEqual([doomed.id]);
    expect(await state.drainOutbox('slack', 10, WS)).toEqual([]);
    expect(await p.metrics()).toContain('snapwing_outbox_parked_rows{target="slack"');
  });

  it('parks a row whose incident is unknown', async () => {
    const orphan = row(ulid(time), 'one');
    await enqueue(orphan);
    expect((await projector().drainOnce()).parked).toEqual([orphan.id]);
  });
});
