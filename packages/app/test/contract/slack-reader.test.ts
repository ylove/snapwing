import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import type { CanonicalIncidentPayload } from '@snapwing/pipeline/contracts/incident.ts';
import {
  SlackApiError,
  SlackNotInvitedError,
  SlackRateLimitError,
  createSlackWeb,
} from '../../src/adapters/slack/web.ts';
import { createSlackContextSource, isoToSlackTs, slackTsToIso } from '../../src/adapters/slack/reader.ts';

const API = 'https://slack.com/api';
const TOKEN = 'xoxb-test';
const AUTH = `Bearer ${TOKEN}`;

function fixture(name: string): JsonBodyType {
  return JSON.parse(readFileSync(new URL(`../fixtures/slack-web/${name}.json`, import.meta.url), 'utf8'));
}

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const web = createSlackWeb({ token: TOKEN });
const source = createSlackContextSource(web);
const reader = source.reader;

function payload(over: Partial<CanonicalIncidentPayload['context']> = {}, key = 'slack-C0PUB-1790000100.000100'): CanonicalIncidentPayload {
  return {
    eventId: '01J000000000000000000000AA',
    idempotencyKey: key,
    source: 'slack',
    reporter: { id: 'U0AAA' } as CanonicalIncidentPayload['reporter'],
    anchorText: 'Cart total is blank after promo',
    context: { channelId: 'C0PUB', rawPayloadSnapshot: {}, ...over },
    timestamp: '2026-10-02T00:00:00.000Z',
  };
}

describe('client', () => {
  it('maps ok:false to SlackApiError and sends the token only in the header', async () => {
    let seen: { auth: string | null; url: string } | undefined;
    server.use(
      http.post(`${API}/chat.postMessage`, ({ request }) => {
        seen = { auth: request.headers.get('authorization'), url: request.url };
        return HttpResponse.json({ ok: false, error: 'channel_not_found' });
      }),
    );
    const err = await web.postMessage({ channel: 'C1', text: 'hi' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackApiError);
    expect((err as SlackApiError).error).toBe('channel_not_found');
    expect(seen?.auth).toBe(AUTH);
    expect(seen?.url).not.toContain(TOKEN);
    expect((err as Error).message).not.toContain(TOKEN);
  });

  it('posts JSON for write methods', async () => {
    const bodies: Record<string, unknown> = {};
    for (const method of ['chat.postMessage', 'chat.update', 'chat.postEphemeral', 'pins.add', 'reactions.add', 'conversations.join']) {
      server.use(
        http.post(`${API}/${method}`, async ({ request }) => {
          bodies[method] = await request.json();
          return HttpResponse.json({ ok: true, channel: 'C1', ts: '1.000001', message_ts: '2.000002' });
        }),
      );
    }
    expect(await web.postMessage({ channel: 'C1', text: 'a' })).toEqual({ channel: 'C1', ts: '1.000001' });
    await web.updateMessage({ channel: 'C1', ts: '1.000001', text: 'b' });
    expect(await web.postEphemeral({ channel: 'C1', user: 'U1', text: 'c' })).toEqual({ messageTs: '2.000002' });
    await web.pinsAdd('C1', '1.000001');
    await web.reactionsAdd('C1', '1.000001', 'white_check_mark');
    await web.conversationsJoin('C1');
    expect(bodies['pins.add']).toEqual({ channel: 'C1', timestamp: '1.000001' });
    expect(bodies['reactions.add']).toEqual({ channel: 'C1', timestamp: '1.000001', name: 'white_check_mark' });
    expect(bodies['chat.update']).toEqual({ channel: 'C1', ts: '1.000001', text: 'b' });
  });

  it('reads users and reactions', async () => {
    server.use(
      http.get(`${API}/users.info`, ({ request }) =>
        HttpResponse.json({ ok: true, user: { id: new URL(request.url).searchParams.get('user'), profile: { email: 'a@example.com' } } }),
      ),
      http.get(`${API}/users.list`, () =>
        HttpResponse.json({ ok: true, members: [{ id: 'U1' }], response_metadata: { next_cursor: 'n' } }),
      ),
      http.get(`${API}/reactions.get`, () =>
        HttpResponse.json({
          ok: true,
          message: { ts: '1.000001', thread_ts: '1.000000', text: 'a reply', reactions: [{ name: 'bug', users: ['U1', 'U2'], count: 2 }] },
        }),
      ),
    );
    expect((await web.usersInfo('U9')).id).toBe('U9');
    expect(await web.usersList()).toEqual({ members: [{ id: 'U1' }], nextCursor: 'n' });
    const got = await web.reactionsGet('C1', '1.000001');
    expect(got.reactions).toEqual([{ name: 'bug', users: ['U1', 'U2'], count: 2 }]);
    expect(got.message).toMatchObject({ ts: '1.000001', thread_ts: '1.000000', text: 'a reply' });
  });

  it('maps HTTP 429 to SlackRateLimitError with Retry-After', async () => {
    server.use(
      http.get(`${API}/conversations.history`, () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '7' } })),
    );
    const err = await web.conversationsHistory({ channel: 'C0PUB' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackRateLimitError);
    expect((err as SlackRateLimitError).retryAfterMs).toBe(7000);
  });
});

