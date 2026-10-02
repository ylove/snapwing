// Docker RunnerPort (#135; main 14.3, main 10.2). A fake `docker` script on PATH records its argv and
// the SNAPWING_ and other environment it was given; no real docker ever runs.

import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { FixerJob } from '@snapwing/pipeline/ports/runner.ts';
import { issueFixerToken, verifyFixerToken } from '../../src/fixer-api/token.ts';
import { containerName, createDockerRunner } from '../../src/providers/docker/runner.ts';

const SECRET = 'fake-hmac-key-for-tests-0123456789abcdef';
const clock = () => new Date('2026-10-02T12:00:00Z');
const keys = { secret: SECRET, clock };
const RUN_ID = '01J9ZRUNID0000000000000001';

const FAKE_DOCKER = `#!/bin/sh
dir=$(dirname "$0")
{ echo "---"; for a in "$@"; do echo "arg:$a"; done; env | sort | sed 's/^/env:/'; } >> "$dir/calls.log"
mode=$(cat "$dir/mode" 2>/dev/null)
case "$1" in
  run) [ "$mode" = run-fail ] && { echo "Unable to find image 'nope' locally" >&2; exit 125; } ;;
  stop) [ "$mode" = gone ] && { echo "Error response from daemon: No such container: $4" >&2; exit 1; }
        [ "$mode" = stop-fail ] && { echo "daemon exploded" >&2; exit 1; } ;;
esac
exit 0
`;

interface Call {
  args: string[];
  env: Record<string, string>;
}

let dir: string;
let savedPath: string | undefined;
let savedLeak: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER);
  chmodSync(join(dir, 'docker'), 0o755);
  savedPath = process.env['PATH'];
  savedLeak = process.env['SNAPWING_FIXER_TOKEN_SECRET'];
  process.env['PATH'] = `${dir}:${savedPath ?? ''}`;
  process.env['SNAPWING_FIXER_TOKEN_SECRET'] = 'server-only-secret-must-not-leak';
});

afterEach(() => {
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  if (savedLeak === undefined) delete process.env['SNAPWING_FIXER_TOKEN_SECRET'];
  else process.env['SNAPWING_FIXER_TOKEN_SECRET'] = savedLeak;
  rmSync(dir, { recursive: true, force: true });
});

function calls(): Call[] {
  const file = join(dir, 'calls.log');
  if (!existsSync(file)) return [];
  return readFileSync(file, 'utf8')
    .split('---\n')
    .filter((s) => s !== '')
    .map((block) => {
      const call: Call = { args: [], env: {} };
      for (const line of block.split('\n')) {
        if (line.startsWith('arg:')) call.args.push(line.slice(4));
        else if (line.startsWith('env:')) {
          const eq = line.indexOf('=');
          call.env[line.slice(4, eq)] = line.slice(eq + 1);
        }
      }
      return call;
    });
}

function job(over: Partial<FixerJob> = {}): FixerJob {
  return {
    runId: RUN_ID,
    workItem: { id: 'WI01', issueKey: 'WEB-1042', repo: 'acme/web' },
    implementationRequestArtifactId: 'ART01',
    harness: { adapter: 'claude-code' },
    budget: { wallClock: 'PT30M', attempts: 2 },
    ...over,
  };
}

function runner(over: Partial<Parameters<typeof createDockerRunner>[0]> = {}) {
  return createDockerRunner({
    image: 'snapwing-fixer:test',
    workdirRoot: join(dir, 'scratch'),
    env: {
      apiUrl: 'http://snapwing-api:8080',
      token: (j) => issueFixerToken({ workItemId: j.workItem.id, incidentId: 'INC01', ttl: 'PT45M' }, keys),
    },
    ...over,
  });
}

