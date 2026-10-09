// Model proxy (ADR 0017, amendment 1; #273): per-run model tokens and the proxy routes a fixer or review
// container's wrapper calls instead of holding a provider key. The provider is a fake `fetch`; no
// network. The counters and revocation are the real state store's (`SNAPWING_DB` picks the dialect).

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { issueFixerToken, verifyFixerToken } from '../../src/fixer-api/token.ts';
import { createModelProxyRoutes, type ModelProxyOptions, type ModelProxyRoute } from '../../src/model-proxy/routes.ts';
import { issueModelToken, modelTokenVerifier, verifyModelToken, type ModelTokenInput } from '../../src/model-proxy/token.ts';
import { createApiServer } from '../../src/server/http.ts';

const SECRET = 'fake-hmac-key-for-tests-0123456789abcdef';
let now = Date.parse('2026-10-02T12:00:00Z');
const keys = { secret: SECRET, clock: () => new Date(now) };
const PROVIDER_KEY = 'fake-provider-key-for-tests';
const WI = '01J9ZWORKITEM0000000000001';
const RUN = '01J9ZRUNID0000000000000001';

function token(over: Partial<ModelTokenInput> = {}): string {
  return issueModelToken({ workItemId: WI, runId: RUN, ttl: 'PT45M', provider: 'anthropic', model: 'claude-pinned', maxTokens: 1000, ...over }, keys);
}

let tdb: TestDatabase;
let store: StateStore;
beforeAll(async () => {
  tdb = await createTestDatabase();
  const opened = await tdb.open();
  if (!(opened instanceof StateStore)) throw new Error('openState did not return a StateStore');
  store = opened;
});
beforeEach(async () => {
  await store.ctx.db.deleteFrom('run_credentials').execute();
});
afterAll(async () => {
  await tdb.drop();
});