describe('reader', () => {
  it('paginates history by cursor, drops thread replies, and returns oldest first', async () => {
    const queries: URLSearchParams[] = [];
    server.use(
      http.get(`${API}/conversations.history`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        queries.push(q);
        return HttpResponse.json(fixture(q.get('cursor') === 'cursor-2' ? 'history-page2' : 'history-page1'));
      }),
    );
    const oldest = slackTsToIso('1790000000.000000');
    const latest = slackTsToIso('1790000600.000000');
    const messages = await reader.history('C0PUB', oldest, latest, 40);
    expect(queries).toHaveLength(2);
    expect(queries[0]?.get('oldest')).toBe(isoToSlackTs(oldest));
    expect(queries[0]?.get('cursor')).toBeNull();
    expect(messages.map((m) => m.id)).toEqual(['1790000050.000100', '1790000100.000100', '1790000300.000200']);
    const parent = messages[1];
    expect(parent?.replyCount).toBe(2);
    expect(parent?.attachments).toEqual([
      { kind: 'image', url: 'https://files.slack.com/files-pri/T0-F0001/download/cart.png', mimeType: 'image/png' },
    ]);
    expect(messages[0]?.attachments).toEqual([{ kind: 'link', url: 'https://example.com/cart', extractedText: 'Your cart' }]);
    expect(messages[2]?.mentions).toEqual(['U0CCC']);
    expect(messages[2]?.reactions).toEqual(['eyes']);
    expect((await reader.history('C0PUB', oldest, latest, 2)).map((m) => m.id)).toEqual(['1790000100.000100', '1790000300.000200']);
  });

  it('keeps the limit messages nearest the midpoint of the window, oldest first', async () => {
    // 100 messages, one every 6 seconds from ts 1790000000 to 1790000594; midpoint is 1790000300.
    const wire = Array.from({ length: 100 }, (_, i) => ({ type: 'message', user: 'U0AAA', text: `m${i}`, ts: `${1790000000 + i * 6}.000100` }));
    server.use(
      http.get(`${API}/conversations.history`, () =>
        HttpResponse.json({ ok: true, messages: [...wire].reverse(), has_more: false }),
      ),
    );
    const oldest = slackTsToIso('1790000000.000000');
    const latest = slackTsToIso('1790000600.000000');
    const messages = await reader.history('C0PUB', oldest, latest, 40);
    expect(messages).toHaveLength(40);
    // Nearest 40 to 300s are indexes 30..69 (offsets 180s to 414s) by distance: 31..70 vs 30..69 tie-break.
    const idx = messages.map((m) => Number(m.text.slice(1)));
    expect(idx).toEqual(Array.from({ length: 40 }, (_, k) => idx[0]! + k));
    expect(idx[0]).toBeGreaterThanOrEqual(30);
    expect(idx[0]).toBeLessThanOrEqual(31);
    expect(idx).toContain(50);
  });

  it('reads a thread, parent first, and returns empty when there is no thread', async () => {
    server.use(
      http.get(`${API}/conversations.replies`, ({ request }) => {
        const ts = new URL(request.url).searchParams.get('ts');
        return HttpResponse.json(fixture(ts === '1790000400.000100' ? 'replies-no-thread' : 'replies'));
      }),
    );
    const thread = await reader.replies('C0PUB', '1790000100.000100');
    expect(thread.map((m) => m.id)).toEqual(['1790000100.000100', '1790000150.000100', '1790000200.000100']);
    expect(thread[1]?.threadParentId).toBe('1790000100.000100');
    expect(await reader.replies('C0PUB', '1790000400.000100')).toEqual([]);
  });

  it('joins a public channel once on not_in_channel and retries', async () => {
    let history = 0;
    let joins = 0;
    server.use(
      http.get(`${API}/conversations.history`, () => {
        history += 1;
        return HttpResponse.json(history === 1 ? fixture('not-in-channel') : fixture('history-page2'));
      }),
      http.post(`${API}/conversations.join`, async ({ request }) => {
        joins += 1;
        expect(await request.json()).toEqual({ channel: 'C0PUB' });
        return HttpResponse.json(fixture('join-ok'));
      }),
    );
    const messages = await reader.history('C0PUB', slackTsToIso('1790000000.000000'), slackTsToIso('1790000600.000000'), 40);
    expect(joins).toBe(1);
    expect(history).toBe(2);
    expect(messages).toHaveLength(1);
  });

  it('does not join twice: a second not_in_channel after joining is an invite request', async () => {
    let joins = 0;
    server.use(
      http.get(`${API}/conversations.history`, () => HttpResponse.json(fixture('not-in-channel'))),
      http.post(`${API}/conversations.join`, () => {
        joins += 1;
        return HttpResponse.json(fixture('join-ok'));
      }),
    );
    await expect(reader.history('C0PUB', slackTsToIso('1790000000.000000'), slackTsToIso('1790000600.000000'), 40)).rejects.toBeInstanceOf(
      SlackNotInvitedError,
    );
    expect(joins).toBe(1);
  });

  it('yields SlackNotInvitedError for a private channel that cannot be joined', async () => {
    server.use(
      http.get(`${API}/conversations.replies`, () => HttpResponse.json(fixture('not-in-channel'))),
      http.post(`${API}/conversations.join`, () => HttpResponse.json(fixture('cant-join-private'))),
    );
    const err = await reader.replies('G0PRIV', '1790000100.000100').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SlackNotInvitedError);
    expect((err as SlackNotInvitedError).channelId).toBe('G0PRIV');
  });

  it('propagates a 429 from the reader', async () => {
    server.use(http.get(`${API}/conversations.replies`, () => new HttpResponse(null, { status: 429, headers: { 'retry-after': '2' } })));
    await expect(reader.replies('C0PUB', '1.000001')).rejects.toBeInstanceOf(SlackRateLimitError);
  });
});

