// The API process's HTTP layer (main 14.1, main 14.3, ADR 0016): plain `node:http` and a small
// router over web-standard handlers. Every phase 3 route is a `Route { method, path, handler }`
// whose handler takes a `Request` and returns a `Response`, so a component tests its routes by
// calling the handler, with no server.
//
// - The request body is read in full before the handler runs and handed over byte for byte, so
//   `await req.arrayBuffer()` (or `req.text()`) gives exactly what the client sent, as a signature
//   check (Slack, Jira, GitHub webhooks) needs. Bodies over the route's `maxBodyBytes`, else the
//   server's, get 413 (#272: the chat and Jira routes take `SMALL_BODY_BYTES`). The route is matched
//   first, so an unknown path or method is answered without reading the body at all.
// - Paths match exactly, segment by segment; a `:name` segment matches any one non-empty segment
//   and is passed to the handler as `ctx.params.name` (decoded). A handler that needs no params
//   is written `(req) => ...`. The query string is ignored for matching.
// - An unknown path is 404, a known path with another method is 405 with `Allow`. A handler that
//   throws (or rejects) is 500 with a fixed body; the error goes to `onError`, never to the client.
// - `stop()` stops accepting connections, waits for requests in flight, and closes idle
//   keep-alive connections.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export type HttpMethod = 'GET' | 'HEAD' | 'POST' | 'PUT' | 'PATCH' | 'DELETE' | 'OPTIONS';

export interface RouteContext {
  /** Values of the route's `:name` segments, decoded. Empty for a path without any. */
  readonly params: Readonly<Record<string, string>>;
}

/** The phase 3 handler convention (ADR 0016). The second argument is optional to use. */
export type Handler = (req: Request, ctx: RouteContext) => Promise<Response>;

export interface Route {
  readonly method: HttpMethod;
  /** Absolute path, for example `/healthz` or `/fixer/:workItemId/checkpoint`. */
  readonly path: string;
  readonly handler: Handler;
  /** Largest request body this route takes, in bytes; default the server's `maxBodyBytes`. */
  readonly maxBodyBytes?: number;
}

export interface ApiServerOptions {
  readonly routes: readonly Route[];
  /** Port to listen on; 0 picks a free one (read it from `start()`). */
  readonly port: number;
  /** Interface to bind; default `0.0.0.0`. */
  readonly host?: string;
  /** Largest request body accepted, in bytes; default 10 MiB. */
  readonly maxBodyBytes?: number;
  /** Called with every error a handler throws, and with request-reading failures. */
  readonly onError?: (error: unknown, req: { method: string; path: string }) => void;
}

export interface ApiServer {
  /** Starts listening. Resolves with the bound port and a base URL for it. */
  start(): Promise<{ port: number; url: string }>;
  /** Stops accepting connections and resolves once every request in flight has finished. */
  stop(): Promise<void>;
  /** Dispatches one request through the router without a socket (tests, in-process callers). */
  fetch(req: Request): Promise<Response>;
}

export const DEFAULT_MAX_BODY_BYTES = 10 * 1024 * 1024;

/** The body limit of the chat and Jira webhook routes: their events are small JSON (#272). */
export const SMALL_BODY_BYTES = 1024 * 1024;

const METHODS: readonly HttpMethod[] = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'];

export class RouteConflictError extends Error {
  constructor(readonly method: HttpMethod, readonly path: string) {
    super(`route ${method} ${path} is mounted twice`);
    this.name = 'RouteConflictError';
  }
}

// Router ------------------------------------------------------------------------------------------

type Segment = { kind: 'literal'; value: string } | { kind: 'param'; name: string };

interface Compiled {
  readonly route: Route;
  readonly segments: readonly Segment[];
}

export type RouteMatch =
  | { kind: 'found'; route: Route; params: Record<string, string> }
  | { kind: 'method-not-allowed'; allow: HttpMethod[] }
  | { kind: 'not-found' };