interface Sent {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/** A provider answer: JSON (the default) or a server-sent event stream. */
let answer: { contentType: string; body: string } = { contentType: 'application/json', body: '{"ok":true}' };

function setup(over: Partial<ModelProxyOptions> = {}): { routes: ModelProxyRoute[]; sent: Sent[]; call: (path: string, init?: RequestInit) => Promise<Response> } {
  const sent: Sent[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const headers: Record<string, string> = {};
    new Headers(init?.headers).forEach((v, k) => (headers[k] = v));
    sent.push({ url: String(input), headers, body: String(init?.body) });
    return new Response(answer.body, {
      status: 200,
      headers: { 'content-type': answer.contentType, 'request-id': 'req-fake-1', 'set-cookie': 'session=provider-cookie', 'x-internal': 'drop-me' },
    });
  };
  const routes = createModelProxyRoutes({
    verify: modelTokenVerifier(keys),
    providers: { anthropic: { apiKey: PROVIDER_KEY }, openai: { apiKey: PROVIDER_KEY }, google: { apiKey: PROVIDER_KEY } },
    credentials: store,
    fetch: fakeFetch,
    ...over,
  });
  // Through the API server's own router (ADR 0016), with no socket.
  const server = createApiServer({ routes, port: 0 });
  const call = (path: string, init: RequestInit = {}): Promise<Response> => server.fetch(new Request(`http://snapwing-api:8080${path}`, { method: 'POST', ...init }));
  return { routes, sent, call };
}

const MESSAGES = `/model/${WI}/anthropic/v1/messages`;
const anthropicCall = (t = token(), body: unknown = { model: 'claude-other', max_tokens: 64000, messages: [] }): RequestInit => ({ headers: { 'x-api-key': t, 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** Lets a metered response's usage reach the store. */
async function settled(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 5));
}

describe('model tokens', () => {
  it('verify for the work item and run they were issued for, with their grant, until they expire', () => {
    const t = token();
    expect(t.startsWith('swm1.')).toBe(true);
    expect(verifyModelToken(t, WI, keys)).toMatchObject({ ok: true, claims: { workItemId: WI, runId: RUN, provider: 'anthropic', model: 'claude-pinned', maxTokens: 1000 } });
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
    const fixer = issueFixerToken({ workItemId: WI, incidentId: 'INC01', runId: RUN, ttl: 'PT45M' }, keys);
    expect(verifyModelToken(fixer, WI, keys)).toEqual({ ok: false, reason: 'malformed' });
    // Same claims under the other prefix: the MAC covers the prefix.
    const forged = `swf1.${token().split('.')[1] ?? ''}.${token().split('.')[2] ?? ''}`;
    expect(verifyFixerToken(forged, WI, keys)).toMatchObject({ ok: false });
  });

  it('refuse a TTL over a day, a short secret, and a grant without a model or cap', () => {
    expect(() => token({ ttl: 'P2D' })).toThrow(RangeError);
    expect(() => issueModelToken({ workItemId: WI, runId: RUN, ttl: 'PT1M', provider: 'anthropic', model: 'm', maxTokens: 1 }, { ...keys, secret: 'short' })).toThrow(/at least/);
    expect(() => token({ model: '' })).toThrow(TypeError);
    expect(() => token({ maxTokens: 0 })).toThrow(RangeError);
  });
});

describe('model proxy routes', () => {
  it('forwards an Anthropic call with the real key in place of the token, and only safe headers both ways', async () => {
    const { call, sent } = setup();
    const t = token();
    const res = await call(`${MESSAGES}?beta=true`, {
      headers: { 'x-api-key': t, 'content-type': 'application/json', 'anthropic-version': '2023-06-01', cookie: 'a=b', 'x-forwarded-for': '10.0.0.9' },
      body: '{"model":"claude-pinned","max_tokens":16,"messages":[]}',
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('{"ok":true}');
    expect(res.headers.get('request-id')).toBe('req-fake-1');
    expect(res.headers.get('set-cookie')).toBeNull();
    expect(res.headers.get('x-internal')).toBeNull();

    expect(sent).toHaveLength(1);
    const s = sent[0]!;
    expect(s.url).toBe('https://api.anthropic.com/v1/messages?beta=true');
    expect(JSON.parse(s.body)).toEqual({ model: 'claude-pinned', max_tokens: 16, messages: [] });
    expect(s.headers).toEqual({ 'x-api-key': PROVIDER_KEY, 'content-type': 'application/json', 'anthropic-version': '2023-06-01' });
    expect(JSON.stringify(s)).not.toContain(t);
  });

  it('pins the model and caps max_tokens from the token, on every provider (#273)', async () => {
    const { call, sent } = setup();
    await call(MESSAGES, anthropicCall(token(), { model: 'claude-other', max_tokens: 64000, thinking: { type: 'enabled', budget_tokens: 5000 }, messages: [] }));
    expect(JSON.parse(sent[0]!.body)).toMatchObject({ model: 'claude-pinned', max_tokens: 1000, thinking: { budget_tokens: 999 } });

    const openai = token({ provider: 'openai', model: 'gpt-pinned' });
    await call(`/model/${WI}/openai/v1/responses`, { headers: { authorization: `Bearer ${openai}` }, body: '{"model":"gpt-other","input":"x"}' });
    expect(JSON.parse(sent[1]!.body)).toEqual({ model: 'gpt-pinned', input: 'x', max_output_tokens: 1000 });
    await call(`/model/${WI}/openai/v1/chat/completions`, { headers: { authorization: `Bearer ${openai}` }, body: '{"model":"gpt-other","max_tokens":50,"stream":true,"messages":[]}' });
    expect(JSON.parse(sent[2]!.body)).toEqual({ model: 'gpt-pinned', max_completion_tokens: 50, stream: true, stream_options: { include_usage: true }, messages: [] });

    const google = token({ provider: 'google', model: 'gemini-pinned' });
    await call(`/model/${WI}/google/v1beta/models/gemini-other:streamGenerateContent?alt=sse&key=${encodeURIComponent(google)}`, { body: '{"contents":[],"generationConfig":{"maxOutputTokens":99999}}' });
    expect(sent[3]!.url).toBe('https://generativelanguage.googleapis.com/v1beta/models/gemini-pinned:streamGenerateContent?alt=sse');
    expect(sent[3]!.headers['x-goog-api-key']).toBe(PROVIDER_KEY);
    expect(JSON.parse(sent[3]!.body)).toEqual({ contents: [], generationConfig: { maxOutputTokens: 1000 } });

    const other = await call(`/model/${WI}/google/v1beta/models/gemini-other:delete`, { headers: { 'x-goog-api-key': google }, body: '{}' });
    expect(other.status).toBe(404);
    expect(sent).toHaveLength(4);
  });

  it("limits each token to its harness's provider and refuses a body that is not a JSON object", async () => {
    const { call, sent } = setup();
    const wrong = await call(`/model/${WI}/openai/v1/responses`, { headers: { authorization: `Bearer ${token()}` }, body: '{}' });
    expect(wrong.status).toBe(403);
    expect(await wrong.json()).toEqual({ error: 'wrong-provider' });
    expect((await call(MESSAGES, { headers: { 'x-api-key': token() }, body: 'not json' })).status).toBe(400);
    expect((await call(MESSAGES, { headers: { 'x-api-key': token() }, body: '[1]' })).status).toBe(400);
    expect(sent).toEqual([]);
  });

  it('refuses a missing, forged, or expired token (401) and another work item (403), forwarding nothing', async () => {
    const { call, sent } = setup();
    expect((await call(MESSAGES, { body: '{}' })).status).toBe(401);
    expect((await call(MESSAGES, { headers: { 'x-api-key': PROVIDER_KEY }, body: '{}' })).status).toBe(401);
    expect((await call(MESSAGES, { headers: { 'x-api-key': issueFixerToken({ workItemId: WI, incidentId: 'INC01', runId: RUN, ttl: 'PT45M' }, keys) }, body: '{}' })).status).toBe(401);
    expect((await call(`/model/OTHER/anthropic/v1/messages`, { headers: { 'x-api-key': token() }, body: '{}' })).status).toBe(403);
    const expired = token({ ttl: 'PT1M' });
    const saved = now;
    now += 2 * 60_000;
    const res = await call(MESSAGES, { headers: { 'x-api-key': expired }, body: '{}' });
    now = saved;
    expect(res.status).toBe(401);
    expect(await res.text()).not.toContain(expired);
    expect(sent).toEqual([]);
  });

  it('refuses a revoked token: its run ended or was stopped (#273)', async () => {
    const { call, sent } = setup();
    expect((await call(MESSAGES, anthropicCall())).status).toBe(200);
    await store.revokeRunCredentials(RUN);
    const res = await call(MESSAGES, anthropicCall());
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: 'revoked' });
    expect(sent).toHaveLength(1);
    // Another run of the same work item is untouched.
    expect((await call(MESSAGES, anthropicCall(token({ runId: '01J9ZRUNID0000000000000002' })))).status).toBe(200);
  });

  it('meters input and output tokens from a JSON answer and from an event stream, in the state store', async () => {
    const { call } = setup();
    answer = { contentType: 'application/json', body: JSON.stringify({ id: 'msg', usage: { input_tokens: 100, cache_read_input_tokens: 20, output_tokens: 7 } }) };
    expect(await (await call(MESSAGES, anthropicCall())).json()).toMatchObject({ id: 'msg' });
    const events = [
      { type: 'message_start', message: { usage: { input_tokens: 300, output_tokens: 1 } } },
      { type: 'content_block_delta', delta: { text: 'hi' } },
      { type: 'message_delta', usage: { output_tokens: 42 } },
    ];
    answer = { contentType: 'text/event-stream', body: events.map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join('') };
    const streamed = await (await call(MESSAGES, anthropicCall())).text();
    expect(streamed).toBe(answer.body);
    await settled();
    expect(await store.runCredentialUse(RUN)).toMatchObject({ modelRequests: 2, inputTokens: 420, outputTokens: 49 });

    const google = token({ provider: 'google', model: 'gemini-pinned', runId: '01J9ZRUNID0000000000000003' });
    answer = { contentType: 'application/json', body: JSON.stringify([{ usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 2 } }, { usageMetadata: { promptTokenCount: 10, candidatesTokenCount: 5, thoughtsTokenCount: 3 } }]) };
    await (await call(`/model/${WI}/google/v1beta/models/x:streamGenerateContent`, { headers: { 'x-goog-api-key': google }, body: '{}' })).text();
    await settled();
    expect(await store.runCredentialUse('01J9ZRUNID0000000000000003')).toMatchObject({ inputTokens: 10, outputTokens: 8 });
    answer = { contentType: 'application/json', body: '{"ok":true}' };
  });

  it('caps the requests and the tokens of one run (429), persisted, and reports an unreachable provider as 502', async () => {
    const { call } = setup({ maxRequestsPerRun: 2 });
    expect((await call(MESSAGES, anthropicCall())).status).toBe(200);
    expect((await call(MESSAGES, anthropicCall())).status).toBe(200);
    // A proxy in another process (or after a restart) sees the same count.
    const again = setup({ maxRequestsPerRun: 2 });
    const capped = await again.call(MESSAGES, anthropicCall());
    expect(capped.status).toBe(429);
    expect(await capped.json()).toEqual({ error: 'run-request-cap' });
    // Another run of the same work item has its own allowance.
    expect((await call(MESSAGES, anthropicCall(token({ runId: '01J9ZRUNID0000000000000002' })))).status).toBe(200);

    const spent = setup({ maxTokensPerRun: 100 });
    await store.recordModelTokens('01J9ZRUNID0000000000000004', 90, 10);
    const over = await spent.call(MESSAGES, anthropicCall(token({ runId: '01J9ZRUNID0000000000000004' })));
    expect(over.status).toBe(429);
    expect(await over.json()).toEqual({ error: 'run-token-cap' });

    const down = setup({ fetch: () => Promise.reject(new Error('ECONNREFUSED')) });
    expect((await down.call(MESSAGES, anthropicCall(token({ runId: '01J9ZRUNID0000000000000005' })))).status).toBe(502);
  });

  it('exposes only generation endpoints, and none for a provider without a key', () => {
    const { routes } = setup({ providers: { anthropic: { apiKey: PROVIDER_KEY } } });
    expect(routes.map((r) => `${r.method} ${r.path}`)).toEqual([
      'POST /model/:workItemId/anthropic/v1/messages',
      'POST /model/:workItemId/anthropic/v1/messages/count_tokens',
    ]);
  });
});
