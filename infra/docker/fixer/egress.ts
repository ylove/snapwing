// infra/docker/fixer/egress.ts: the relay's egress proxy (#273), the one way a fixer container reaches
// the internet: package registries, so its agent can install a repository's dependencies and run its
// tests. It is an HTTP CONNECT proxy and nothing else:
//
//   - only `CONNECT <host>:443`, and only for a host on the allowlist (an exact name, or `*.<suffix>` for
//     any name under it); plain HTTP requests are refused, since every registry it serves is HTTPS;
//   - the relay resolves the name itself and refuses it when any address is loopback, link-local (the
//     cloud metadata service included), private (RFC 1918 and IPv6 ULA), shared (CGNAT), multicast, or
//     otherwise not a public unicast address; it then connects to the address it checked, so a second
//     answer to the same name (DNS rebinding) never decides where the tunnel goes;
//   - every refusal is one line on stderr naming the host and why, never more.
//
// What goes through the tunnel is TLS between the container and the registry; the relay never sees it.

import { BlockList, connect as tcpConnect, type Socket } from 'node:net';
import { lookup as dnsLookup } from 'node:dns/promises';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface EgressProxy {
  /** `http://<host>:<port>` it listens on. */
  url: string;
  close(): Promise<void>;
}

export interface EgressProxyOptions {
  host: string;
  /** Default 0, any free port. */
  port?: number;
  /** Lowercase host names, each exact or `*.<suffix>`. Empty: every request is refused. */
  allow: readonly string[];
  log: (line: string) => void;
  /** Default the system resolver (`dns.lookup`, every address). */
  lookup?: (host: string) => Promise<readonly { address: string; family: number }[]>;
  /** Opens the upstream connection to a checked address. Default a TCP connection. */
  connect?: (address: string, port: number) => Socket;
}

/** The only port a tunnel may reach. */
export const EGRESS_PORT = 443;
const CONNECT_TIMEOUT_MS = 10_000;

const BLOCKED_RANGES: readonly (readonly [string, number, 'ipv4' | 'ipv6', string])[] = [
  ['0.0.0.0', 8, 'ipv4', 'unspecified'],
  ['10.0.0.0', 8, 'ipv4', 'private'],
  ['100.64.0.0', 10, 'ipv4', 'shared (CGNAT)'],
  ['127.0.0.0', 8, 'ipv4', 'loopback'],
  ['169.254.0.0', 16, 'ipv4', 'link-local (metadata)'],
  ['172.16.0.0', 12, 'ipv4', 'private'],
  ['192.0.0.0', 24, 'ipv4', 'reserved'],
  ['192.168.0.0', 16, 'ipv4', 'private'],
  ['198.18.0.0', 15, 'ipv4', 'reserved'],
  ['224.0.0.0', 4, 'ipv4', 'multicast'],
  ['240.0.0.0', 4, 'ipv4', 'reserved'],
  ['::', 128, 'ipv6', 'unspecified'],
  ['::1', 128, 'ipv6', 'loopback'],
  ['::ffff:0:0', 96, 'ipv6', 'IPv4-mapped'],
  ['64:ff9b::', 96, 'ipv6', 'translated'],
  ['fc00::', 7, 'ipv6', 'private (ULA)'],
  ['fe80::', 10, 'ipv6', 'link-local'],
  ['ff00::', 8, 'ipv6', 'multicast'],
];
// One list per range, each checked only against addresses of its own family: a list holding an IPv6 range
// such as ::ffff:0:0/96 would otherwise match every IPv4 address.
const BLOCKED = BLOCKED_RANGES.map(([net, prefix, type, reason]) => {
  const list = new BlockList();
  list.addSubnet(net, prefix, type);
  return { type, reason, list };
});

/** Why `address` may not be reached, or undefined for a public unicast address. */
export function blockedAddress(address: string, family: number): string | undefined {
  const type = family === 6 ? 'ipv6' : 'ipv4';
  return BLOCKED.find((range) => range.type === type && range.list.check(address, type))?.reason;
}

/** True when `host` is on `allow`: an exact name, or a name under a `*.<suffix>` entry. */
export function hostAllowed(host: string, allow: readonly string[]): boolean {
  const name = host.toLowerCase().replace(/\.$/, '');
  return allow.some((entry) => (entry.startsWith('*.') ? name.endsWith(entry.slice(1)) && name.length > entry.length - 1 : name === entry));
}

export async function startEgressProxy(options: EgressProxyOptions): Promise<EgressProxy> {
  const lookup = options.lookup ?? ((host: string) => dnsLookup(host, { all: true, verbatim: true }));
  const open = options.connect ?? ((address: string, port: number) => tcpConnect({ host: address, port }));
  const server: Server = createServer((req, res) => {
    options.log(`refused ${hostOf(req.url)}: plain HTTP is not proxied`);
    res.writeHead(403, { 'content-type': 'application/json', connection: 'close' }).end('{"error":"only CONNECT to port 443 is proxied"}');
  });

  // Tunnels leave the HTTP server once they connect, so closing it does not end them: these are ended on close.
  const tunnels = new Set<Socket>();
  server.on('connect', (req, client: Socket, head: Buffer) => {
    client.on('error', () => undefined);
    tunnels.add(client);
    client.on('close', () => tunnels.delete(client));
    const target = /^([A-Za-z0-9.-]{1,253}):(\d{1,5})$/.exec(req.url ?? '');
    const refuse = (status: string, who: string, why: string): void => {
      options.log(`refused ${who}: ${why}`);
      client.end(`HTTP/1.1 ${status}\r\ncontent-length: 0\r\nconnection: close\r\n\r\n`);
    };
    if (target === null) return refuse('400 Bad Request', JSON.stringify(req.url ?? ''), 'not host:port');
    const host = (target[1] ?? '').toLowerCase().replace(/\.$/, '');
    const port = Number(target[2]);
    if (port !== EGRESS_PORT) return refuse('403 Forbidden', `${host}:${port}`, `only port ${EGRESS_PORT}`);
    if (!hostAllowed(host, options.allow)) return refuse('403 Forbidden', host, 'not on the allowlist');
    void (async () => {
      let addresses: readonly { address: string; family: number }[];
      try {
        addresses = await lookup(host);
      } catch {
        return refuse('502 Bad Gateway', host, 'does not resolve');
      }
      const first = addresses[0];
      if (first === undefined) return refuse('502 Bad Gateway', host, 'does not resolve');
      for (const a of addresses) {
        const why = blockedAddress(a.address, a.family);
        if (why !== undefined) return refuse('403 Forbidden', host, `resolves to a ${why} address`);
      }
      // The address checked above, never the name again.
      const upstream = open(first.address, port);
      let established = false;
      upstream.setTimeout(CONNECT_TIMEOUT_MS, () => upstream.destroy(new Error('timeout')));
      upstream.once('connect', () => {
        established = true;
        upstream.setTimeout(0);
        client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head.length > 0) upstream.write(head);
        upstream.pipe(client);
        client.pipe(upstream);
      });
      upstream.on('error', () => (established ? client.destroy() : refuse('502 Bad Gateway', host, 'unreachable')));
      client.on('close', () => upstream.destroy());
    })();
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
        for (const s of tunnels) s.destroy();
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** The host a plain request names, for the refusal line. */
function hostOf(url: string | undefined): string {
  try {
    return new URL(url ?? '').host || JSON.stringify(url ?? '');
  } catch {
    return JSON.stringify(url ?? '');
  }
}
