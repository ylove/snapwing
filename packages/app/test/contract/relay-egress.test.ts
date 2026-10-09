// The relay's egress proxy (#273, infra/docker/fixer/egress.ts): the CONNECT proxy that is a fixer
// container's only way to the package registries. The resolver is a fake (or the system's, for
// `localhost`) and an allowed tunnel ends at a local echo server, so nothing here reaches the internet.

import { connect as tcpConnect, createServer, type AddressInfo, type Server, type Socket } from 'node:net';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { blockedAddress, hostAllowed, startEgressProxy, type EgressProxy, type EgressProxyOptions } from '../../../../infra/docker/fixer/egress.ts';
import { DEFAULT_FIXER_EGRESS_ALLOW, parseEgressAllow } from '../../src/providers/docker/runner.ts';

/** A documentation address (TEST-NET-3): public as far as the proxy can tell, and routed nowhere here. */
const PUBLIC = '203.0.113.7';

let echo: Server;
let echoPort: number;
let proxy: EgressProxy | undefined;
let logged: string[];
let lookups: string[];
let opened: string[];

beforeEach(async () => {
  echo = createServer((s) => s.pipe(s));
  await new Promise<void>((r) => echo.listen(0, '127.0.0.1', r));
  echoPort = (echo.address() as AddressInfo).port;
  logged = [];
  lookups = [];
  opened = [];
});

afterEach(async () => {
  await proxy?.close();
  proxy = undefined;
  await new Promise<void>((r) => echo.close(() => r()));
});

/** The proxy with `answers` as the resolver's, and every tunnel ending at the echo server. */
async function start(allow: readonly string[], answers: Record<string, string[]> | 'system' = {}, over: Partial<EgressProxyOptions> = {}): Promise<string> {
  proxy = await startEgressProxy({
    host: '127.0.0.1',
    allow,
    log: (line) => logged.push(line),
    ...(answers === 'system'
      ? {}
      : {
          lookup: async (host: string) => {
            lookups.push(host);
            const list = answers[host] ?? [PUBLIC];
            return list.map((address) => ({ address, family: address.includes(':') ? 6 : 4 }));
          },
        }),
    connect: (address, port) => {
      opened.push(`${address}:${port}`);
      return tcpConnect({ host: '127.0.0.1', port: echoPort });
    },
    ...over,
  });
  return proxy.url;
}

/** Sends `CONNECT target`, returns the status line, and on 200 what a ping through the tunnel brought back. */
async function tunnel(url: string, target: string): Promise<{ status: string; echoed?: string }> {
  const { port } = new URL(url);
  const socket: Socket = tcpConnect({ host: '127.0.0.1', port: Number(port) });
  return new Promise((resolve, reject) => {
    let buffer = '';
    let status: string | undefined;
    socket.on('error', reject);
    socket.on('data', (chunk: Buffer) => {
      buffer += chunk.toString('utf8');
      if (status === undefined) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) return;
        status = buffer.slice(0, buffer.indexOf('\r\n'));
        buffer = buffer.slice(end + 4);
        if (!status.includes(' 200 ')) {
          socket.destroy();
          resolve({ status });
          return;
        }
        socket.write('ping through the tunnel');
      }
      if (buffer.length >= 'ping through the tunnel'.length) {
        socket.destroy();
        resolve({ status, echoed: buffer });
      }
    });
    socket.on('close', () => status === undefined && resolve({ status: 'closed' }));
    socket.write(`CONNECT ${target} HTTP/1.1\r\nHost: ${target}\r\n\r\n`);
  });
}