describe('anchor', () => {
  it('is deterministic and reads the message by ts from the snapshot or the idempotency key', async () => {
    server.use(
      http.get(`${API}/conversations.replies`, ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect(q.get('ts')).toBe('1790000100.000100');
        expect(q.get('oldest')).toBe('1790000100.000100');
        return HttpResponse.json(fixture('replies'));
      }),
    );
    const a = await source.anchor(payload());
    const b = await source.anchor(payload({ rawPayloadSnapshot: { message_ts: '1790000100.000100' } }, 'other-key'));
    expect(a).toEqual(b);
    expect(a.channelId).toBe('C0PUB');
    expect(a.message.id).toBe('1790000100.000100');
    expect(a.direct).toBeUndefined();
  });

  it('marks a DM anchor as direct and reads a thread reply through its parent', async () => {
    let ts: string | null = null;
    server.use(
      http.get(`${API}/conversations.replies`, ({ request }) => {
        ts = new URL(request.url).searchParams.get('ts');
        return HttpResponse.json(fixture('replies'));
      }),
    );
    const a = await source.anchor(payload({ channelId: 'D0DM', threadId: '1790000100.000100' }, 'slack-D0DM-1790000150.000100'));
    expect(ts).toBe('1790000100.000100');
    expect(a.message.id).toBe('1790000150.000100');
    expect(a.direct).toBe(true);
  });
});

