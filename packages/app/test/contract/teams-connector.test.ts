import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import {
  TeamsApiError,
  TeamsForbiddenError,
  TeamsNotFoundError,
  TeamsRateLimitError,
  TeamsServiceUrlError,
  createTeamsConnector,
} from '../../src/adapters/teams/connector.ts';

const SERVICE_URL = 'https://smba.test/amer/';
const V3 = 'https://smba.test/amer/v3';
const TOKEN = 'teams-test-token';
const AUTH = `Bearer ${TOKEN}`;
const CHANNEL = '19:5f3c0a7e9d2b4c1a8e6f@thread.tacv2';
const ROOT = '1790000100123';

function fixture(name: string): JsonBodyType {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/connector/${name}.json`, import.meta.url), 'utf8'));
}

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const connector = createTeamsConnector({ token: async () => TOKEN, botId: 'bot-app-id' });
const card = { type: 'message', attachments: [{ contentType: 'application/vnd.microsoft.card.adaptive', content: { type: 'AdaptiveCard' } }] };

interface Seen {
  method: string;
  path: string;
  url: string;
  auth: string | null;
  body: unknown;
}

function capture(seen: Seen[], request: Request, body: unknown): void {
  const url = new URL(request.url);
  seen.push({ method: request.method, path: decodeURIComponent(url.pathname), url: request.url, auth: request.headers.get('authorization'), body });
}

describe('calls', () => {
  it('sendToConversation posts the activity and returns its id', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(`${V3}/conversations/:id/activities`, async ({ request }) => {
        capture(seen, request, await request.json());
        return HttpResponse.json(fixture('send-ok'));
      }),
    );
    const out = await connector.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card);
    expect(out).toEqual({ id: ROOT });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ method: 'POST', path: `/amer/v3/conversations/${CHANNEL}/activities`, auth: AUTH, body: card });
  });

  it('accepts a serviceUrl with or without the trailing slash', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(`${V3}/conversations/:id/activities`, async ({ request }) => {
        capture(seen, request, await request.json());
        return HttpResponse.json(fixture('send-ok'));
      }),
    );
    await connector.sendToConversation({ serviceUrl: 'https://smba.test/amer', conversationId: CHANNEL }, card);
    expect(seen[0]?.path).toBe(`/amer/v3/conversations/${CHANNEL}/activities`);
  });

  it('replyToActivity answers a channel thread through <conversationId>;messageid=<rootId>', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(`${V3}/conversations/:id/activities/:activityId`, async ({ request }) => {
        capture(seen, request, await request.json());
        return HttpResponse.json(fixture('reply-ok'));
      }),
    );
    const out = await connector.replyToActivity(
      { serviceUrl: SERVICE_URL, conversationId: `${CHANNEL};messageid=999`, activityId: ROOT, threadRootId: ROOT },
      { type: 'message', text: 'On it' },
    );
    expect(out).toEqual({ id: '1790000100456' });
    expect(seen[0]).toMatchObject({
      method: 'POST',
      path: `/amer/v3/conversations/${CHANNEL};messageid=${ROOT}/activities/${ROOT}`,
      auth: AUTH,
      body: { type: 'message', text: 'On it', replyToId: ROOT },
    });
  });

  it('replyToActivity without a thread root replies in the conversation as given', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(`${V3}/conversations/:id/activities/:activityId`, async ({ request }) => {
        capture(seen, request, await request.json());
        return HttpResponse.json(fixture('reply-ok'));
      }),
    );
    await connector.replyToActivity({ serviceUrl: SERVICE_URL, conversationId: 'a:personal', activityId: ROOT }, { type: 'message', text: 'hi' });
    expect(seen[0]?.path).toBe(`/amer/v3/conversations/a:personal/activities/${ROOT}`);
  });

  it('updateActivity puts the card over the stored activity id', async () => {
    const seen: Seen[] = [];
    server.use(
      http.put(`${V3}/conversations/:id/activities/:activityId`, async ({ request }) => {
        capture(seen, request, await request.json());
        return HttpResponse.json(fixture('update-ok'));
      }),
    );
    const out = await connector.updateActivity({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, activityId: ROOT }, card);
    expect(out).toEqual({ id: ROOT });
    expect(seen[0]).toMatchObject({ method: 'PUT', path: `/amer/v3/conversations/${CHANNEL}/activities/${ROOT}`, auth: AUTH });
    expect(seen[0]?.body).toEqual({ ...card, id: ROOT });
  });

  it('deleteActivity sends DELETE and accepts an empty body', async () => {
    const seen: Seen[] = [];
    server.use(
      http.delete(`${V3}/conversations/:id/activities/:activityId`, ({ request }) => {
        capture(seen, request, undefined);
        return new HttpResponse(null, { status: 200 });
      }),
    );
    await expect(connector.deleteActivity({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, activityId: ROOT })).resolves.toBeUndefined();
    expect(seen[0]).toMatchObject({ method: 'DELETE', path: `/amer/v3/conversations/${CHANNEL}/activities/${ROOT}`, auth: AUTH });
  });

  it('createPersonalConversation opens a 1:1 chat in the tenant', async () => {
    const seen: Seen[] = [];
    server.use(
      http.post(`${V3}/conversations`, async ({ request }) => {
        capture(seen, request, await request.json());
        return HttpResponse.json(fixture('create-personal-ok'));
      }),
    );
    const out = await connector.createPersonalConversation({
      serviceUrl: SERVICE_URL,
      tenantId: 'tenant-1',
      aadObjectId: '4b1f6a52-8c3d-4e07-9a1b-2d5f7c9e0a13',
    });
    expect(out).toEqual({
      id: CHANNEL,
      activityId: '1790000200001',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
    });
    expect(seen[0]).toMatchObject({ method: 'POST', path: '/amer/v3/conversations', auth: AUTH });
    expect(seen[0]?.body).toEqual({
      isGroup: false,
      bot: { id: 'bot-app-id' },
      members: [{ id: '4b1f6a52-8c3d-4e07-9a1b-2d5f7c9e0a13', aadObjectId: '4b1f6a52-8c3d-4e07-9a1b-2d5f7c9e0a13' }],
      tenantId: 'tenant-1',
      channelData: { tenant: { id: 'tenant-1' } },
    });
  });

  it('getMember returns the channel account', async () => {
    const seen: Seen[] = [];
    server.use(
      http.get(`${V3}/conversations/:id/members/:memberId`, ({ request }) => {
        capture(seen, request, undefined);
        return HttpResponse.json(fixture('member-ok'));
      }),
    );
    const member = await connector.getMember({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, memberId: '29:1Zk3' });
    expect(member).toEqual({
      id: '29:1Zk3v7Lq0w9XyN2bTqRm4cJdP8sAeHfUoVgKiB5nYtXr',
      name: 'Dana Reporter',
      givenName: 'Dana',
      surname: 'Reporter',
      email: 'dana@example.test',
      userPrincipalName: 'dana@example.test',
      tenantId: 'd1a2b3c4-1111-2222-3333-444455556666',
      aadObjectId: '4b1f6a52-8c3d-4e07-9a1b-2d5f7c9e0a13',
    });
    expect(seen[0]).toMatchObject({ method: 'GET', path: `/amer/v3/conversations/${CHANNEL}/members/29:1Zk3`, auth: AUTH });
  });

  it('asks the token source on every call', async () => {
    let n = 0;
    const auths: (string | null)[] = [];
    server.use(
      http.post(`${V3}/conversations/:id/activities`, ({ request }) => {
        auths.push(request.headers.get('authorization'));
        return HttpResponse.json(fixture('send-ok'));
      }),
    );
    const rotating = createTeamsConnector({ token: async () => `teams-token-${++n}` });
    await rotating.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card);
    await rotating.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card);
    expect(auths).toEqual(['Bearer teams-token-1', 'Bearer teams-token-2']);
  });
});

describe('errors', () => {
  it('429 is TeamsRateLimitError with retryAfterMs from Retry-After seconds', async () => {
    server.use(
      http.post(`${V3}/conversations/:id/activities`, () =>
        HttpResponse.json(fixture('rate-limited'), { status: 429, headers: { 'Retry-After': '7' } }),
      ),
    );
    const err = await connector.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamsRateLimitError);
    expect(err).toBeInstanceOf(TeamsApiError);
    expect(err).toMatchObject({ status: 429, code: 'TooManyRequests', retryAfterMs: 7000 });
  });

  it('429 without a usable Retry-After falls back to one second', async () => {
    server.use(
      http.post(`${V3}/conversations/:id/activities`, () => HttpResponse.json(fixture('rate-limited'), { status: 429 })),
    );
    await expect(connector.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card)).rejects.toMatchObject({
      retryAfterMs: 1000,
    });
  });

  it('404 on update is TeamsNotFoundError (a deleted activity)', async () => {
    server.use(
      http.put(`${V3}/conversations/:id/activities/:activityId`, () =>
        HttpResponse.json(fixture('update-not-found'), { status: 404 }),
      ),
    );
    const err = await connector.updateActivity({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, activityId: ROOT }, card).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamsNotFoundError);
    expect(err).toMatchObject({ status: 404, code: 'ActivityNotFound', operation: 'updateActivity' });
  });

  it('403 is TeamsForbiddenError (the bot is not in the conversation)', async () => {
    server.use(
      http.post(`${V3}/conversations/:id/activities`, () => HttpResponse.json(fixture('forbidden'), { status: 403 })),
    );
    const err = await connector.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(TeamsForbiddenError);
    expect(err).toMatchObject({ status: 403, code: 'BotNotInConversationRoster' });
  });

  it('any other status is TeamsApiError with status and code, or http_<status> without a body code', async () => {
    server.use(
      http.get(`${V3}/conversations/:id/members/:memberId`, () => HttpResponse.json(fixture('server-error'), { status: 502 })),
      http.delete(`${V3}/conversations/:id/activities/:activityId`, () => new HttpResponse('<html>bad gateway</html>', { status: 500 })),
    );
    const a = await connector.getMember({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, memberId: 'x' }).catch((e: unknown) => e);
    expect(a).toBeInstanceOf(TeamsApiError);
    expect(a).toMatchObject({ status: 502, code: 'ServiceError' });
    const b = await connector.deleteActivity({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, activityId: ROOT }).catch((e: unknown) => e);
    expect(b).toMatchObject({ status: 500, code: 'http_500' });
  });

  it('never puts the token in an error, even when the service echoes it', async () => {
    server.use(
      http.post(`${V3}/conversations/:id/activities`, ({ request }) =>
        HttpResponse.json(
          { error: { code: 'Unauthorized', message: `bad token ${request.headers.get('authorization')}` } },
          { status: 401 },
        ),
      ),
      http.put(`${V3}/conversations/:id/activities/:activityId`, () => HttpResponse.error()),
    );
    const errors = [
      await connector.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card).catch((e: unknown) => e),
      await connector.updateActivity({ serviceUrl: SERVICE_URL, conversationId: CHANNEL, activityId: ROOT }, card).catch((e: unknown) => e),
    ];
    for (const err of errors) {
      expect(err).toBeInstanceOf(TeamsApiError);
      const dump = `${(err as Error).message} ${(err as Error).stack ?? ''} ${JSON.stringify(err)}`;
      expect(dump).not.toContain(TOKEN);
    }
    expect(errors[0]).toMatchObject({ status: 401, code: 'Unauthorized' });
    expect(errors[1]).toMatchObject({ status: 0, code: 'network_error' });
  });

  it('refuses a serviceUrl the token must not go to, before any request', async () => {
    // The refusal is a TeamsServiceUrlError, thrown before fetch is reached.
    for (const serviceUrl of ['http://smba.test/amer/', 'https://user:pw@smba.test/amer/', 'not a url']) {
      await expect(connector.sendToConversation({ serviceUrl, conversationId: CHANNEL }, card)).rejects.toBeInstanceOf(
        TeamsServiceUrlError,
      );
    }
    const strict = createTeamsConnector({ token: async () => TOKEN, allowServiceUrl: (u) => u.hostname.endsWith('.trafficmanager.net') });
    await expect(strict.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card)).rejects.toBeInstanceOf(
      TeamsServiceUrlError,
    );
  });

  it('a 2xx without an id is a TeamsApiError, not a silent undefined', async () => {
    server.use(http.post(`${V3}/conversations/:id/activities`, () => HttpResponse.json({})));
    await expect(connector.sendToConversation({ serviceUrl: SERVICE_URL, conversationId: CHANNEL }, card)).rejects.toMatchObject({
      code: 'missing_id',
    });
  });
});
