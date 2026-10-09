import { http, HttpResponse, delay } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createCaptureClient } from '../../src/client.ts';
import { CaptureAuthError, CaptureServerError, CaptureTimeoutError } from '../../src/errors.ts';
import type { LookupResponse } from '../../src/wire.ts';

// A plain http localhost endpoint on purpose: nothing assumes HTTPS or a hosted domain.
const BASE = 'http://localhost:4311';
const TOKEN = 'sw_user_token_123';

interface Seen {
  method: string;
  url: string;
  auth: string | null;
  body: unknown;
}
let seen: Seen[] = [];

async function record(request: Request): Promise<void> {
  const text = await request.clone().text();
  seen.push({
    method: request.method,
    url: request.url,
    auth: request.headers.get('authorization'),
    body: text === '' ? undefined : (JSON.parse(text) as unknown),
  });
}

const tracked: LookupResponse = {
  kind: 'tracked',
  captureId: 'c1',
  issueKey: 'WEB-830',
  summary: 'Cart blank',
  status: 'open',
  assignee: 'Dana',
  url: 'http://jira.local/browse/WEB-830',
};

const server = setupServer(
  http.post(`${BASE}/capture`, async ({ request }) => {
    await record(request);
    return HttpResponse.json(tracked);
  }),
  http.post(`${BASE}/capture/:id/answer`, async ({ request }) => {
    await record(request);
    return HttpResponse.json({ kind: 'filed', captureId: 'c1', issueKey: 'WEB-9', url: 'http://jira.local/browse/WEB-9' });
  }),
  http.get(`${BASE}/capture/:id`, async ({ request }) => {
    await record(request);
    return HttpResponse.json({ kind: 'pending', captureId: 'c1' });
  }),
  http.get(`${BASE}/issues/:key/status`, async ({ request }) => {
    await record(request);
    return HttpResponse.json({ issueKey: 'WEB-830', summary: 'Cart blank', status: 'in progress', url: 'u' });
  }),
  http.post(`${BASE}/issues/:key/stop`, async ({ request }) => {
    await record(request);
    return HttpResponse.json({ issueKey: 'WEB-830', stopped: true });
  }),
  http.get(`${BASE}/healthz`, async ({ request }) => {
    await record(request);
    return HttpResponse.json({ ok: true });
  }),
);

beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  seen = [];
});
afterAll(() => server.close());

const client = createCaptureClient({ endpoint: BASE, token: TOKEN });

describe('capture client calls', () => {
  it('sendText posts the request with the bearer header only', async () => {
    const r = await client.sendText('checkout is blank', {
      source: 'raycast',
      surface: 'web',
      context: { url: 'http://localhost:3000/cart' },
    });
    expect(r).toEqual(tracked);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe(`${BASE}/capture`);
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.body).toEqual({
      text: 'checkout is blank',
      source: 'raycast',
      surface: 'web',
      context: { url: 'http://localhost:3000/cart' },
    });
    expect(JSON.stringify(seen[0]?.body)).not.toContain(TOKEN);
    expect(seen[0]?.url).not.toContain(TOKEN);
  });

  it('sendText defaults the source to cli', async () => {
    await client.sendText('hi');
    expect(seen[0]?.body).toEqual({ text: 'hi', source: 'cli' });
  });

  it('sendImage posts base64 with its mime type', async () => {
    await client.sendImage('aGVsbG8=', 'image/png', { source: 'cli' });
    expect(seen[0]?.body).toEqual({ image: 'aGVsbG8=', mimeType: 'image/png', source: 'cli' });
    expect(seen[0]?.auth).toBe(`Bearer ${TOKEN}`);
  });

  it('answer posts the choice to the capture', async () => {
    const r = await client.answer('c1', 'file');
    expect(r.kind).toBe('filed');
    expect(seen[0]?.url).toBe(`${BASE}/capture/c1/answer`);
    expect(seen[0]?.body).toEqual({ choiceId: 'file' });
  });

  it('poll gets the capture', async () => {
    expect(await client.poll('c1')).toEqual({ kind: 'pending', captureId: 'c1' });
    expect(seen[0]).toMatchObject({ method: 'GET', url: `${BASE}/capture/c1`, auth: `Bearer ${TOKEN}` });
  });

  it('status gets the ticket status and encodes the key', async () => {
    const s = await client.status('WEB-830');
    expect(s.status).toBe('in progress');
    expect(seen[0]?.url).toBe(`${BASE}/issues/WEB-830/status`);
  });

  it('stop posts to the ticket', async () => {
    expect(await client.stop('WEB-830')).toEqual({ issueKey: 'WEB-830', stopped: true });
    expect(seen[0]).toMatchObject({ method: 'POST', url: `${BASE}/issues/WEB-830/stop` });
  });

  it('health needs no token', async () => {
    expect(await client.health()).toEqual({ ok: true });
    expect(seen[0]?.auth).toBeNull();
  });

  it('keeps a path prefix and ignores a trailing slash on the endpoint', async () => {
    server.use(
      http.get(`${BASE}/snapwing/healthz`, () => HttpResponse.json({ ok: true })),
    );
    const c = createCaptureClient({ endpoint: `${BASE}/snapwing/`, token: TOKEN });
    expect(await c.health()).toEqual({ ok: true });
  });

  it('uses an injected fetch', async () => {
    const calls: string[] = [];
    const c = createCaptureClient({
      endpoint: 'http://localhost',
      token: TOKEN,
      fetch: (input) => {
        calls.push(input);
        return Promise.resolve(Response.json({ ok: true }));
      },
    });
    expect(await c.health()).toEqual({ ok: true });
    expect(calls).toEqual(['http://localhost/healthz']);
  });
});