/** Matches a method and path against routes. Literal segments win over params at the same depth. */
export function createRouter(routes: readonly Route[]): (method: string, path: string) => RouteMatch {
  const compiled: Compiled[] = [];
  const seen = new Set<string>();
  for (const route of routes) {
    if (!METHODS.includes(route.method)) {
      throw new TypeError(`route ${route.path}: unsupported method ${JSON.stringify(route.method)}`);
    }
    const segments = compilePath(route.path);
    const shape = `${route.method} ${segments.map((s) => (s.kind === 'literal' ? s.value : ':')).join('/')}`;
    if (seen.has(shape)) {
      throw new RouteConflictError(route.method, route.path);
    }
    seen.add(shape);
    compiled.push({ route, segments });
  }
  // More literal segments first, so `/fixer/runs` beats `/fixer/:id`.
  compiled.sort((a, b) => literalScore(b.segments) - literalScore(a.segments));

  return (method, path) => {
    const parts = splitPath(path);
    if (parts === undefined) {
      return { kind: 'not-found' };
    }
    const allow = new Set<HttpMethod>();
    for (const { route, segments } of compiled) {
      const params = matchSegments(segments, parts);
      if (params === undefined) {
        continue;
      }
      if (route.method === method) {
        return { kind: 'found', route, params };
      }
      allow.add(route.method);
    }
    return allow.size === 0 ? { kind: 'not-found' } : { kind: 'method-not-allowed', allow: [...allow] };
  };
}

function compilePath(path: string): Segment[] {
  if (!path.startsWith('/')) {
    throw new TypeError(`route path must start with "/": ${JSON.stringify(path)}`);
  }
  const parts = path === '/' ? [] : path.slice(1).split('/');
  const names = new Set<string>();
  return parts.map((part): Segment => {
    if (part === '') {
      throw new TypeError(`route path has an empty segment: ${JSON.stringify(path)}`);
    }
    if (part.startsWith(':')) {
      const name = part.slice(1);
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || names.has(name)) {
        throw new TypeError(`route path has a bad or repeated param ${JSON.stringify(part)}: ${JSON.stringify(path)}`);
      }
      names.add(name);
      return { kind: 'param', name };
    }
    return { kind: 'literal', value: part };
  });
}

function literalScore(segments: readonly Segment[]): number {
  return segments.filter((s) => s.kind === 'literal').length;
}

/** Splits a request path into decoded segments; a trailing slash is ignored. Undefined when undecodable. */
function splitPath(path: string): string[] | undefined {
  const trimmed = path.length > 1 && path.endsWith('/') ? path.slice(0, -1) : path;
  const raw = trimmed === '/' || trimmed === '' ? [] : trimmed.slice(1).split('/');
  try {
    return raw.map((p) => decodeURIComponent(p));
  } catch {
    return undefined;
  }
}

function matchSegments(segments: readonly Segment[], parts: readonly string[]): Record<string, string> | undefined {
  if (segments.length !== parts.length) {
    return undefined;
  }
  const params: Record<string, string> = {};
  for (let i = 0; i < segments.length; i++) {
    const segment = segments[i];
    const part = parts[i];
    if (segment === undefined || part === undefined) {
      return undefined;
    }
    if (segment.kind === 'literal') {
      if (segment.value !== part) {
        return undefined;
      }
    } else {
      if (part === '') {
        return undefined;
      }
      params[segment.name] = part;
    }
  }
  return params;
}

// Server ------------------------------------------------------------------------------------------