describe('createDockerRunner runFixer', () => {
  it('runs docker run --rm -d with a derived name, limits, one scratch mount, and no other mounts', async () => {
    const r = await runner({ network: 'snapwing-net', memory: '2g', cpus: '1.5' }).runFixer(job());
    expect(r).toEqual({ runId: RUN_ID });
    const [c] = calls();
    expect(c).toBeDefined();
    const a = c!.args;
    expect(a.slice(0, 3)).toEqual(['run', '--rm', '-d']);
    expect(a[a.indexOf('--name') + 1]).toBe(`snapwing-fixer-${RUN_ID}`);
    expect(a[a.indexOf('--memory') + 1]).toBe('2g');
    expect(a[a.indexOf('--cpus') + 1]).toBe('1.5');
    expect(a[a.indexOf('--network') + 1]).toBe('snapwing-net');
    expect(a).toContain('--cap-drop');
    expect(a.at(-1)).toBe('snapwing-fixer:test');
    const mounts = a.flatMap((x, i) => (x === '-v' || x === '--volume' || x === '--mount' ? [a[i + 1]] : []));
    expect(mounts).toEqual([`${join(dir, 'scratch', RUN_ID)}:/work`]);
    expect(statSync(join(dir, 'scratch', RUN_ID)).isDirectory()).toBe(true);
    expect(a).not.toContain('--privileged');
  });

  it('omits --network when none is configured', async () => {
    await runner().runFixer(job());
    expect(calls()[0]!.args).not.toContain('--network');
  });

  it('passes the job, API URL, and only the scoped token as env, by name, never in argv', async () => {
    await runner().runFixer(job({ harness: { adapter: 'generic', templateId: 'aider' }, implementationRequestVersion: 3 }));
    const c = calls()[0]!;
    const token = c.env['SNAPWING_FIXER_TOKEN'];
    expect(token).toBeDefined();
    expect(verifyFixerToken(token!, 'WI01', keys)).toMatchObject({ ok: true, claims: { workItemId: 'WI01', incidentId: 'INC01' } });
    expect(c.env['SNAPWING_API_URL']).toBe('http://snapwing-api:8080');
    expect(c.env['SNAPWING_RUN_ID']).toBe(RUN_ID);
    expect(c.env['SNAPWING_ISSUE_KEY']).toBe('WEB-1042');
    expect(c.env['SNAPWING_REPO']).toBe('acme/web');
    expect(c.env['SNAPWING_BUDGET_WALL_CLOCK']).toBe('PT30M');
    expect(c.env['SNAPWING_BUDGET_ATTEMPTS']).toBe('2');
    expect(c.env['SNAPWING_HARNESS']).toBe('generic');
    expect(c.env['SNAPWING_HARNESS_TEMPLATE']).toBe('aider');
    expect(c.env['SNAPWING_IMPLEMENTATION_REQUEST_VERSION']).toBe('3');

    // Each SNAPWING_ variable the CLI got is forwarded by name only.
    const forwarded = c.args.flatMap((x, i) => (x === '-e' ? [c.args[i + 1]!] : []));
    expect(forwarded.every((n) => /^[A-Z_]+$/.test(n))).toBe(true);
    expect(forwarded).toContain('SNAPWING_FIXER_TOKEN');
    expect(c.args.join(' ')).not.toContain(token!);
    expect(c.args.join(' ')).not.toContain('swf1.');

    // The server's own secret and the rest of its environment do not reach docker.
    expect(c.env['SNAPWING_FIXER_TOKEN_SECRET']).toBeUndefined();
    expect(JSON.stringify(c.env)).not.toContain('server-only-secret');
    const snapwing = Object.keys(c.env).filter((k) => k.startsWith('SNAPWING_'));
    expect(snapwing.sort()).toEqual([...forwarded].sort());
  });

  it('omits the review ref and template on a plain first run', async () => {
    await runner().runFixer(job());
    const env = calls()[0]!.env;
    expect(env['SNAPWING_REVIEW_ARTIFACT']).toBeUndefined();
    expect(env['SNAPWING_HARNESS_TEMPLATE']).toBeUndefined();
    expect(env['SNAPWING_IMPLEMENTATION_REQUEST_VERSION']).toBeUndefined();
  });

  it('rejects, calling docker never, for a run id that is not a plain segment', async () => {
    for (const bad of ['', '../x', 'a/b', 'a b', '-x']) {
      await expect(runner().runFixer(job({ runId: bad }))).rejects.toThrow(/plain path segment/);
    }
    expect(calls()).toEqual([]);
  });

  it('rejects with the first line of docker stderr when docker run fails', async () => {
    writeFileSync(join(dir, 'mode'), 'run-fail');
    await expect(runner().runFixer(job())).rejects.toThrow(/docker run failed \(exit 125\): Unable to find image/);
  });

  it('rejects when the docker binary is missing', async () => {
    await expect(runner({ docker: join(dir, 'no-such-docker') }).runFixer(job())).rejects.toThrow();
  });
});

describe('createDockerRunner cancel', () => {
  it('stops the container by name with the grace period (SIGTERM, then kill)', async () => {
    await runner({ killGrace: 'PT7S' }).cancel(RUN_ID);
    const all = calls();
    expect(all).toHaveLength(1);
    expect(all[0]!.args).toEqual(['stop', '-t', '7', containerName(RUN_ID)]);
  });

  it('defaults the grace to 10 seconds', async () => {
    await runner().cancel(RUN_ID);
    expect(calls()[0]!.args).toEqual(['stop', '-t', '10', `snapwing-fixer-${RUN_ID}`]);
  });

  it('is a no-op for a container that is already gone', async () => {
    writeFileSync(join(dir, 'mode'), 'gone');
    await expect(runner().cancel(RUN_ID)).resolves.toBeUndefined();
  });

  it('surfaces any other docker stop failure', async () => {
    writeFileSync(join(dir, 'mode'), 'stop-fail');
    await expect(runner().cancel(RUN_ID)).rejects.toThrow(/daemon exploded/);
  });

  it('runs then cancels in order, with no token on the stop call', async () => {
    const r = runner();
    const { runId } = await r.runFixer(job());
    await r.cancel(runId);
    const all = calls();
    expect(all.map((c) => c.args[0])).toEqual(['run', 'stop']);
    expect(all[1]!.env['SNAPWING_FIXER_TOKEN']).toBeUndefined();
  });

  it('rejects an invalid run id without calling docker', async () => {
    await expect(runner().cancel('../x')).rejects.toThrow(/plain path segment/);
    expect(calls()).toEqual([]);
  });
});