describe('image download', () => {
  const URL_ = 'https://files.slack.com/files-pri/T0-F0001/download/cart.png';
  const attachment = { kind: 'image' as const, url: URL_, mimeType: 'image/png' };

  it('sends the bot token in the Authorization header, never in the URL', async () => {
    const png = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
    let seen: { auth: string | null; url: string } | undefined;
    server.use(
      http.get(URL_, ({ request }) => {
        seen = { auth: request.headers.get('authorization'), url: request.url };
        return new HttpResponse(png, { headers: { 'content-type': 'image/png' } });
      }),
    );
    const image = await source.loadImage(attachment);
    expect(seen?.auth).toBe(AUTH);
    expect(seen?.url).toBe(URL_);
    expect(image).toEqual({ mimeType: 'image/png', data: Buffer.from(png).toString('base64'), ref: URL_ });
  });

  it('returns undefined for a login page, a non-Slack host, or a failure', async () => {
    server.use(http.get(URL_, () => new HttpResponse('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })));
    expect(await source.loadImage({ kind: 'image', url: URL_ })).toBeUndefined();
    expect(await source.loadImage({ kind: 'image', url: 'https://evil.example.com/x.png', mimeType: 'image/png' })).toBeUndefined();
    server.use(http.get(URL_, () => new HttpResponse(null, { status: 403 })));
    expect(await source.loadImage(attachment)).toBeUndefined();
    expect(await source.loadImage({ kind: 'link', url: URL_ })).toBeUndefined();
  });
});

describe('recording download', () => {
  const URL_ = 'https://files.slack.com/files-pri/T0-F0002/download/repro.mp4';
  const attachment = { kind: 'file' as const, url: URL_, mimeType: 'video/mp4' };

  it('sends the bot token in the Authorization header and returns the bytes', async () => {
    const mp4 = Uint8Array.from([0, 0, 0, 0x18, 0x66, 0x74, 0x79, 0x70, 9, 8, 7]);
    let seen: { auth: string | null; url: string } | undefined;
    server.use(
      http.get(URL_, ({ request }) => {
        seen = { auth: request.headers.get('authorization'), url: request.url };
        return new HttpResponse(mp4, { headers: { 'content-type': 'video/mp4' } });
      }),
    );
    const bytes = await source.loadRecording(attachment);
    expect(seen?.auth).toBe(AUTH);
    expect(seen?.url).toBe(URL_);
    expect(Buffer.from(bytes ?? []).equals(Buffer.from(mp4))).toBe(true);
  });

  it('returns undefined for a login page, a non-Slack host, a failure, or a non-video', async () => {
    server.use(http.get(URL_, () => new HttpResponse('<html>sign in</html>', { headers: { 'content-type': 'text/html' } })));
    expect(await source.loadRecording(attachment)).toBeUndefined();
    expect(await source.loadRecording({ ...attachment, url: 'https://evil.example.com/x.mp4' })).toBeUndefined();
    server.use(http.get(URL_, () => new HttpResponse(null, { status: 403 })));
    expect(await source.loadRecording(attachment)).toBeUndefined();
    expect(await source.loadRecording({ kind: 'file', url: URL_, mimeType: 'application/pdf' })).toBeUndefined();
    expect(await source.loadRecording({ kind: 'image', url: URL_, mimeType: 'image/png' })).toBeUndefined();
  });
});
