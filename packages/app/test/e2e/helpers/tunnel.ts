// A Cloudflare quick tunnel for the e2e run (`cloudflared tunnel --url http://localhost:<port>`): no
// account, a new `https://<words>.trycloudflare.com` URL per run. Jira and GitHub deliver webhooks to
// it; Slack needs none (Socket Mode). `stop` kills the process; the URL dies with it.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { createServer } from 'node:net';

export interface Tunnel {
  url: string;
  stop(): Promise<void>;
}

const URL_PATTERN = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/;

/** True when `cloudflared` runs. */
export function hasCloudflared(): boolean {
  const r = spawnSync('cloudflared', ['--version'], { stdio: 'ignore' });
  return r.status === 0;
}

/** A free local TCP port (bound and released). */
export async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const s = createServer();
    s.once('error', reject);
    s.listen(0, '127.0.0.1', () => {
      const address = s.address();
      const port = typeof address === 'object' && address !== null ? address.port : 0;
      s.close(() => resolve(port));
    });
  });
}

function stopProcess(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    const kill = setTimeout(() => child.kill('SIGKILL'), 5_000);
    child.once('exit', () => {
      clearTimeout(kill);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

/**
 * Starts the tunnel to `port` and resolves with its URL once cloudflared prints it. Nothing needs to
 * listen on `port` yet; `waitReachable` checks the path end to end once the server is up.
 */
export async function startTunnel(port: number, timeoutMs = 120_000): Promise<Tunnel> {
  const child = spawn('cloudflared', ['tunnel', '--no-autoupdate', '--url', `http://127.0.0.1:${port}`], { stdio: ['ignore', 'pipe', 'pipe'] });
  const tail: string[] = [];
  try {
    const url = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`cloudflared printed no tunnel URL in time: ${tail.slice(-5).join(' | ')}`)), timeoutMs);
      const onData = (chunk: Buffer): void => {
        const text = chunk.toString();
        tail.push(...text.split('\n').filter((l) => l.trim() !== ''));
        const m = URL_PATTERN.exec(text);
        if (m !== null) {
          clearTimeout(timer);
          resolve(m[0]);
        }
      };
      child.stdout?.on('data', onData);
      child.stderr?.on('data', onData);
      child.once('exit', (code) => {
        clearTimeout(timer);
        reject(new Error(`cloudflared exited (${String(code)}): ${tail.slice(-5).join(' | ')}`));
      });
    });
    return { url, stop: () => stopProcess(child) };
  } catch (e) {
    await stopProcess(child);
    throw e;
  }
}

/** Resolves once `<url>/healthz` answers 200 through the tunnel (a fresh quick tunnel's DNS can lag). */
export async function waitReachable(url: string, timeoutMs = 120_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  let last = '';
  while (Date.now() < deadline) {
    try {
      const res = await fetch(`${url}/healthz`, { signal: AbortSignal.timeout(10_000) });
      if (res.status === 200) return;
      last = `HTTP ${res.status}`;
    } catch (e) {
      last = e instanceof Error ? e.message : String(e);
    }
    await new Promise((r) => setTimeout(r, 2_000));
  }
  throw new Error(`the tunnel never reached the server (${last})`);
}
