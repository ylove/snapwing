// Linking a GitHub identity (main 11.2, main 16, ADR 0007): the GitHub App user authorization
// routes against MSW, state binding and expiry, token refresh, and sealed tokens at rest. Runs on the
// dialect `SNAPWING_DB` selects; CI runs it on both SQLite and Postgres.

import { randomBytes } from 'node:crypto';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createApiServer, type ApiServer } from '../../src/server/http.ts';
import { CALLBACK_PATH, START_PATH, STATE_COOKIE, createGitHubOAuth, type ChatUser, type GitHubOAuth } from '../../src/github/oauth.ts';

const WS = '01JZ00000000000000000000W1';
const PUBLIC = 'https://snapwing.example.test';
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const USER: ChatUser = { chat: 'slack', userId: 'U0AAAA' };
const KEY = { workspaceId: WS, chat: 'slack' as const, chatUserId: 'U0AAAA' };

// Obvious fakes (CONTEXT.md 6b).
const CLIENT_ID = 'test-client-id';
const CLIENT_SECRET = 'test-client-secret';
const ACCESS_1 = 'test-access-token-one';
const REFRESH_1 = 'test-refresh-token-one';
const ACCESS_2 = 'test-access-token-two';
const REFRESH_2 = 'test-refresh-token-two';
const CODE = 'fake-oauth-code-123';

const values: Record<string, string> = {
  GITHUB_APP_CLIENT_ID: CLIENT_ID,
  GITHUB_APP_CLIENT_SECRET: CLIENT_SECRET,
  SNAPWING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SNAPWING_PUBLIC_URL: `${PUBLIC}/`,
};
const secrets: SecretsPort = {
  get(name) {
    const v = values[name];
    return v === undefined ? Promise.reject(new SecretNotFoundError(name, 'test')) : Promise.resolve(v);
  },
};

// GitHub ------------------------------------------------------------------------------------------

interface TokenCall {
  accept: string | null;
  form: Record<string, string>;
}
let tokenCalls: TokenCall[] = [];
let userCalls: string[] = [];
/** What the token endpoint answers next, by grant: a code exchange or a refresh. */
let codeAnswer: Record<string, unknown>;
let refreshAnswer: Record<string, unknown>;

const server = setupServer(
  http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
    const form = Object.fromEntries(new URLSearchParams(await request.text()));
    tokenCalls.push({ accept: request.headers.get('accept'), form });
    return HttpResponse.json(form['grant_type'] === 'refresh_token' ? refreshAnswer : codeAnswer);
  }),
  http.get('https://api.github.com/user', ({ request }) => {
    userCalls.push(request.headers.get('authorization') ?? '');
    return HttpResponse.json({ login: 'octo-human', id: 583231, type: 'User' });
  }),
);

beforeAll(() => server.listen());
afterAll(() => server.close());

// Harness -----------------------------------------------------------------------------------------

let tdb: TestDatabase;
let store: StateStore;
let nowMs = T0;
let oauth: GitHubOAuth;
let api: ApiServer;

beforeAll(async () => {
  tdb = await createTestDatabase();
  const state: OpenedState = await tdb.open({ now: () => new Date(nowMs) });
  if (!(state instanceof StateStore)) throw new Error('openState did not return a StateStore');
  store = state;
});
afterAll(async () => {
  await tdb.drop();
});

beforeEach(async () => {
  nowMs = T0;
  tokenCalls = [];
  userCalls = [];
  codeAnswer = { access_token: ACCESS_1, expires_in: 28800, refresh_token: REFRESH_1, refresh_token_expires_in: 15811200, token_type: 'bearer', scope: '' };
  refreshAnswer = { access_token: ACCESS_2, expires_in: 28800, refresh_token: REFRESH_2, refresh_token_expires_in: 15811200, token_type: 'bearer', scope: '' };
  await store.ctx.db.deleteFrom('linked_identities').execute();
  await store.ctx.db.deleteFrom('webhook_inbox').execute();
  oauth = createGitHubOAuth({ state: store, secrets, workspaceId: WS, now: () => new Date(nowMs) });
  api = createApiServer({ routes: oauth.routes, port: 0 });
});
afterEach(() => server.resetHandlers());

