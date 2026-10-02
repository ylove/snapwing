// createApiServer (#125, ADR 0016): web-standard handlers mounted by path on plain node:http.
// No database: these run the same on both legs of the CI matrix.

import { request as httpRequest } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { createApiServer, createRouter, type ApiServer, type Route } from '../../src/server/http.ts';

const servers: ApiServer[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.stop()));
});

async function serve(routes: Route[], extra: { maxBodyBytes?: number; onError?: (e: unknown) => void } = {}): Promise<string> {
  const server = createApiServer({ routes, port: 0, host: '127.0.0.1', ...extra });
  servers.push(server);
  const { port, url } = await server.start();
  expect(port).toBeGreaterThan(0);
  return url;
}

describe('createApiServer', () => {
  it('listens on an ephemeral port and serves a mounted route', async () => {
    const url = await serve([{ method: 'GET', path: '/hello', handler: async () => new Response('hi', { status: 200 }) }]);
    const res = await fetch(`${url}/hello?x=1`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe('hi');
  });

  it('hands the handler the exact raw body bytes and the request headers', async () => {
    // Not valid UTF-8, with CR LF and a trailing NUL: a re-encoding anywhere would change it.
    const sent = Uint8Array.from([0x7b, 0x22, 0x61, 0x22, 0x3a, 0xff, 0xfe, 0x0d, 0x0a, 0x00, 0xc3, 0x28, 0x7d, 0x00]);
    let received: Uint8Array | undefined;
    let signature: string | null = null;
    const url = await serve([
      {
        method: 'POST',
        path: '/webhooks/test',
        handler: async (req) => {
          received = new Uint8Array(await req.arrayBuffer());
          signature = req.headers.get('x-test-signature');
          return new Response(null, { status: 204 });
        },
      },
    ]);
    const res = await fetch(`${url}/webhooks/test`, {
      method: 'POST',
      headers: { 'content-type': 'application/octet-stream', 'x-test-signature': 'v0=fake' },
      body: sent,
    });
    expect(res.status).toBe(204);
    expect(received).toEqual(sent);
    expect(signature).toBe('v0=fake');
  });

  it('answers 404 for an unknown path and 405 with Allow for a known path and another method', async () => {
    const url = await serve([{ method: 'POST', path: '/only-post', handler: async () => new Response('ok') }]);
    const missing = await fetch(`${url}/nope`);
    expect(missing.status).toBe(404);
    const wrong = await fetch(`${url}/only-post`);
    expect(wrong.status).toBe(405);
    expect(wrong.headers.get('allow')).toBe('POST');
  });

  it('turns a throwing handler into a 500 without leaking the error text', async () => {
    const errors: unknown[] = [];
    const url = await serve(
      [
        {
          method: 'GET',
          path: '/boom',
          handler: async () => {
            throw new Error('secret-ish detail: xoxb-test');
          },
        },
      ],
      { onError: (e) => errors.push(e) },
    );
    const res = await fetch(`${url}/boom`);
    expect(res.status).toBe(500);
    const body = await res.text();
    expect(body).toBe('internal error');
    expect(body).not.toContain('xoxb');
    expect(errors).toHaveLength(1);
    expect((errors[0] as Error).message).toContain('secret-ish detail');
  });

  it('passes :name segments as decoded params', async () => {
    const url = await serve([
      {
        method: 'POST',
        path: '/fixer/:workItemId/checkpoint',
        handler: async (_req, { params }) => Response.json(params),
      },
      { method: 'POST', path: '/fixer/runs/checkpoint', handler: async () => new Response('literal') },
    ]);
    const res = await fetch(`${url}/fixer/WI%2001/checkpoint`, { method: 'POST' });
    expect(await res.json()).toEqual({ workItemId: 'WI 01' });
    const literal = await fetch(`${url}/fixer/runs/checkpoint`, { method: 'POST' });
    expect(await literal.text()).toBe('literal');
  });

  it('rejects a body over maxBodyBytes with 413 before the handler runs', async () => {
    let called = false;
    const url = await serve(
      [
        {
          method: 'POST',
          path: '/upload',
          handler: async () => {
            called = true;
            return new Response('ok');
          },
        },
      ],
      { maxBodyBytes: 16 },
    );
    const res = await fetch(`${url}/upload`, { method: 'POST', body: 'x'.repeat(17) });
    expect(res.status).toBe(413);
    expect(called).toBe(false);
  });

  it('stop() stops accepting and waits for a request in flight', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    let entered!: () => void;
    const inHandler = new Promise<void>((r) => (entered = r));
    const server = createApiServer({
      routes: [
        {
          method: 'GET',
          path: '/slow',
          handler: async () => {
            entered();
            await gate;
            return new Response('done');
          },
        },
      ],
      port: 0,
      host: '127.0.0.1',
    });
    const { port } = await server.start();
    const pending = get(port, '/slow');
    await inHandler;
    let stopped = false;
    const stopping = server.stop().then(() => {
      stopped = true;
    });
    await new Promise((r) => setTimeout(r, 50));
    expect(stopped).toBe(false);
    await expect(get(port, '/slow')).rejects.toThrow();
    release();
    expect(await pending).toEqual({ status: 200, body: 'done' });
    await stopping;
    expect(stopped).toBe(true);
  });

  it('dispatches through fetch() without a socket', async () => {
    const server = createApiServer({ routes: [{ method: 'GET', path: '/x', handler: async () => new Response('y') }], port: 0 });
    const res = await server.fetch(new Request('http://local/x'));
    expect(await res.text()).toBe('y');
  });
});

describe('createRouter', () => {
  const h = async (): Promise<Response> => new Response();

  it('refuses a route mounted twice, even with different param names', () => {
    expect(() =>
      createRouter([
        { method: 'GET', path: '/a/:x', handler: h },
        { method: 'GET', path: '/a/:y', handler: h },
      ]),
    ).toThrow(/mounted twice/);
  });

  it('refuses a path without a leading slash or with an empty segment', () => {
    expect(() => createRouter([{ method: 'GET', path: 'a', handler: h }])).toThrow(/start with/);
    expect(() => createRouter([{ method: 'GET', path: '/a//b', handler: h }])).toThrow(/empty segment/);
  });

  it('matches the root and ignores a trailing slash', () => {
    const route = createRouter([
      { method: 'GET', path: '/', handler: h },
      { method: 'GET', path: '/healthz', handler: h },
    ]);
    expect(route('GET', '/').kind).toBe('found');
    expect(route('GET', '/healthz/').kind).toBe('found');
    expect(route('GET', '/healthz/x').kind).toBe('not-found');
  });
});

/** A plain GET on a fresh connection (no keep-alive), so a closed listener refuses it. */
function get(port: number, path: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('error', reject);
    req.end();
  });
}
