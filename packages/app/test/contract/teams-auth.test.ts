// Teams authentication on MSW (main 15.2 Auth, 16; #369). The signing keys are a locally generated pair served
// as the Bot Framework JWKS; an unhandled request fails the test, so no Microsoft endpoint is ever called.

import { generateKeyPairSync, sign } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import {
  BOT_CONNECTOR_SCOPE,
  BOT_FRAMEWORK_KEYS_TTL_MS,
  GRAPH_SCOPE,
  TeamsAuthError,
  createBotFrameworkKeys,
  createBotTokenSource,
  createGraphTokenSource,
  verifyBotFrameworkJwt,
} from '../../src/adapters/teams/auth.ts';
import type { BotFrameworkKeys } from '../../src/adapters/teams/auth.ts';

function fixture(name: string): JsonBodyType {
  return JSON.parse(readFileSync(new URL(`../fixtures/teams/openid/${name}`, import.meta.url), 'utf8')) as JsonBodyType;
}

const METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
const JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const TOKEN_URL = 'https://login.microsoftonline.com/:authority/oauth2/v2.0/token';

const APP_ID = '00000000-0000-4000-8000-000000000001';
const TENANT_ID = '00000000-0000-4000-8000-0000000000aa';
const PASSWORD = 'test-teams-app-password';
const SERVICE_URL = 'https://smba.trafficmanager.net/amer/';
const T0 = Date.parse('2026-10-03T12:00:00Z');
const T0S = T0 / 1000;

interface Pair {
  kid: string;
  privateKey: KeyObject;
  publicKey: KeyObject;
}
function pair(kid: string): Pair {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  return { kid, privateKey, publicKey };
}
const served = pair('local-key-1');
const rotated = pair('local-key-2');
const stranger = pair('local-key-stranger');

function jwk(p: Pair, endorsements?: string[]): Record<string, unknown> {
  const { n, e } = p.publicKey.export({ format: 'jwk' });
  return { kty: 'RSA', use: 'sig', kid: p.kid, n, e, ...(endorsements === undefined ? {} : { endorsements }) };
}

function b64(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString('base64url');
}

function token(claims: Record<string, unknown>, options: { key?: Pair; kid?: string; alg?: string } = {}): string {
  const key = options.key ?? served;
  const head = b64({ alg: options.alg ?? 'RS256', typ: 'JWT', kid: options.kid ?? key.kid });
  const body = b64(claims);
  const signature = sign('RSA-SHA256', Buffer.from(`${head}.${body}`), key.privateKey).toString('base64url');
  return `${head}.${body}.${signature}`;
}

function goodClaims(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    iss: 'https://api.botframework.com',
    aud: APP_ID,
    nbf: T0S - 60,
    exp: T0S + 3600,
    serviceUrl: SERVICE_URL,
    appid: 'test-bot-connector-app',
    ...overrides,
  };
}

let jwks: Record<string, unknown>[] = [];
let metadataCalls = 0;
let jwksCalls = 0;
let keysDown = false;
interface TokenCall {
  authority: string;
  form: URLSearchParams;
}
let tokenCalls: TokenCall[] = [];
let tokenStatus = 200;

const server = setupServer(
  http.get(METADATA_URL, () => {
    metadataCalls += 1;
    if (keysDown) return new HttpResponse(null, { status: 503 });
    return HttpResponse.json(fixture('openidconfiguration.json'));
  }),
  http.get(JWKS_URL, () => {
    jwksCalls += 1;
    if (keysDown) return new HttpResponse(null, { status: 503 });
    return HttpResponse.json({ keys: jwks } as JsonBodyType);
  }),
  http.post(TOKEN_URL, async ({ request, params }) => {
    const form = new URLSearchParams(await request.text());
    tokenCalls.push({ authority: String(params.authority), form });
    if (tokenStatus !== 200) return HttpResponse.json(fixture('token-error.json'), { status: tokenStatus });
    const body = fixture('token-response.json') as Record<string, unknown>;
    return HttpResponse.json({ ...body, access_token: `${String(body.access_token)}-${tokenCalls.length}` });
  }),
);

const unhandled: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:unhandled', ({ request }) => {
    unhandled.push(`${request.method} ${request.url}`);
  });
});
afterEach(() => {
  // Every request went to an MSW handler: nothing reached a Microsoft endpoint.
  expect(unhandled).toEqual([]);
  unhandled.length = 0;
  server.resetHandlers();
  jwks = [jwk(served)];
  metadataCalls = 0;
  jwksCalls = 0;
  keysDown = false;
  tokenCalls = [];
  tokenStatus = 200;
  vi.restoreAllMocks();
});
afterAll(() => server.close());
jwks = [jwk(served)];