function stateOf(url: string): string {
  return new URL(url).searchParams.get('state') ?? '';
}

/** Follows `linkUrl` through the start route; returns the state GitHub would echo and the cookie. */
async function begin(user: ChatUser = USER): Promise<{ state: string; cookie: string; location: URL }> {
  const link = await oauth.linkUrl(user);
  const res = await api.fetch(new Request(link));
  expect(res.status).toBe(302);
  const location = new URL(res.headers.get('location') ?? '');
  const setCookie = res.headers.get('set-cookie') ?? '';
  const cookie = setCookie.split(';')[0] ?? '';
  return { state: location.searchParams.get('state') ?? '', cookie, location };
}

function callback(params: Record<string, string>, cookie?: string): Promise<Response> {
  const url = new URL(`${PUBLIC}${CALLBACK_PATH}`);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
  return api.fetch(new Request(url, cookie === undefined ? {} : { headers: { cookie } }));
}

async function rawRow(): Promise<Record<string, unknown> | undefined> {
  return store.ctx.db.selectFrom('linked_identities').selectAll().executeTakeFirst();
}

function expectNoPlaintext(row: Record<string, unknown> | undefined, tokens: readonly string[]): void {
  expect(row).toBeDefined();
  for (const v of Object.values(row ?? {})) {
    const text = v instanceof Date ? v.toISOString() : String(v);
    for (const t of tokens) {
      expect(text).not.toBe(t);
      expect(text).not.toContain(t);
    }
  }
}

// Tests -------------------------------------------------------------------------------------------

describe('routes (ADR 0016)', () => {
  it('mounts GET /auth/github/start and GET /auth/github/callback', () => {
    expect(oauth.routes.map((r) => `${r.method} ${r.path}`)).toEqual([`GET ${START_PATH}`, `GET ${CALLBACK_PATH}`]);
    expect(START_PATH).toBe('/auth/github/start');
    expect(CALLBACK_PATH).toBe('/auth/github/callback');
  });

  it('linkUrl points at the start route on SNAPWING_PUBLIC_URL', async () => {
    const link = new URL(await oauth.linkUrl(USER));
    expect(`${link.origin}${link.pathname}`).toBe(`${PUBLIC}${START_PATH}`);
    expect(stateOf(link.toString())).not.toBe('');
    expect(link.toString()).not.toContain('U0AAAA');
  });
});

