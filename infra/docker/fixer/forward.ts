// infra/docker/fixer/forward.ts: a small HTTP forwarder to one upstream (#273), used twice in the fixer
// image: by the relay (relay.ts), the only thing on the containers' internal network that reaches the
// server, and by the wrapper (wrapper.ts), which serves the agent's model calls on loopback and adds the
// run's model token, so the agent never holds it.
//
// A request is forwarded only when its normalized path passes `allow`; anything else is 404. The path is
// appended to the upstream URL's own path, the query is kept (less any `key` parameter), and request and
// response bodies stream through unbuffered (server-sent events included). Hop-by-hop headers are
// dropped both ways, and `headers` decides what else goes upstream. Nothing here logs a header.

import { createServer, request as httpRequest, type IncomingHttpHeaders, type OutgoingHttpHeaders, type Server } from 'node:http';
import { request as httpsRequest } from 'node:https';
import type { AddressInfo } from 'node:net';

export interface Forwarder {
  /** `http://<host>:<port>` it listens on. */
  url: string;
  close(): Promise<void>;
}

export interface ForwarderOptions {
  upstream: string;
  host: string;
  /** Default 0, any free port. */
  port?: number;
  allow: (pathname: string) => boolean;
  /** The request headers sent upstream, from the caller's (hop-by-hop headers already removed). */
  headers: (incoming: OutgoingHttpHeaders) => OutgoingHttpHeaders;
}

const HOP_BY_HOP = new Set(['connection', 'keep-alive', 'proxy-authorization', 'proxy-authenticate', 'proxy-connection', 'te', 'trailer', 'transfer-encoding', 'upgrade', 'host']);

export async function startForwarder(options: ForwarderOptions): Promise<Forwarder> {
  const upstream = new URL(options.upstream);
  if (upstream.protocol !== 'http:' && upstream.protocol !== 'https:') throw new Error('the upstream must be an http(s) URL');
  const base = upstream.pathname.replace(/\/+$/, '');
  const send = upstream.protocol === 'https:' ? httpsRequest : httpRequest;

  const server: Server = createServer((req, res) => {
    const raw = req.url ?? '';
    const parsed = raw.startsWith('/') && !raw.startsWith('//') ? new URL(raw, 'http://forwarder.invalid') : undefined;
    if (parsed === undefined || !options.allow(parsed.pathname)) {
      res.writeHead(404, { 'content-type': 'application/json' }).end('{"error":"not-forwarded"}');
      return;
    }
    parsed.searchParams.delete('key');
    const target = new URL(`${base}${parsed.pathname}${parsed.search}`, upstream.origin);
    const up = send(target, { method: req.method, headers: { ...options.headers(strip(req.headers)), host: upstream.host } }, (answer) => {
      res.writeHead(answer.statusCode ?? 502, strip(answer.headers));
      answer.pipe(res);
    });
    up.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'content-type': 'application/json' });
      res.end(res.headersSent ? undefined : '{"error":"upstream-unreachable"}');
    });
    req.pipe(up);
  });
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, options.host, resolve);
  });
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://${options.host}:${port}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

function strip(headers: IncomingHttpHeaders): OutgoingHttpHeaders {
  const out: OutgoingHttpHeaders = {};
  for (const [name, value] of Object.entries(headers)) if (value !== undefined && !HOP_BY_HOP.has(name)) out[name] = value;
  return out;
}