function verify(authorization: string | null | undefined, keys: BotFrameworkKeys, extra: { now?: number; serviceUrl?: string; channelId?: string } = {}) {
  return verifyBotFrameworkJwt(authorization, {
    appId: APP_ID,
    serviceUrl: extra.serviceUrl ?? SERVICE_URL,
    now: extra.now ?? T0,
    keys,
    ...(extra.channelId === undefined ? {} : { channelId: extra.channelId }),
  });
}

describe('verifyBotFrameworkJwt', () => {
  it('accepts a token signed by a served key and returns its claims', async () => {
    const result = await verify(`Bearer ${token(goodClaims())}`, createBotFrameworkKeys());
    expect(result).toMatchObject({ ok: true, claims: { iss: 'https://api.botframework.com', aud: APP_ID, serviceUrl: SERVICE_URL, appid: 'test-bot-connector-app' } });
    expect(metadataCalls).toBe(1);
    expect(jwksCalls).toBe(1);
  });

  it('uses the public Bot Framework metadata by default (served here by MSW)', async () => {
    const result = await verifyBotFrameworkJwt(`Bearer ${token(goodClaims())}`, { appId: APP_ID, serviceUrl: SERVICE_URL, now: new Date(T0) });
    expect(result.ok).toBe(true);
    expect(metadataCalls).toBe(1);
  });

  it('rejects a request with no Authorization header', async () => {
    const keys = createBotFrameworkKeys();
    expect(await verify(undefined, keys)).toEqual({ ok: false, reason: 'missing-header' });
    expect(await verify(null, keys)).toEqual({ ok: false, reason: 'missing-header' });
    expect(await verify('', keys)).toEqual({ ok: false, reason: 'missing-header' });
    expect(metadataCalls).toBe(0);
  });

  it('rejects a bare Bearer', async () => {
    const keys = createBotFrameworkKeys();
    expect(await verify('Bearer', keys)).toEqual({ ok: false, reason: 'missing-token' });
    expect(await verify('Bearer   ', keys)).toEqual({ ok: false, reason: 'missing-token' });
    expect(await verify(`Basic ${token(goodClaims())}`, keys)).toEqual({ ok: false, reason: 'not-bearer' });
    expect(await verify('Bearer not-a-jwt', keys)).toEqual({ ok: false, reason: 'malformed' });
    expect(metadataCalls).toBe(0);
  });

  it('rejects a wrong audience', async () => {
    const result = await verify(`Bearer ${token(goodClaims({ aud: '00000000-0000-4000-8000-0000000000ff' }))}`, createBotFrameworkKeys());
    expect(result).toEqual({ ok: false, reason: 'wrong-audience' });
  });

  it('rejects an expired token, allowing 5 minutes of skew on exp and nbf', async () => {
    const keys = createBotFrameworkKeys();
    expect(await verify(`Bearer ${token(goodClaims({ exp: T0S - 5 * 60 - 1 }))}`, keys)).toEqual({ ok: false, reason: 'expired' });
    expect((await verify(`Bearer ${token(goodClaims({ exp: T0S - 4 * 60 }))}`, keys)).ok).toBe(true);
    expect(await verify(`Bearer ${token(goodClaims({ nbf: T0S + 5 * 60 + 1 }))}`, keys)).toEqual({ ok: false, reason: 'not-yet-valid' });
    expect((await verify(`Bearer ${token(goodClaims({ nbf: T0S + 4 * 60 }))}`, keys)).ok).toBe(true);
    const { exp: _exp, ...noExp } = goodClaims();
    expect(await verify(`Bearer ${token(noExp)}`, keys)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('rejects an unknown key, refetching the keys at most once a minute', async () => {
    const keys = createBotFrameworkKeys();
    expect((await verify(`Bearer ${token(goodClaims())}`, keys)).ok).toBe(true);
    expect(jwksCalls).toBe(1);

    // Unknown kid 2 minutes later: one refetch, still unknown.
    const unknown = `Bearer ${token(goodClaims(), { key: stranger })}`;
    expect(await verify(unknown, keys, { now: T0 + 120_000 })).toEqual({ ok: false, reason: 'unknown-key' });
    expect(jwksCalls).toBe(2);
    // Again within the minute: no refetch.
    expect(await verify(unknown, keys, { now: T0 + 150_000 })).toEqual({ ok: false, reason: 'unknown-key' });
    expect(jwksCalls).toBe(2);

    // Microsoft rolls a key in: a token with the new kid within the minute is still refused, after it the refetch finds it.
    jwks = [jwk(served), jwk(rotated)];
    const fresh = `Bearer ${token(goodClaims(), { key: rotated })}`;
    expect(await verify(fresh, keys, { now: T0 + 170_000 })).toEqual({ ok: false, reason: 'unknown-key' });
    expect(jwksCalls).toBe(2);
    expect((await verify(fresh, keys, { now: T0 + 181_000 })).ok).toBe(true);
    expect(jwksCalls).toBe(3);
    expect(metadataCalls).toBe(3);
  });

  it('rejects a mismatched serviceUrl', async () => {
    const keys = createBotFrameworkKeys();
    const result = await verify(`Bearer ${token(goodClaims({ serviceUrl: 'https://attacker.example/' }))}`, keys);
    expect(result).toEqual({ ok: false, reason: 'service-url-mismatch' });
    const { serviceUrl: _s, ...noServiceUrl } = goodClaims();
    expect(await verify(`Bearer ${token(noServiceUrl)}`, keys)).toEqual({ ok: false, reason: 'service-url-mismatch' });
    expect((await verify(`Bearer ${token(goodClaims())}`, keys, { serviceUrl: 'https://smba.trafficmanager.net/amer' })).ok).toBe(true);
  });

  it('rejects a wrong issuer', async () => {
    const result = await verify(`Bearer ${token(goodClaims({ iss: 'https://sts.windows.net/f8cdef31-a31e-4b4a-93e4-5f571e91255a/' }))}`, createBotFrameworkKeys());
    expect(result).toEqual({ ok: false, reason: 'wrong-issuer' });
  });

  it('rejects a signature the served key did not make, and any algorithm but RS256', async () => {
    const keys = createBotFrameworkKeys();
    expect(await verify(`Bearer ${token(goodClaims(), { key: stranger, kid: served.kid })}`, keys)).toEqual({ ok: false, reason: 'bad-signature' });
    const [h, , s] = token(goodClaims()).split('.');
    const tampered = `${h}.${b64(goodClaims({ appid: 'someone-else' }))}.${s}`;
    expect(await verify(`Bearer ${tampered}`, keys)).toEqual({ ok: false, reason: 'bad-signature' });
    const none = `${b64({ alg: 'none', typ: 'JWT', kid: served.kid })}.${b64(goodClaims())}.AA`;
    expect(await verify(`Bearer ${none}`, keys)).toEqual({ ok: false, reason: 'unsupported-algorithm' });
    expect(await verify(`Bearer ${token(goodClaims(), { alg: 'HS256' })}`, keys)).toEqual({ ok: false, reason: 'unsupported-algorithm' });
  });

  it('checks the channel endorsement when the key carries endorsements', async () => {
    jwks = [jwk(served, ['msteams'])];
    const keys = createBotFrameworkKeys();
    const auth = `Bearer ${token(goodClaims())}`;
    expect((await verify(auth, keys, { channelId: 'msteams' })).ok).toBe(true);
    expect(await verify(auth, keys, { channelId: 'webchat' })).toEqual({ ok: false, reason: 'channel-not-endorsed' });
  });

  it('caches the metadata and keys, and refreshes them after a day', async () => {
    const keys = createBotFrameworkKeys();
    const auth = `Bearer ${token(goodClaims())}`;
    for (let i = 0; i < 5; i += 1) expect((await verify(auth, keys, { now: T0 + i * 1000 })).ok).toBe(true);
    expect([metadataCalls, jwksCalls]).toEqual([1, 1]);
    const later = T0 + BOT_FRAMEWORK_KEYS_TTL_MS + 1000;
    const laterAuth = `Bearer ${token(goodClaims({ nbf: later / 1000 - 60, exp: later / 1000 + 3600 }))}`;
    expect((await verify(laterAuth, keys, { now: later })).ok).toBe(true);
    expect([metadataCalls, jwksCalls]).toEqual([2, 2]);
  });

  it('shares one fetch between concurrent first requests', async () => {
    const keys = createBotFrameworkKeys();
    const auth = `Bearer ${token(goodClaims())}`;
    const results = await Promise.all([verify(auth, keys), verify(auth, keys), verify(auth, keys)]);
    expect(results.every((r) => r.ok)).toBe(true);
    expect([metadataCalls, jwksCalls]).toEqual([1, 1]);
  });

  it('reports keys-unavailable when the metadata cannot be fetched, keeps stale keys, and never throws', async () => {
    keysDown = true;
    const keys = createBotFrameworkKeys();
    const auth = `Bearer ${token(goodClaims())}`;
    expect(await verify(auth, keys)).toEqual({ ok: false, reason: 'keys-unavailable' });
    keysDown = false;
    expect((await verify(auth, keys, { now: T0 + 61_000 })).ok).toBe(true);
    keysDown = true;
    const later = T0 + BOT_FRAMEWORK_KEYS_TTL_MS + 120_000;
    const laterAuth = `Bearer ${token(goodClaims({ nbf: later / 1000 - 60, exp: later / 1000 + 3600 }))}`;
    expect((await verify(laterAuth, keys, { now: later })).ok).toBe(true);

    const throwing: BotFrameworkKeys = {
      get() {
        throw new Error('boom');
      },
    };
    expect(await verify(auth, throwing)).toEqual({ ok: false, reason: 'malformed' });
  });

  it('has no DEMO_ONLY mode: production validates exactly as development does', async () => {
    vi.stubEnv('NODE_ENV', 'production');
    try {
      const keys = createBotFrameworkKeys();
      expect((await verify(`Bearer ${token(goodClaims())}`, keys)).ok).toBe(true);
      expect(await verify('Bearer', keys)).toEqual({ ok: false, reason: 'missing-token' });
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('outbound token sources', () => {
  const now = { value: new Date(T0) };
  const clock = () => now.value;

  it('gets Bot Connector tokens from the tenant authority by client credentials', async () => {
    now.value = new Date(T0);
    const source = createBotTokenSource({ appId: APP_ID, password: PASSWORD, tenantId: TENANT_ID, now: clock });
    expect(await source.token()).toBe('test-teams-access-token-1');
    expect(tokenCalls).toHaveLength(1);
    const call = tokenCalls[0];
    expect(call?.authority).toBe(TENANT_ID);
    expect(Object.fromEntries(call?.form ?? [])).toEqual({
      grant_type: 'client_credentials',
      client_id: APP_ID,
      client_secret: PASSWORD,
      scope: BOT_CONNECTOR_SCOPE,
    });
    expect(BOT_CONNECTOR_SCOPE).toBe('https://api.botframework.com/.default');
  });

  it('uses the botframework.com authority for a multi-tenant registration', async () => {
    const source = createBotTokenSource({ appId: APP_ID, password: PASSWORD, multiTenant: true, now: clock });
    await source.token();
    expect(tokenCalls[0]?.authority).toBe('botframework.com');
  });

  it('refuses a single-tenant source with no tenant id', () => {
    expect(() => createBotTokenSource({ appId: APP_ID, password: PASSWORD })).toThrow(/TEAMS_TENANT_ID/);
    expect(() => createGraphTokenSource({ appId: APP_ID, password: PASSWORD, tenantId: ' ' })).toThrow(/TEAMS_TENANT_ID/);
  });

  it('gets Graph tokens with the Graph scope', async () => {
    const source = createGraphTokenSource({ appId: APP_ID, password: PASSWORD, tenantId: TENANT_ID, now: clock });
    await source.token();
    expect(tokenCalls[0]?.authority).toBe(TENANT_ID);
    expect(tokenCalls[0]?.form.get('scope')).toBe(GRAPH_SCOPE);
    expect(GRAPH_SCOPE).toBe('https://graph.microsoft.com/.default');
  });

  it('caches until 5 minutes before expiry and shares one request between concurrent callers', async () => {
    now.value = new Date(T0);
    const source = createBotTokenSource({ appId: APP_ID, password: PASSWORD, tenantId: TENANT_ID, now: clock });
    const first = await Promise.all([source.token(), source.token(), source.token()]);
    expect(new Set(first)).toEqual(new Set(['test-teams-access-token-1']));
    expect(tokenCalls).toHaveLength(1);
    // expires_in is 3599 s: still cached 5 minutes and 1 s before expiry.
    now.value = new Date(T0 + (3599 - 301) * 1000);
    expect(await source.token()).toBe('test-teams-access-token-1');
    expect(tokenCalls).toHaveLength(1);
    now.value = new Date(T0 + (3599 - 300) * 1000);
    expect(await source.token()).toBe('test-teams-access-token-2');
    expect(tokenCalls).toHaveLength(2);
  });

  it('fails with the status and error code only, and never logs a token or the password', async () => {
    const logged: unknown[] = [];
    for (const method of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => {
        logged.push(...args);
      });
    }
    const source = createGraphTokenSource({ appId: APP_ID, password: PASSWORD, tenantId: TENANT_ID, now: clock });
    tokenStatus = 401;
    const error = await source.token().catch((e: unknown) => e);
    expect(error).toBeInstanceOf(TeamsAuthError);
    expect(error).toMatchObject({ status: 401, code: 'invalid_client' });
    expect(String((error as Error).message)).not.toContain(PASSWORD);
    tokenStatus = 200;
    const value = await source.token();
    const bot = createBotTokenSource({ appId: APP_ID, password: PASSWORD, tenantId: TENANT_ID, now: clock });
    await bot.token();
    const verified = await verify(`Bearer ${token(goodClaims())}`, createBotFrameworkKeys());
    expect(verified.ok).toBe(true);
    const text = JSON.stringify(logged);
    expect(text).not.toContain(value);
    expect(text).not.toContain(PASSWORD);
    expect(logged).toEqual([]);
  });
});