describe('the egress proxy (#273)', () => {
  it('tunnels an allowed host on 443 to the address it checked', async () => {
    const url = await start(['registry.npmjs.org']);
    expect(await tunnel(url, 'registry.npmjs.org:443')).toEqual({ status: 'HTTP/1.1 200 Connection Established', echoed: 'ping through the tunnel' });
    expect(lookups).toEqual(['registry.npmjs.org']);
    expect(opened).toEqual([`${PUBLIC}:443`]);
    expect(logged).toEqual([]);
  });

  it('refuses a host not on the allowlist with 403, one log line, and no lookup', async () => {
    const url = await start(['registry.npmjs.org', '*.example.org']);
    for (const host of ['evil.example', 'example.org', 'registry.npmjs.org.evil.example', '169.254.169.254']) {
      expect((await tunnel(url, `${host}:443`)).status, host).toBe('HTTP/1.1 403 Forbidden');
    }
    expect((await tunnel(url, 'cdn.example.org:443')).status).toBe('HTTP/1.1 200 Connection Established');
    expect(lookups).toEqual(['cdn.example.org']);
    expect(logged).toEqual([
      'refused evil.example: not on the allowlist',
      'refused example.org: not on the allowlist',
      'refused registry.npmjs.org.evil.example: not on the allowlist',
      'refused 169.254.169.254: not on the allowlist',
    ]);
  });

  it('refuses any port but 443, and plain HTTP', async () => {
    const url = await start(['registry.npmjs.org']);
    expect((await tunnel(url, 'registry.npmjs.org:80')).status).toBe('HTTP/1.1 403 Forbidden');
    expect((await tunnel(url, 'registry.npmjs.org:22')).status).toBe('HTTP/1.1 403 Forbidden');
    const plain = await new Promise<number>((resolve, reject) => {
      const s = tcpConnect({ host: '127.0.0.1', port: Number(new URL(url).port) });
      s.on('error', reject);
      s.on('data', (c: Buffer) => {
        resolve(Number(/^HTTP\/1\.1 (\d+)/.exec(c.toString('utf8'))?.[1]));
        s.destroy();
      });
      s.write('GET http://registry.npmjs.org/left-pad HTTP/1.1\r\nHost: registry.npmjs.org\r\n\r\n');
    });
    expect(plain).toBe(403);
    expect(opened).toEqual([]);
    expect(logged).toEqual([
      'refused registry.npmjs.org:80: only port 443',
      'refused registry.npmjs.org:22: only port 443',
      'refused registry.npmjs.org: plain HTTP is not proxied',
    ]);
  });

  it('refuses an allowed name that resolves to a loopback, link-local, private, shared, or mapped address, even among public ones', async () => {
    const answers: Record<string, string[]> = {
      'meta.example.org': ['169.254.169.254'],
      'loop.example.org': ['127.0.0.1'],
      'ten.example.org': ['10.1.2.3'],
      'lan.example.org': ['192.168.1.20'],
      'docker.example.org': ['172.17.0.1'],
      'cgnat.example.org': ['100.64.0.9'],
      'ula.example.org': ['fd00:ec2::254'],
      'v6loop.example.org': ['::1'],
      'mapped.example.org': ['::ffff:127.0.0.1'],
      'mixed.example.org': [PUBLIC, '10.0.0.1'],
    };
    const url = await start(['*.example.org'], answers);
    for (const host of Object.keys(answers)) expect((await tunnel(url, `${host}:443`)).status, host).toBe('HTTP/1.1 403 Forbidden');
    expect(opened).toEqual([]);
    expect(logged).toHaveLength(Object.keys(answers).length);
    expect(logged[0]).toBe('refused meta.example.org: resolves to a link-local (metadata) address');
  });

  it('resolves once and connects to that answer, so a second answer cannot redirect the tunnel', async () => {
    let calls = 0;
    const url = await start(['registry.npmjs.org'], {}, {
      lookup: async () => (calls++ === 0 ? [{ address: PUBLIC, family: 4 }] : [{ address: '169.254.169.254', family: 4 }]),
    });
    expect((await tunnel(url, 'registry.npmjs.org:443')).status).toBe('HTTP/1.1 200 Connection Established');
    expect(calls).toBe(1);
    expect(opened).toEqual([`${PUBLIC}:443`]);
  });

  it('checks what the system resolver answers too', async () => {
    const url = await start(['localhost'], 'system');
    expect((await tunnel(url, 'localhost:443')).status).toBe('HTTP/1.1 403 Forbidden');
    expect(logged[0]).toMatch(/^refused localhost: resolves to a loopback address$/);
    expect(opened).toEqual([]);
  });

  it('with an empty allowlist refuses everything', async () => {
    const url = await start([]);
    expect((await tunnel(url, 'registry.npmjs.org:443')).status).toBe('HTTP/1.1 403 Forbidden');
    expect(lookups).toEqual([]);
  });
});

describe('the allowlist (#273)', () => {
  it('defaults to the package registries, is replaced by SNAPWING_FIXER_EGRESS_ALLOW, and `none` turns egress off', () => {
    expect(parseEgressAllow(undefined)).toEqual(DEFAULT_FIXER_EGRESS_ALLOW);
    expect(parseEgressAllow('  ')).toEqual(DEFAULT_FIXER_EGRESS_ALLOW);
    expect(DEFAULT_FIXER_EGRESS_ALLOW).toEqual(expect.arrayContaining(['registry.npmjs.org', 'pypi.org', 'files.pythonhosted.org', 'proxy.golang.org', 'index.crates.io', 'repo1.maven.org', 'api.nuget.org']));
    expect(parseEgressAllow('none')).toEqual([]);
    expect(parseEgressAllow(' NONE ')).toEqual([]);
    expect(parseEgressAllow('npm.internal.example, *.Mirror.example ,npm.internal.example')).toEqual(['npm.internal.example', '*.mirror.example']);
    for (const bad of ['*', '*.com', 'not a host', 'http://registry.npmjs.org', 'registry.npmjs.org:443', 'localhost']) {
      expect(() => parseEgressAllow(bad), bad).toThrow(/SNAPWING_FIXER_EGRESS_ALLOW/);
    }
  });

  it('matches exact names and names under a *. entry, never the bare suffix', () => {
    expect(hostAllowed('Registry.NPMJS.org.', ['registry.npmjs.org'])).toBe(true);
    expect(hostAllowed('a.b.example.org', ['*.example.org'])).toBe(true);
    expect(hostAllowed('example.org', ['*.example.org'])).toBe(false);
    expect(hostAllowed('badexample.org', ['*.example.org'])).toBe(false);
    expect(blockedAddress('151.101.0.162', 4)).toBeUndefined();
    expect(blockedAddress('2606:4700::6810:1', 6)).toBeUndefined();
    expect(blockedAddress('169.254.169.254', 4)).toBe('link-local (metadata)');
  });
});
