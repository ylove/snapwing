import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type { IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { ACK_TEXT, createSlackAdapter, type SlackInbound } from '../../src/adapters/slack/adapter.ts';
import {
  SLACK_EVENTS_PATH,
  SLACK_INTERACTIVITY_PATH,
  createSlackTransport,
  type SocketLike,
} from '../../src/adapters/slack/transport.ts';
import type { SlackWeb } from '../../src/adapters/slack/web.ts';
import { createApiServer } from '../../src/server/http.ts';

const SECRET = 'signing-secret-test';
const BOT = 'U0BOT';
const NOW = new Date(1_700_000_500_000);
const NOW_S = Math.floor(NOW.getTime() / 1000);

function fixture(name: string): Record<string, unknown> {
  return JSON.parse(readFileSync(new URL(`../fixtures/slack/${name}.json`, import.meta.url), 'utf8')) as Record<string, unknown>;
}

const map: WorkspaceMap = {
  org: 'Example',
  updated: '2026-10-02T00:00:00Z',
  surfaces: [],
  channels: [{ id: 'C0WEB', name: 'web-bugs', surface: 'web', triggerEmoji: [] }],
  triggers: {
    messageActions: [{ label: 'Fix it from here' }],
    emoji: [{ slack: 'bug', teams: 'bug' }],
    directMessage: { images: true, text: true },
  },
  vocabulary: [],
  people: [{ slackId: 'U0REPORTER', handle: 'rae', email: 'rae@example.com', role: 'reporter', owns: [] }],
  policies: { autonomy: { default: 1, levels: [], overrides: [] } },
};

function fakeWeb(over: Partial<SlackWeb> = {}): SlackWeb & Record<string, ReturnType<typeof vi.fn>> {
  const web = {
    postMessage: vi.fn(() => Promise.resolve({ channel: 'C0WEB', ts: '1700000600.000100' })),
    updateMessage: vi.fn(() => Promise.resolve({ channel: 'C0WEB', ts: '1700000600.000100' })),
    postEphemeral: vi.fn(() => Promise.resolve({})),
    pinsAdd: vi.fn(() => Promise.resolve()),
    reactionsAdd: vi.fn(() => Promise.resolve()),
    reactionsGet: vi.fn(() => Promise.resolve({ reactions: [{ name: 'bug', users: ['U0REPORTER'] }] })),
    conversationsHistory: vi.fn(() => Promise.resolve({ messages: [{ ts: '1700000000.000200', text: 'Checkout total shows NaN' }] })),
    conversationsReplies: vi.fn(() => Promise.resolve({ messages: [] })),
    conversationsJoin: vi.fn(() => Promise.resolve()),
    usersInfo: vi.fn(),
    usersList: vi.fn(),
    downloadFile: vi.fn(),
    ...over,
  };
  return web as unknown as SlackWeb & Record<string, ReturnType<typeof vi.fn>>;
}

function sign(body: string, ts: number | string = NOW_S, secret = SECRET): string {
  return `v0=${createHmac('sha256', secret).update(`v0:${ts}:${body}`).digest('hex')}`;
}

function signedRequest(path: string, body: string, signature = sign(body)): Request {
  return new Request(`http://snapwing.test${path}`, {
    method: 'POST',
    headers: { 'x-slack-request-timestamp': String(NOW_S), 'x-slack-signature': signature, 'content-type': 'application/x-www-form-urlencoded' },
    body,
  });
}

const formBody = (payload: unknown): string => new URLSearchParams({ payload: JSON.stringify(payload) }).toString();

/** A handleInbound with the orchestrator's shape: authenticate, normalize, start a job (not awaited), acknowledge. */
function engine(adapter: ReturnType<typeof createSlackAdapter>, job: (p: CanonicalIncidentPayload) => Promise<void> = () => Promise.resolve()) {
  const payloads: CanonicalIncidentPayload[] = [];
  const handleInbound = vi.fn(async (_source: string, raw: unknown) => {
    const inbound = raw as SlackInbound;
    if (!(await adapter.authenticateRequest(inbound))) throw new Error('unauthorized');
    const payload = await adapter.normalizePayload(inbound);
    payloads.push(payload);
    void job(payload);
    return adapter.acknowledge(inbound, payload);
  });
  return { handleInbound, payloads };
}

function setup(opts: { web?: ReturnType<typeof fakeWeb>; job?: (p: CanonicalIncidentPayload) => Promise<void> } = {}) {
  const web = opts.web ?? fakeWeb();
  const onError = vi.fn();
  const adapter = createSlackAdapter({
    web,
    signingSecret: SECRET,
    botUserId: BOT,
    getMap: () => Promise.resolve(map),
    workspaceDomain: 'example',
    clock: () => NOW,
    newEventId: () => '01HZZZZZZZZZZZZZZZZZZZZZZZ',
    onError,
  });
  const { handleInbound, payloads } = engine(adapter, opts.job);
  const onAction = vi.fn();
  const transport = createSlackTransport({ mode: 'http', adapter, handleInbound, onAction, onError });
  const route = (path: string) => {
    const found = transport.routes.find((r) => r.path === path);
    if (found === undefined) throw new Error(`no route ${path}`);
    return found.handler;
  };
  return { web, adapter, handleInbound, payloads, onAction, onError, transport, route };
}

const ctx = { params: {} };

describe('SlackAdapter over HTTP', () => {
  it('message shortcut: acks 200, starts the incident, posts the ephemeral in the thread', async () => {
    const { route, payloads, web, handleInbound } = setup();
    const res = await route(SLACK_INTERACTIVITY_PATH)(signedRequest(SLACK_INTERACTIVITY_PATH, formBody(fixture('message-action'))), ctx);
    expect(res.status).toBe(200);
    expect(handleInbound).toHaveBeenCalledTimes(1);
    expect(payloads[0]?.idempotencyKey).toBe('slack-C0WEB-1700000000.000200');
    expect(web.postEphemeral).toHaveBeenCalledWith({
      channel: 'C0WEB',
      user: 'U0REPORTER',
      text: ACK_TEXT,
      thread_ts: '1699999900.000100',
    });
  });

  it('emoji trigger: normalizes once (anchor text from history) and acks', async () => {
    const { route, payloads, web } = setup();
    const res = await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, JSON.stringify(fixture('reaction-added'))), ctx);
    expect(res.status).toBe(200);
    expect(payloads).toHaveLength(1);
    expect(payloads[0]?.anchorText).toBe('Checkout total shows NaN');
    expect(payloads[0]?.idempotencyKey).toBe('slack-C0WEB-1700000000.000200-bug');
    expect(web.reactionsGet).toHaveBeenCalledTimes(1);
  });

  it('emoji trigger on a thread reply: the reply text is the anchor and the parent ts is the thread', async () => {
    const PARENT = '1699999900.000100';
    const reply = { ts: '1700000000.000200', thread_ts: PARENT, text: 'It also fails on Safari' };
    const web = fakeWeb({
      reactionsGet: vi.fn(() => Promise.resolve({ reactions: [{ name: 'bug', users: ['U0REPORTER'] }], message: reply })),
      // A reply inside a thread is absent from conversations.history.
      conversationsHistory: vi.fn(() => Promise.resolve({ messages: [] })),
    });
    const { route, payloads } = setup({ web });
    const res = await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, JSON.stringify(fixture('reaction-added'))), ctx);
    expect(res.status).toBe(200);
    expect(payloads[0]?.anchorText).toBe('It also fails on Safari');
    expect(payloads[0]?.context.threadId).toBe(PARENT);
    expect(web.conversationsHistory).not.toHaveBeenCalled();
  });

  it('emoji trigger on a thread reply without text in reactions.get: falls back to conversations.replies', async () => {
    const PARENT = '1699999900.000100';
    const web = fakeWeb({
      reactionsGet: vi.fn(() =>
        Promise.resolve({ reactions: [{ name: 'bug', users: ['U0REPORTER'] }], message: { ts: '1700000000.000200', thread_ts: PARENT } }),
      ),
      conversationsHistory: vi.fn(() => Promise.resolve({ messages: [] })),
      conversationsReplies: vi.fn(() =>
        Promise.resolve({ messages: [{ ts: '1700000000.000200', thread_ts: PARENT, text: 'Reply text from replies' }] }),
      ),
    });
    const { route, payloads } = setup({ web });
    await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, JSON.stringify(fixture('reaction-added'))), ctx);
    expect(web.conversationsReplies).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C0WEB', ts: PARENT }));
    expect(payloads[0]?.anchorText).toBe('Reply text from replies');
    expect(payloads[0]?.context.threadId).toBe(PARENT);
  });

  it('DM with an image: acks in the DM without a thread, and cards post in the DM', async () => {
    const { route, payloads, web, adapter } = setup();
    const res = await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, JSON.stringify(fixture('message-im-image'))), ctx);
    expect(res.status).toBe(200);
    const payload = payloads[0];
    expect(payload?.context.channelId).toBe('D0DM');
    expect(web.postEphemeral).toHaveBeenCalledWith({ channel: 'D0DM', user: 'U0REPORTER', text: ACK_TEXT });
    if (payload === undefined) throw new Error('no payload');
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    const posted = vi.mocked(web.postMessage).mock.calls[0]?.[0] as unknown as Record<string, unknown>;
    expect(posted['channel']).toBe('D0DM');
    expect(posted).not.toHaveProperty('thread_ts');
    expect(Array.isArray(posted['blocks'])).toBe(true);
  });

  it('postInteractive posts the card in the anchor thread', async () => {
    const { route, payloads, web, adapter } = setup();
    await route(SLACK_INTERACTIVITY_PATH)(signedRequest(SLACK_INTERACTIVITY_PATH, formBody(fixture('message-action'))), ctx);
    const payload = payloads[0];
    if (payload === undefined) throw new Error('no payload');
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    expect(web.postMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C0WEB', thread_ts: '1699999900.000100' }));
  });

  it('records each posted card and a new status message with its role (A 1.3, #287); an edit records nothing', async () => {
    const web = fakeWeb();
    const appended: NewEvent[] = [];
    const state = {
      read: () => Promise.resolve([{ workspaceId: 'W0FAKE', seq: 3 }] as unknown as IncidentEvent[]),
      append: (_id: string, events: NewEvent[], seq: number) => {
        appended.push(...events);
        return Promise.resolve({ seq: seq + events.length });
      },
    };
    const known = new Map<string, { channel: string; ts: string }>();
    const adapter = createSlackAdapter({
      web,
      signingSecret: SECRET,
      botUserId: BOT,
      getMap: () => Promise.resolve(map),
      clock: () => NOW,
      state,
      statusStore: { get: (id) => Promise.resolve(known.get(id)), set: (id, ref) => Promise.resolve(void known.set(id, ref)) },
    });
    const payload = { eventId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', context: { channelId: 'C0WEB', rawPayloadSnapshot: {} } } as unknown as CanonicalIncidentPayload;
    await adapter.postInteractive(payload, { kind: 'dedupe', issueKey: 'WEB-1', summary: 'Checkout total shows NaN' });
    await adapter.postInteractive(payload, { kind: 'clarify', question: { text: 'Which app?', audience: 'reporter' } } as never);
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'filed', text: 'Filed.' } as never);
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'fixing', text: 'Fixing.' } as never);
    expect(appended.map((e) => [e.incidentId, e.workspaceId, e.type, e.source, e.payload])).toEqual(
      ['dedupe', 'other', 'status'].map((role) => [
        '01HZZZZZZZZZZZZZZZZZZZZZZZ',
        'W0FAKE',
        'bot-message-posted',
        'slack',
        { platform: 'slack', channel: 'C0WEB', messageId: '1700000600.000100', role },
      ]),
    );
  });

  it('a failing record never fails the post', async () => {
    const web = fakeWeb();
    const onError = vi.fn();
    const state = { read: () => Promise.reject(new Error('db down')), append: vi.fn() };
    const adapter = createSlackAdapter({ web, signingSecret: SECRET, botUserId: BOT, getMap: () => Promise.resolve(map), clock: () => NOW, state, onError });
    const payload = { eventId: '01HZZZZZZZZZZZZZZZZZZZZZZZ', context: { channelId: 'C0WEB', rawPayloadSnapshot: {} } } as unknown as CanonicalIncidentPayload;
    await adapter.postInteractive(payload, { kind: 'scope-preview', summary: 'Checkout total shows NaN' });
    expect(web.postMessage).toHaveBeenCalledTimes(1);
    expect(onError).toHaveBeenCalledWith(expect.objectContaining({ message: 'db down' }));
  });

  it('a bad signature is 401 and reaches neither handleInbound nor onAction', async () => {
    const { route, handleInbound, onAction, web } = setup();
    const body = formBody(fixture('message-action'));
    const res = await route(SLACK_INTERACTIVITY_PATH)(signedRequest(SLACK_INTERACTIVITY_PATH, body, sign(body, NOW_S, 'wrong')), ctx);
    expect(res.status).toBe(401);
    const tap = await route(SLACK_INTERACTIVITY_PATH)(signedRequest(SLACK_INTERACTIVITY_PATH, formBody({ type: 'block_actions' }), 'v0=00'), ctx);
    expect(tap.status).toBe(401);
    expect(handleInbound).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    expect(web.postEphemeral).not.toHaveBeenCalled();
  });

  it('answers url_verification after checking the signature', async () => {
    const { route } = setup();
    const body = JSON.stringify({ type: 'url_verification', challenge: 'abc123', token: 'x' });
    const ok = await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, body), ctx);
    expect(ok.status).toBe(200);
    expect(await ok.json()).toEqual({ challenge: 'abc123' });
    const bad = await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, body, 'v0=00'), ctx);
    expect(bad.status).toBe(401);
  });

  it('hands interactivity payloads to onAction and acks without waiting for it', async () => {
    const { route, onAction, transport, handleInbound } = setup();
    let release: () => void = () => undefined;
    onAction.mockImplementation(() => new Promise<void>((resolve) => (release = resolve)));
    const tap = { type: 'block_actions', user: { id: 'U0ENG' }, actions: [{ action_id: 'approve_fix', value: 'inc1' }] };
    const res = await route(SLACK_INTERACTIVITY_PATH)(signedRequest(SLACK_INTERACTIVITY_PATH, formBody(tap)), ctx);
    expect(res.status).toBe(200);
    expect(onAction).toHaveBeenCalledWith(tap);
    expect(handleInbound).not.toHaveBeenCalled();
    release();
    await transport.dispatcher.idle();
  });

  it('ignored payloads (a bot message) are acked 200 and start nothing', async () => {
    const { route, handleInbound } = setup();
    const event = { ...fixture('message-im-text'), event: { ...(fixture('message-im-text')['event'] as object), user: BOT } };
    const res = await route(SLACK_EVENTS_PATH)(signedRequest(SLACK_EVENTS_PATH, JSON.stringify(event)), ctx);
    expect(res.status).toBe(200);
    expect(handleInbound).not.toHaveBeenCalled();
  });

  it('acks before slow downstream work finishes (3 s budget)', async () => {
    let finishJob: () => void = () => undefined;
    let jobDone = false;
    let ephemeralDone = false;
    const web = fakeWeb({
      postEphemeral: vi.fn(
        () =>
          new Promise<{ messageTs?: string }>((resolve) => {
            setTimeout(() => {
              ephemeralDone = true;
              resolve({});
            }, 50);
          }),
      ),
    });
    const { route } = setup({
      web,
      job: () =>
        new Promise<void>((resolve) => {
          finishJob = () => {
            jobDone = true;
            resolve();
          };
        }),
    });
    const res = await route(SLACK_INTERACTIVITY_PATH)(signedRequest(SLACK_INTERACTIVITY_PATH, formBody(fixture('message-action'))), ctx);
    expect(res.status).toBe(200);
    expect(jobDone).toBe(false);
    expect(ephemeralDone).toBe(false);
    finishJob();
    await vi.waitFor(() => expect(ephemeralDone).toBe(true));
  });

  it('a throwing handleInbound is a 500 for Slack to retry', async () => {
    const onError = vi.fn();
    const adapter = createSlackAdapter({ web: fakeWeb(), signingSecret: SECRET, botUserId: BOT, getMap: () => Promise.resolve(map), clock: () => NOW });
    const transport = createSlackTransport({
      mode: 'http',
      adapter,
      handleInbound: () => Promise.reject(new Error('queue down')),
      onAction: () => undefined,
      onError,
    });
    const handler = transport.routes[0]?.handler;
    const res = await handler?.(signedRequest(SLACK_INTERACTIVITY_PATH, formBody(fixture('message-action'))), ctx);
    expect(res?.status).toBe(500);
    expect(onError).toHaveBeenCalled();
  });

  it('works through the real router with the exact signed body', async () => {
    const { transport } = setup();
    const server = createApiServer({ routes: transport.routes, port: 0 });
    const res = await server.fetch(signedRequest(SLACK_INTERACTIVITY_PATH, formBody(fixture('message-action'))));
    expect(res.status).toBe(200);
  });
});