describe('full flow', () => {
  it('start redirects to GitHub with the client id, callback URL, and state, and sets the browser cookie', async () => {
    const { state, cookie, location } = await begin();
    expect(`${location.origin}${location.pathname}`).toBe('https://github.com/login/oauth/authorize');
    expect(location.searchParams.get('client_id')).toBe(CLIENT_ID);
    expect(location.searchParams.get('redirect_uri')).toBe(`${PUBLIC}/auth/github/callback`);
    expect(location.toString()).not.toContain(CLIENT_SECRET);
    expect(state).not.toBe('');
    expect(cookie.startsWith(`${STATE_COOKIE}=`)).toBe(true);
    const res = await api.fetch(new Request(await oauth.linkUrl(USER)));
    const setCookie = res.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('Secure');
    expect(setCookie).toContain('SameSite=Lax');
    expect(setCookie).toContain('Max-Age=600');
  });

  it('callback exchanges the code, reads /user, and stores the link with sealed tokens', async () => {
    const { state, cookie } = await begin();
    const res = await callback({ code: CODE, state }, cookie);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('@octo-human');
    for (const secret of [ACCESS_1, REFRESH_1, CLIENT_SECRET, CODE]) expect(body).not.toContain(secret);
    expect(res.headers.get('set-cookie')).toContain('Max-Age=0');

    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.accept).toBe('application/json');
    expect(tokenCalls[0]?.form).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, code: CODE, redirect_uri: `${PUBLIC}/auth/github/callback` });
    expect(userCalls).toEqual([`Bearer ${ACCESS_1}`]);

    const linked = await oauth.getLinkedIdentity(USER);
    expect(linked).toMatchObject({
      ...KEY,
      githubLogin: 'octo-human',
      githubUserId: 583231,
      accessTokenExpiresAt: new Date(T0 + 28800_000).toISOString(),
      refreshTokenExpiresAt: new Date(T0 + 15811200_000).toISOString(),
      linkedAt: new Date(T0).toISOString(),
    });
    expect(await store.getLinkedIdentity(KEY)).toEqual(linked);
    expect(await oauth.isLinked(USER)).toBe(true);
    expect(await oauth.isLinked({ chat: 'slack', userId: 'U0OTHER' })).toBe(false);
    expect(await oauth.userToken(USER)).toEqual({ token: ACCESS_1, githubLogin: 'octo-human', githubUserId: 583231 });
    expect(tokenCalls).toHaveLength(1);
  });

  it('links the chat user the state was minted for, not whoever holds the browser', async () => {
    const other: ChatUser = { chat: 'teams', userId: '7f1c-aad-object-id' };
    const { state, cookie } = await begin(other);
    expect((await callback({ code: CODE, state }, cookie)).status).toBe(200);
    expect(await oauth.getLinkedIdentity(other)).toMatchObject({ chat: 'teams', chatUserId: '7f1c-aad-object-id' });
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
  });

  it('stores a non-expiring user token without a refresh token, and uses it as is', async () => {
    codeAnswer = { access_token: ACCESS_1, token_type: 'bearer', scope: '' };
    const { state, cookie } = await begin();
    expect((await callback({ code: CODE, state }, cookie)).status).toBe(200);
    const linked = await oauth.getLinkedIdentity(USER);
    expect(linked?.accessTokenExpiresAt).toBeUndefined();
    expect(linked?.refreshToken).toBeUndefined();
    nowMs += 365 * 86400_000;
    expect(await oauth.isLinked(USER)).toBe(true);
    expect((await oauth.userToken(USER))?.token).toBe(ACCESS_1);
    expect(tokenCalls).toHaveLength(1);
  });

  it('unlink removes the link', async () => {
    const { state, cookie } = await begin();
    await callback({ code: CODE, state }, cookie);
    expect(await oauth.unlink(USER)).toBe(true);
    expect(await oauth.isLinked(USER)).toBe(false);
    expect(await oauth.userToken(USER)).toBeNull();
  });
});