export function createApiServer(options: ApiServerOptions): ApiServer {
  const route = createRouter(options.routes);
  const maxBodyBytes = options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  const onError = options.onError ?? (() => undefined);
  const host = options.host ?? '0.0.0.0';
  let server: Server | undefined;

  const dispatch = async (req: Request): Promise<Response> => {
    const path = new URL(req.url).pathname;
    const match = route(req.method, path);
    if (match.kind === 'not-found') {
      return text(404, 'not found');
    }
    if (match.kind === 'method-not-allowed') {
      return text(405, 'method not allowed', { allow: match.allow.join(', ') });
    }
    try {
      return await match.route.handler(req, { params: match.params });
    } catch (e) {
      onError(e, { method: req.method, path });
      return text(500, 'internal error');
    }
  };

  const listener = (incoming: IncomingMessage, outgoing: ServerResponse): void => {
    void handleNode(incoming, outgoing).catch((e: unknown) => {
      onError(e, { method: incoming.method ?? '', path: (incoming.url ?? '').split('?')[0] ?? '' });
      if (!outgoing.headersSent) {
        outgoing.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
      }
      outgoing.end();
    });
  };

  const handleNode = async (incoming: IncomingMessage, outgoing: ServerResponse): Promise<void> => {
    const method = (incoming.method ?? 'GET').toUpperCase();
    const match = route(method, new URL(incoming.url ?? '/', 'http://localhost').pathname);
    if (match.kind !== 'found') {
      incoming.resume();
      await writeResponse(outgoing, await dispatch(toRequest(incoming, Buffer.alloc(0))), method === 'HEAD');
      return;
    }
    const body = await readBody(incoming, match.route.maxBodyBytes ?? maxBodyBytes);
    if (body === 'too-large') {
      await writeResponse(outgoing, text(413, 'payload too large', { connection: 'close' }));
      return;
    }
    const response = await dispatch(toRequest(incoming, body));
    await writeResponse(outgoing, response, incoming.method === 'HEAD');
  };

  return {
    async start() {
      if (server !== undefined) {
        throw new Error('api server already started');
      }
      const s = createServer(listener);
      server = s;
      await new Promise<void>((resolve, reject) => {
        s.once('error', reject);
        s.listen(options.port, host, () => {
          s.off('error', reject);
          resolve();
        });
      });
      const { port } = s.address() as AddressInfo;
      const shown = host === '0.0.0.0' || host === '::' ? '127.0.0.1' : host.includes(':') ? `[${host}]` : host;
      return { port, url: `http://${shown}:${port}` };
    },
    async stop() {
      const s = server;
      if (s === undefined) {
        return;
      }
      server = undefined;
      await new Promise<void>((resolve, reject) => {
        s.close((e) => (e === undefined ? resolve() : reject(e)));
        // close() stops accepting and waits for open connections; idle keep-alive ones end now,
        // busy ones end after their response (Node marks them closing).
        s.closeIdleConnections();
      });
    },
    fetch: dispatch,
  };
}

function text(status: number, body: string, headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers: { 'content-type': 'text/plain; charset=utf-8', ...headers } });
}

function readBody(incoming: IncomingMessage, limit: number): Promise<Buffer | 'too-large'> {
  const declared = Number(incoming.headers['content-length']);
  if (Number.isFinite(declared) && declared > limit) {
    incoming.resume();
    return Promise.resolve('too-large');
  }
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let over = false;
    incoming.on('data', (chunk: Buffer | string) => {
      if (over) {
        return;
      }
      const buf = typeof chunk === 'string' ? Buffer.from(chunk) : chunk;
      size += buf.length;
      if (size > limit) {
        // Keep reading (and dropping) so the 413 can still be written on this socket.
        over = true;
        chunks.length = 0;
        resolve('too-large');
        return;
      }
      chunks.push(buf);
    });
    incoming.once('end', () => {
      if (!over) {
        resolve(Buffer.concat(chunks, size));
      }
    });
    incoming.once('error', reject);
  });
}

function toRequest(incoming: IncomingMessage, body: Buffer): Request {
  const method = (incoming.method ?? 'GET').toUpperCase();
  const hostHeader = incoming.headers.host ?? 'localhost';
  const url = new URL(incoming.url ?? '/', `http://${hostHeader}`);
  const headers = new Headers();
  for (let i = 0; i + 1 < incoming.rawHeaders.length; i += 2) {
    const name = incoming.rawHeaders[i];
    const value = incoming.rawHeaders[i + 1];
    if (name !== undefined && value !== undefined) {
      headers.append(name, value);
    }
  }
  const hasBody = method !== 'GET' && method !== 'HEAD';
  return new Request(url, { method, headers, ...(hasBody ? { body: new Uint8Array(body) } : {}) });
}

async function writeResponse(outgoing: ServerResponse, response: Response, headOnly = false): Promise<void> {
  const bytes = headOnly ? undefined : Buffer.from(await response.arrayBuffer());
  const headers: Record<string, string | string[]> = {};
  response.headers.forEach((value, name) => {
    if (name !== 'set-cookie') {
      headers[name] = value;
    }
  });
  const cookies = response.headers.getSetCookie();
  if (cookies.length > 0) {
    headers['set-cookie'] = cookies;
  }
  if (bytes !== undefined) {
    headers['content-length'] = String(bytes.length);
  }
  if (response.statusText === '') {
    outgoing.writeHead(response.status, headers);
  } else {
    outgoing.writeHead(response.status, response.statusText, headers);
  }
  outgoing.end(bytes);
}