describe('SlackAdapter status', () => {
  it('posts and pins the first status, then edits it through the store', async () => {
    const web = fakeWeb();
    const refs = new Map<string, { channel: string; ts: string }>();
    const adapter = createSlackAdapter({
      web,
      signingSecret: SECRET,
      botUserId: BOT,
      getMap: () => Promise.resolve(map),
      statusStore: { get: (id) => Promise.resolve(refs.get(id)), set: (id, ref) => Promise.resolve(void refs.set(id, ref)) },
    });
    const payload = { eventId: 'inc1', context: { channelId: 'C0WEB', threadId: '1699999900.000100', rawPayloadSnapshot: {} } } as unknown as CanonicalIncidentPayload;
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'filed', text: 'Filed as WEB-1.' });
    expect(web.postMessage).toHaveBeenCalledTimes(1);
    expect(web.pinsAdd).toHaveBeenCalledWith('C0WEB', '1700000600.000100');
    await adapter.postStatus(payload, { issueKey: 'WEB-1', stage: 'fixing', text: 'Fixing.' });
    expect(web.updateMessage).toHaveBeenCalledWith(expect.objectContaining({ channel: 'C0WEB', ts: '1700000600.000100' }));
    expect(web.postMessage).toHaveBeenCalledTimes(1);
  });

  // #360: the A 5.2 note after That fixed it (#305, `issueKey: ''`) went out as the pinned status
  // message, "🐛 Great, no bug then...", so the live user-side row never found a note starting with it.
  it('a status with no issue key is a plain thread note: no emoji, no pin, not the status message, role other', async () => {
    const web = fakeWeb();
    const refs = new Map<string, { channel: string; ts: string }>();
    const appended: NewEvent[] = [];
    const state = {
      read: () => Promise.resolve([{ workspaceId: 'W0FAKE', seq: 3 }] as unknown as IncidentEvent[]),
      append: (_id: string, events: NewEvent[], seq: number) => {
        appended.push(...events);
        return Promise.resolve({ seq: seq + events.length });
      },
    };
    const adapter = createSlackAdapter({
      web,
      signingSecret: SECRET,
      botUserId: BOT,
      getMap: () => Promise.resolve(map),
      clock: () => NOW,
      state,
      statusStore: { get: (id) => Promise.resolve(refs.get(id)), set: (id, ref) => Promise.resolve(void refs.set(id, ref)) },
    });
    // A file share anchor in a channel (the live row's screenshot), not in a thread yet.
    const payload = { eventId: 'inc1', context: { channelId: 'C0WEB', rawPayloadSnapshot: { type: 'reaction_added', ts: '1699999900.000100' } } } as unknown as CanonicalIncidentPayload;
    await adapter.postStatus(payload, { issueKey: '', stage: 'clarified', text: 'Great, no bug then. Flagging that the staging link is easy to land on.' });

    expect(web.postMessage).toHaveBeenCalledTimes(1);
    const sent = vi.mocked(web.postMessage).mock.calls[0]?.[0] as { channel: string; text: string; thread_ts?: string; blocks: { text?: { text?: string } }[] };
    expect(sent.channel).toBe('C0WEB');
    expect(sent.thread_ts).toBe('1699999900.000100');
    expect(sent.text).toBe('Great, no bug then. Flagging that the staging link is easy to land on.');
    expect(sent.blocks[0]?.text?.text).toBe(sent.text);
    expect(web.pinsAdd).not.toHaveBeenCalled();
    expect(refs.size).toBe(0);
    expect(appended.map((e) => (e.payload as { role?: string }).role)).toEqual(['other']);
  });
});

