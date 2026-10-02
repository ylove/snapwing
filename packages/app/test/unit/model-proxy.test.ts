// Model proxy (ADR 0017, amendment 1; #239): per-run model tokens and the proxy routes a fixer or review
// container calls instead of holding a provider key. The provider is a fake `fetch`; no network.

import { describe, expect, it } from 'vitest';
import { issueFixerToken, verifyFixerToken } from '../../src/fixer-api/token.ts';
import { createModelProxyRoutes, type ModelProxyOptions, type ModelProxyRoute } from '../../src/model-proxy/routes.ts';
import { issueModelToken, modelTokenVerifier, verifyModelToken } from '../../src/model-proxy/token.ts';
import { createApiServer } from '../../src/server/http.ts';

const SECRET = 'fake-hmac-key-for-tests-0123456789abcdef';
let now = Date.parse('2026-10-02T12:00:00Z');
const keys = { secret: SECRET, clock: () => new Date(now) };
const PROVIDER_KEY = 'fake-provider-key-for-tests';
const WI = '01J9ZWORKITEM0000000000001';
const RUN = '01J9ZRUNID0000000000000001';

function token(over: Partial<{ workItemId: string; runId: string; ttl: string }> = {}): string {
  return issueModelToken({ workItemId: WI, runId: RUN, ttl: 'PT45M', ...over }, keys);
}

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

function setup(over: Partial<ModelProxyOptions> = {}): { routes: ModelProxyRoute[]; sent: Sent[]; call: (path: string, init?: RequestInit) => Promise<Response> } {
  const sent: Sent[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), headers, body: Buffer.from(init?.body as ArrayBuffer).toString('utf8') });
    return new Response('{"ok":true}', {
      status: 200,
      headers: { 'content-type': 'application/json', 'request-id': 'req-fake-1', 'set-cookie': 'session=provider-cookie', 'x-internal': 'drop-me' },
    });
  };
  const routes = createModelProxyRoutes({
    verify: modelTokenVerifier(keys),
    providers: { anthropic: { apiKey: PROVIDER_KEY }, openai: { apiKey: PROVIDER_KEY }, google: { apiKey: PROVIDER_KEY } },
    fetch: fakeFetch,
    clock: () => new Date(now),
    ...over,
  });
  // Through the API server's own router (ADR 0016), with no socket.
  const server = createApiServer({ routes, port: 0 });
  const call = (path: string, init: RequestInit = {}): Promise<Response> => server.fetch(new Request(`http://snapwing-api:8080${path}`, { method: 'POST', ...init }));
  return { routes, sent, call };
}

describe('model tokens', () => {
  it('verify for the work item and run they were issued for, until they expire', () => {
    const t = token();
    expect(t.startsWith('swm1.')).toBe(true);
    expect(verifyModelToken(t, WI, keys)).toMatchObject({ ok: true, claims: { workItemId: WI, runId: RUN } });
    expect(verifyModelToken(t, 'OTHER', keys)).toEqual({ ok: false, reason: 'wrong-work-item' });
    expect(verifyModelToken(`${t}x`, WI, keys)).toMatchObject({ ok: false });
    expect(verifyModelToken(t, WI, { ...keys, secret: 'another-fake-hmac-key-0123456789abcdef' })).toEqual({ ok: false, reason: 'bad-signature' });
    const saved = now;
    now += 46 * 60_000;
    expect(verifyModelToken(t, WI, keys)).toEqual({ ok: false, reason: 'expired' });
    now = saved;
  });

  it('are never fixer tokens, and fixer tokens are never model tokens', () => {
    expect(verifyFixerToken(token(), WI, keys)).toEqual({ ok: false, reason: 'malformed' });
    const fixer = issueFixerToken({ workItemId: WI, incidentId: 'INC01', ttl: 'PT45M' }, keys);
    expect(verifyModelToken(fixer, WI, keys)).toEqual({ ok: false, reason: 'malformed' });
    // Same claims under the other prefix: the MAC covers the prefix.
    const forged = `swf1.${token().split('.')[1] ?? ''}.${token().split('.')[2] ?? ''}`;
    expect(verifyFixerToken(forged, WI, keys)).toMatchObject({ ok: false });
  });

  it('refuse a TTL over a day and a short secret', () => {
    expect(() => token({ ttl: 'P2D' })).toThrow(RangeError);
    expect(() => issueModelToken({ workItemId: WI, runId: RUN, ttl: 'PT1M' }, { ...keys, secret: 'short' })).toThrow(/at least/);
  });
});