describe('capture client errors', () => {
  it.each([401, 403])('maps %i to CaptureAuthError on every authed call', async (status) => {
    server.use(
      http.post(`${BASE}/capture`, () => new HttpResponse(null, { status })),
      http.post(`${BASE}/capture/:id/answer`, () => new HttpResponse(null, { status })),
      http.get(`${BASE}/capture/:id`, () => new HttpResponse(null, { status })),
      http.get(`${BASE}/issues/:key/status`, () => new HttpResponse(null, { status })),
      http.post(`${BASE}/issues/:key/stop`, () => new HttpResponse(null, { status })),
    );
    const calls = [
      () => client.sendText('x'),
      () => client.sendImage('aGk=', 'image/png'),
      () => client.answer('c1', 'file'),
      () => client.poll('c1'),
      () => client.status('WEB-1'),
      () => client.stop('WEB-1'),
    ];
    for (const call of calls) {
      const err = await call().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(CaptureAuthError);
      expect((err as CaptureAuthError).status).toBe(status);
    }
  });

  it('maps 5xx and other failures to CaptureServerError with the status', async () => {
    server.use(http.post(`${BASE}/capture`, () => new HttpResponse(null, { status: 503 })));
    const err = await client.sendText('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureServerError);
    expect((err as CaptureServerError).status).toBe(503);
    server.use(http.get(`${BASE}/issues/:key/status`, () => new HttpResponse(null, { status: 404 })));
    const notFound = await client.status('NOPE-1').catch((e: unknown) => e);
    expect(notFound).toBeInstanceOf(CaptureServerError);
    expect((notFound as CaptureServerError).status).toBe(404);
  });

  it('maps a malformed body to CaptureServerError', async () => {
    server.use(http.get(`${BASE}/capture/:id`, () => HttpResponse.json({ kind: 'maybe', captureId: 'c' })));
    const err = await client.poll('c1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureServerError);
    expect((err as CaptureServerError).message).toContain('Unexpected response');
    server.use(http.get(`${BASE}/capture/:id`, () => new HttpResponse('<html>', { status: 200 })));
    const html = await client.poll('c1').catch((e: unknown) => e);
    expect(html).toBeInstanceOf(CaptureServerError);
  });

  it('maps a network failure to CaptureServerError with a null status', async () => {
    server.use(http.get(`${BASE}/healthz`, () => HttpResponse.error()));
    const err = await client.health().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureServerError);
    expect((err as CaptureServerError).status).toBeNull();
  });

  it('maps a slow server to CaptureTimeoutError', async () => {
    server.use(
      http.post(`${BASE}/capture`, async () => {
        await delay(500);
        return HttpResponse.json(tracked);
      }),
    );
    const slow = createCaptureClient({ endpoint: BASE, token: TOKEN, timeoutMs: 40 });
    const err = await slow.sendText('x').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(CaptureTimeoutError);
    expect((err as CaptureTimeoutError).timeoutMs).toBe(40);
  });

  it('never puts the token in an error message', async () => {
    server.use(http.post(`${BASE}/capture`, () => new HttpResponse(null, { status: 401 })));
    const err = await client.sendText('x').catch((e: unknown) => e);
    expect((err as Error).message).not.toContain(TOKEN);
  });
});