describe('Socket Mode', () => {
  class FakeSocket implements SocketLike {
    sent: string[] = [];
    closed = false;
    private listeners = new Map<string, ((e: never) => void)[]>();
    send(data: string): void {
      this.sent.push(data);
    }
    close(): void {
      this.closed = true;
      this.emit('close', {});
    }
    addEventListener(type: string, listener: (e: never) => void): void {
      this.listeners.set(type, [...(this.listeners.get(type) ?? []), listener]);
    }
    emit(type: string, event: unknown): void {
      for (const l of this.listeners.get(type) ?? []) l(event as never);
    }
  }

  function socketSetup() {
    const sockets: FakeSocket[] = [];
    const urls: string[] = [];
    const calls: { url: string; auth: string | null }[] = [];
    const fetchStub = vi.fn((url: string | URL | Request, init?: RequestInit) => {
      calls.push({ url: String(url), auth: new Headers(init?.headers).get('authorization') });
      return Promise.resolve(Response.json({ ok: true, url: `wss://wss.slack.test/link/${calls.length}` }));
    }) as unknown as typeof fetch;
    const { web, adapter, handleInbound, payloads, onAction } = setup();
    const transport = createSlackTransport({
      mode: 'socket',
      appToken: 'xapp-test',
      adapter,
      handleInbound,
      onAction,
      fetch: fetchStub,
      reconnectDelayMs: 0,
      openSocket: (url) => {
        urls.push(url);
        const s = new FakeSocket();
        sockets.push(s);
        queueMicrotask(() => s.emit('open', {}));
        return s;
      },
    });
    return { transport, sockets, urls, calls, web, handleInbound, payloads, onAction };
  }

  it('opens with the app token, acks each envelope by id, and dispatches into handleInbound', async () => {
    const { transport, sockets, urls, calls, handleInbound, payloads, web } = socketSetup();
    expect(transport.routes).toEqual([]);
    await transport.start();
    expect(calls[0]?.url).toBe('https://slack.com/api/apps.connections.open');
    expect(calls[0]?.auth).toBe('Bearer xapp-test');
    expect(urls).toEqual(['wss://wss.slack.test/link/1']);
    const socket = sockets[0];
    if (socket === undefined) throw new Error('no socket');
    socket.emit('message', { data: JSON.stringify({ type: 'hello' }) });
    socket.emit('message', {
      data: JSON.stringify({ envelope_id: 'env-1', type: 'interactive', accepts_response_payload: false, payload: fixture('message-action') }),
    });
    // Acknowledged synchronously, before the dispatch has run.
    expect(socket.sent).toEqual([JSON.stringify({ envelope_id: 'env-1' })]);
    expect(handleInbound).not.toHaveBeenCalled();
    await vi.waitFor(() => expect(handleInbound).toHaveBeenCalledTimes(1));
    expect(payloads[0]?.idempotencyKey).toBe('slack-C0WEB-1700000000.000200');
    await vi.waitFor(() => expect(web.postEphemeral).toHaveBeenCalledTimes(1));
    socket.emit('message', { data: JSON.stringify({ envelope_id: 'env-2', type: 'events_api', payload: fixture('reaction-added') }) });
    expect(socket.sent).toContain(JSON.stringify({ envelope_id: 'env-2' }));
    await vi.waitFor(() => expect(handleInbound).toHaveBeenCalledTimes(2));
    await transport.stop();
  });

  it('routes interactive button taps to onAction', async () => {
    const { transport, sockets, onAction, handleInbound } = socketSetup();
    await transport.start();
    const tap = { type: 'block_actions', actions: [{ action_id: 'stop', value: 'inc1' }] };
    sockets[0]?.emit('message', { data: JSON.stringify({ envelope_id: 'env-3', type: 'interactive', payload: tap }) });
    await vi.waitFor(() => expect(onAction).toHaveBeenCalledWith(tap));
    expect(handleInbound).not.toHaveBeenCalled();
    await transport.stop();
  });

  it('reconnects after a disconnect envelope and stops cleanly', async () => {
    const { transport, sockets } = socketSetup();
    await transport.start();
    sockets[0]?.emit('message', { data: JSON.stringify({ type: 'disconnect', reason: 'refresh_requested' }) });
    expect(sockets[0]?.closed).toBe(true);
    await vi.waitFor(() => expect(sockets).toHaveLength(2));
    await transport.stop();
    expect(sockets[1]?.closed).toBe(true);
    await new Promise((r) => setTimeout(r, 20));
    expect(sockets).toHaveLength(2);
  });

  it('refuses to build without an app token', () => {
    const { adapter, handleInbound } = setup();
    expect(() => createSlackTransport({ mode: 'socket', appToken: '', adapter, handleInbound, onAction: () => undefined })).toThrow(/SLACK_APP_TOKEN/);
  });
});