describe('state binding and expiry', () => {
  it('rejects a replayed state, even inside its expiry, without calling GitHub again', async () => {
    const { state, cookie } = await begin();
    expect((await callback({ code: CODE, state }, cookie)).status).toBe(200);
    await oauth.unlink(USER);
    const replay = await callback({ code: CODE, state }, cookie);
    expect(replay.status).toBe(400);
    expect(await replay.text()).toContain('already used');
    expect(tokenCalls).toHaveLength(1);
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
  });

  it('rejects an expired state at start and at the callback', async () => {
    const link = await oauth.linkUrl(USER);
    const { state, cookie } = await begin();
    nowMs += 600_000;
    const atStart = await api.fetch(new Request(link));
    expect(atStart.status).toBe(400);
    expect(await atStart.text()).toContain('expired');
    const atCallback = await callback({ code: CODE, state }, cookie);
    expect(atCallback.status).toBe(400);
    expect(await atCallback.text()).toContain('expired');
    expect(tokenCalls).toHaveLength(0);
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
  });

  it('accepts a state just inside its expiry', async () => {
    const { state, cookie } = await begin();
    nowMs += 599_000;
    expect((await callback({ code: CODE, state }, cookie)).status).toBe(200);
  });

  it('rejects a tampered, foreign, or missing state', async () => {
    const { state, cookie } = await begin();
    const [body = '', mac = ''] = state.split('.');
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
    const forged = `${Buffer.from(JSON.stringify({ ...payload, u: 'U0ATTACKER' })).toString('base64url')}.${mac}`;
    expect((await callback({ code: CODE, state: forged }, cookie)).status).toBe(400);
    expect((await callback({ code: CODE, state: `${body}.${mac.slice(1)}` }, cookie)).status).toBe(400);
    expect((await callback({ code: CODE }, cookie)).status).toBe(400);
    expect((await api.fetch(new Request(`${PUBLIC}${START_PATH}`))).status).toBe(400);

    // Minted by another install (another key): a valid shape, a signature this one does not accept.
    const otherInstall = createGitHubOAuth({
      state: store,
      secrets: { get: (n) => (n === 'SNAPWING_ENCRYPTION_KEY' ? Promise.resolve(randomBytes(32).toString('hex')) : secrets.get(n)) },
      workspaceId: WS,
      now: () => new Date(nowMs),
    });
    expect((await callback({ code: CODE, state: stateOf(await otherInstall.linkUrl(USER)) }, cookie)).status).toBe(400);
    // Minted for another workspace with this key.
    const otherWorkspace = createGitHubOAuth({ state: store, secrets, workspaceId: '01JZ00000000000000000000W2', now: () => new Date(nowMs) });
    expect((await callback({ code: CODE, state: stateOf(await otherWorkspace.linkUrl(USER)) }, cookie)).status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  it('rejects a callback in a browser that did not start the flow', async () => {
    const { state } = await begin();
    const other = await begin();
    expect((await callback({ code: CODE, state })).status).toBe(400);
    expect((await callback({ code: CODE, state }, other.cookie)).status).toBe(400);
    expect((await callback({ code: CODE, state }, `${STATE_COOKIE}=`)).status).toBe(400);
    expect(tokenCalls).toHaveLength(0);
  });

  it('a cancelled authorization stores nothing', async () => {
    const { state, cookie } = await begin();
    const res = await callback({ error: 'access_denied', error_description: 'The user has denied your application access.', state }, cookie);
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('cancelled');
    expect(tokenCalls).toHaveLength(0);
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
  });

  it('a code GitHub refuses stores nothing and shows no secret', async () => {
    codeAnswer = { error: 'bad_verification_code', error_description: 'The code passed is incorrect or expired.' };
    const { state, cookie } = await begin();
    const res = await callback({ code: CODE, state }, cookie);
    expect(res.status).toBe(502);
    const body = await res.text();
    for (const secret of [CLIENT_SECRET, CODE]) expect(body).not.toContain(secret);
    expect(userCalls).toHaveLength(0);
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
  });
});

describe('token refresh', () => {
  async function link(): Promise<void> {
    const { state, cookie } = await begin();
    expect((await callback({ code: CODE, state }, cookie)).status).toBe(200);
    tokenCalls = [];
  }

  it('refreshes a token within 5 minutes of expiry before use, and stores the rotated pair sealed', async () => {
    await link();
    nowMs = T0 + 28800_000 - 4 * 60_000;
    expect(await oauth.userToken(USER)).toEqual({ token: ACCESS_2, githubLogin: 'octo-human', githubUserId: 583231 });
    expect(tokenCalls).toHaveLength(1);
    expect(tokenCalls[0]?.form).toEqual({ client_id: CLIENT_ID, client_secret: CLIENT_SECRET, grant_type: 'refresh_token', refresh_token: REFRESH_1 });

    const linked = await oauth.getLinkedIdentity(USER);
    expect(linked?.accessTokenExpiresAt).toBe(new Date(nowMs + 28800_000).toISOString());
    expect(linked?.linkedAt).toBe(new Date(T0).toISOString());
    expect(linked?.updatedAt).toBe(new Date(nowMs).toISOString());
    expectNoPlaintext(await rawRow(), [ACCESS_1, REFRESH_1, ACCESS_2, REFRESH_2]);

    // The new token is current: no second refresh, and the next refresh spends the rotated token.
    expect((await oauth.userToken(USER))?.token).toBe(ACCESS_2);
    expect(tokenCalls).toHaveLength(1);
    nowMs += 28800_000;
    refreshAnswer = { ...refreshAnswer, access_token: 'test-access-token-three', refresh_token: 'test-refresh-token-three' };
    expect((await oauth.userToken(USER))?.token).toBe('test-access-token-three');
    expect(tokenCalls[1]?.form['refresh_token']).toBe(REFRESH_2);
  });

  it('does not refresh a token with more than 5 minutes left', async () => {
    await link();
    nowMs = T0 + 28800_000 - 6 * 60_000;
    expect((await oauth.userToken(USER))?.token).toBe(ACCESS_1);
    expect(tokenCalls).toHaveLength(0);
  });

  it('concurrent uses share one refresh', async () => {
    await link();
    nowMs = T0 + 28800_000;
    const tokens = await Promise.all([oauth.userToken(USER), oauth.userToken(USER), oauth.userToken(USER)]);
    expect(tokens.map((t) => t?.token)).toEqual([ACCESS_2, ACCESS_2, ACCESS_2]);
    expect(tokenCalls).toHaveLength(1);
  });

  it('uses the row another process refreshed when GitHub refuses the spent refresh token', async () => {
    await link();
    nowMs = T0 + 28800_000;
    // A second instance (another process) refreshes first and rotates the pair.
    const elsewhere = createGitHubOAuth({ state: store, secrets, workspaceId: WS, now: () => new Date(nowMs) });
    let first = true;
    server.use(
      http.post('https://github.com/login/oauth/access_token', async ({ request }) => {
        const form = Object.fromEntries(new URLSearchParams(await request.text()));
        tokenCalls.push({ accept: request.headers.get('accept'), form });
        if (first) {
          first = false;
          await elsewhere.userToken(USER);
          return HttpResponse.json({ error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' });
        }
        return HttpResponse.json(refreshAnswer);
      }),
    );
    expect((await oauth.userToken(USER))?.token).toBe(ACCESS_2);
    expect(await oauth.isLinked(USER)).toBe(true);
  });

  it('a refresh token GitHub refuses unlinks the user', async () => {
    await link();
    nowMs = T0 + 28800_000;
    refreshAnswer = { error: 'bad_refresh_token', error_description: 'The refresh token passed is incorrect or expired.' };
    expect(await oauth.userToken(USER)).toBeNull();
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
    expect(await oauth.isLinked(USER)).toBe(false);
  });

  it('an expired refresh token unlinks the user without calling GitHub', async () => {
    await link();
    nowMs = T0 + 15811200_000 + 1000;
    expect(await oauth.isLinked(USER)).toBe(false);
    expect(await oauth.userToken(USER)).toBeNull();
    expect(tokenCalls).toHaveLength(0);
    expect(await oauth.getLinkedIdentity(USER)).toBeNull();
  });

  it('a transient refresh failure throws and keeps the link', async () => {
    await link();
    nowMs = T0 + 28800_000;
    server.use(http.post('https://github.com/login/oauth/access_token', () => new HttpResponse('upstream', { status: 503 })));
    const err = await oauth.userToken(USER).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(String((err as Error).message)).not.toContain(REFRESH_1);
    expect(await oauth.getLinkedIdentity(USER)).not.toBeNull();
  });
});

describe('tokens at rest', () => {
  it('the stored columns are ciphertext, never the tokens, and bound to their row', async () => {
    const { state, cookie } = await begin();
    await callback({ code: CODE, state }, cookie);
    const row = await rawRow();
    expectNoPlaintext(row, [ACCESS_1, REFRESH_1, CLIENT_SECRET]);
    expect(String(row?.['access_token'])).toMatch(/^swenc1\./);
    expect(String(row?.['refresh_token'])).toMatch(/^swenc1\./);

    // The same sealed token copied to another chat user's row does not open there.
    const linked = await oauth.getLinkedIdentity(USER);
    if (linked === null) throw new Error('not linked');
    await store.linkIdentity({ ...linked, chatUserId: 'U0COPY' });
    await expect(oauth.userToken({ chat: 'slack', userId: 'U0COPY' })).rejects.toThrow(/does not open/);
  });
});