describe('model proxy routes', () => {
  it('forwards an Anthropic call with the real key in place of the token, and only safe headers both ways', async () => {
    const { call, sent } = setup();
    const t = token();
    const res = await call(`/model/${WI}/anthropic/v1/messages?beta=true`, {
      headers: { 'x-api-key': t, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', cookie: 'a=b', 'x-forwarded-for': '10.0.0.9' },
      body: '{"model":"m","messages":[]}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('request-id')).toBe('req-fake-1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();

    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(s.body).toBe('{"model":"m","messages":[]}');
    expect(s.headers).toEqual({ 'x-api-key': PROVIDER_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
    expect(JSON.stringify(s)).not.toContain(t);
  });

  it('takes an OpenAI bearer token and sends the key as a bearer', async () => {
    const { call, sent } = setup();
    const res = await call(`/model/${WI}/openai/v1/responses`, { headers: { authorization: `Bearer ${token()}` }, body: '{}' });
    expect(res.status).toBe(200);
    expect(sent[0]).toMatchObject({ url: 'https://api.openai.com/v1/responses', headers: { authorization: `Bearer ${PROVIDER_KEY}` } });
  });

  it('takes a Gemini key parameter, drops it from the forwarded query, and allows only generation methods', async () => {
    const { call, sent } = setup();
    const ok = await call(`/model/${WI}/google/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse&key=${encodeURIComponent(token())}`, { body: '{}' });
    expect(ok.status).toBe(200);
    expect(sent[0]?.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-pro:streamGenerateContent?alt=sse');
    expect(sent[0]?.headers['x-goog-api-key']).toBe(PROVIDER_KEY);

    const other = await call(`/model/${WI}/google/v1beta/models/gemini-2.5-pro:delete`, { headers: { 'x-goog-api-key': token() }, body: '{}' });
    expect(other.status).toBe(404);
    expect(sent).toHaveLength(1);
  });

  it('refuses a missing, forged, or expired token (401) and another work item (403), forwarding nothing', async () => {
    const { call, sent } = setup();
    const path = `/model/${WI}/anthropic/v1/messages`;
    expect((await call(path, { body: '{}' })).status).toBe(401);
    expect((await call(path, { headers: { 'x-api-key': PROVIDER_KEY }, body: '{}' })).status).toBe(401);
    expect((await call(path, { headers: { 'x-api-key': issueFixerToken({ workItemId: WI, incidentId: 'INC01', ttl: 'PT45M' }, keys) }, body: '{}' })).status).toBe(401);
    expect((await call(`/model/OTHER/anthropic/v1/messages`, { headers: { 'x-api-key': token() }, body: '{}' })).status).toBe(403);
    const expired = token({ ttl: 'PT1M' });
    const saved = now;
    now += 2 * 60_000;
    const res = await call(path, { headers: { 'x-api-key': expired }, body: '{}' });
    now = saved;
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(expired);
    expect(sent).toEqual([]);
  });

  it('exposes only generation endpoints, and none for a provider without a key', () => {
    const { routes } = setup({ providers: { anthropic: { apiKey: PROVIDER_KEY } } });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /model/:workItemId/anthropic/v1/messages',
      'POST /model/:workItemId/anthropic/v1/messages/count_tokens',
    ]);
  });

  it('caps the requests of one run (429) and reports an unreachable provider as 502', async () => {
    const { call } = setup({ maxRequestsPerRun: 2 });
    const init = (): RequestInit => ({ headers: { 'x-api-key': token() }, body: '{}' });
    const path = `/model/${WI}/anthropic/v1/messages`;
    expect((await call(path, init())).status).toBe(200);
    expect((await call(path, init())).status).toBe(200);
    expect((await call(path, init())).status).toBe(429);
    // Another run of the same work item has its own allowance.
    expect((await call(path, { headers: { 'x-api-key': token({ runId: '01J9ZRUNID0000000000000002' }) }, body: '{}' })).status).toBe(200);

    const down = setup({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect((await down.call(path, init())).status).toBe(502);
  });
});
