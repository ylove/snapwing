// Docker RunnerPort (#135, #234, #239, #256; main 14.3, main 10.2, ADR 0017). A fake `docker` script
// records its argv and the SNAPWING_ and other environment it was given, and copies a fixer's mount
// as it was at `docker run`; no real docker ever runs. Fixer checkouts clone a local bare repository.

import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, utimesSync, writeFileSync, existsSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Artifact } from '@snapwing/pipeline/contracts/state.ts';
import type { FixerJob, ReviewRunJob, TestRunJob } from '@snapwing/pipeline/ports/runner.ts';
import { buildImplementationRequest } from '@snapwing/pipeline/prompts/implementation-request.ts';
import { createBareRepo, git, type BareRepo } from '../../../pipeline/test/helpers/git.ts';
import { FIXER_HOOKS_PATH, FIXER_REQUEST_PATH } from '../../../../infra/docker/fixer/wrapper.ts';
import { issueFixerToken, verifyFixerToken } from '../../src/fixer-api/token.ts';
import { issueModelToken, verifyModelToken } from '../../src/model-proxy/token.ts';
import { containerName, createDockerRunner, FIXER_REQUEST_FILE, type DockerModelProxy, type DockerRunner } from '../../src/providers/docker/runner.ts';

const SECRET = 'fake-hmac-key-for-tests-0123456789abcdef';
const clock = () => new Date('2026-10-02T12:00:00Z');
const keys = { secret: SECRET, clock };
const RUN_ID = '01J9ZRUNID0000000000000001';
const GIT_TOKEN = 'test-git-token-not-real';

const FAKE_DOCKER = `#!/bin/sh
dir=$(dirname "$0")
# A kill comes from the runner's timer while the attached run may still be starting (slow under load):
# wait, bounded, until the run has logged itself, so the two log blocks never interleave or swap.
if [ "$1" = kill ]; then n=0; while [ ! -f "$dir/run-logged" ] && [ $n -lt 400 ]; do sleep 0.05; n=$((n+1)); done; fi
# Built in a file and appended with one write, so concurrent calls (a background wait) never interleave.
tmp=$(mktemp "$dir/call.XXXXXX")
{ echo "---"; for a in "$@"; do echo "arg:$a"; done; env | sort | sed 's/^/env:/'; } > "$tmp"
cat "$tmp" >> "$dir/calls.log"; rm -f "$tmp"
[ "$1" = run ] && : > "$dir/run-logged"
mode=$(cat "$dir/mode" 2>/dev/null)
case "$1" in
  wait) n=0
        while [ "$(cat "$dir/waitmode" 2>/dev/null)" = running ] && [ $n -lt 200 ]; do sleep 0.05; n=$((n+1)); done
        [ "$(cat "$dir/waitmode" 2>/dev/null)" = gone ] && { echo "Error response from daemon: No such container: $2" >&2; exit 1; }
        echo 0; exit 0 ;;
  run) [ "$mode" = run-fail ] && { echo "Unable to find image 'nope' locally" >&2; exit 125; }
       case " $* " in *" --name snapwing-fixer-"*)
         for a in "$@"; do case "$a" in *:/work) cp -R "\${a%:/work}" "$dir/snapshot" ;; esac; done ;;
       esac
       case " $* " in *" --name snapwing-review-"*)
         [ "$mode" = hang ] && exec sleep 30
         echo "review agent ran"
         exit "$(cat "$dir/exit" 2>/dev/null || echo 0)" ;;
       esac
       case " $* " in *" --entrypoint "*)
         [ "$mode" = hang ] && exec sleep 30
         echo "tests said hello"; echo "and warned on stderr" >&2
         exit "$(cat "$dir/exit" 2>/dev/null || echo 0)" ;;
       esac ;;
  ps) [ "$mode" = ps-fail ] && { echo "Cannot connect to the Docker daemon" >&2; exit 1; }
      cat "$dir/containers" 2>/dev/null; exit 0 ;;
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
let savedProviderKey: string | undefined;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fake-docker-'));
  writeFileSync(join(dir, 'docker'), FAKE_DOCKER);
  chmodSync(join(dir, 'docker'), 0o755);
  savedPath = process.env['PATH'];
  savedLeak = process.env['SNAPWING_FIXER_TOKEN_SECRET'];
  process.env['PATH'] = `${dir}:${savedPath ?? ''}`;
  process.env['SNAPWING_FIXER_TOKEN_SECRET'] = 'server-only-secret-must-not-leak';
  savedProviderKey = process.env['ANTHROPIC_API_KEY'];
  process.env['ANTHROPIC_API_KEY'] = 'server-provider-key-must-not-leak';
});

afterEach(async () => {
  // Let every fixer container "end" so no background `docker wait` outlives the fake.
  writeFileSync(join(dir, 'waitmode'), '');
  await Promise.all(started.splice(0).map(({ r, runId }) => r.wait(runId)));
  if (savedPath === undefined) delete process.env['PATH'];
  else process.env['PATH'] = savedPath;
  if (savedLeak === undefined) delete process.env['SNAPWING_FIXER_TOKEN_SECRET'];
  else process.env['SNAPWING_FIXER_TOKEN_SECRET'] = savedLeak;
  if (savedProviderKey === undefined) delete process.env['ANTHROPIC_API_KEY'];
  else process.env['ANTHROPIC_API_KEY'] = savedProviderKey;
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

const REQUEST_BODY = buildImplementationRequest({
  issue: 'WEB-1042',
  intent: 'fix the cart total',
  evidence: [{ kind: 'report', source: 'slack', text: 'the cart total is wrong' }],
  constraints: { scope: 'cart only', tests: { required: true, text: 'add a test' }, forbidden: [] },
  handoff: { mode: 'review', autonomy: 2, branch: 'fix/WEB-1042-cart', base: 'main' },
});
const REVIEW_BODY = '{"verdict":"request-changes","reasons":["the test does not fail without the fix"]}';

function artifact(id: string, kind: Artifact['kind'], body: string): Artifact {
  return {
    id,
    version: 1,
    workspaceId: 'WS01',
    incidentId: 'INC01',
    kind,
    contentType: kind === 'implementation-request' ? 'application/xml' : 'application/json',
    sha256: '0'.repeat(64),
    body,
    createdBy: 'test',
    createdAt: '2026-10-02T09:00:00.000Z',
  };
}

const ARTIFACTS: Record<string, Artifact> = {
  ART01: artifact('ART01', 'implementation-request', REQUEST_BODY),
  REV01: artifact('REV01', 'review', REVIEW_BODY),
  DIAG01: artifact('DIAG01', 'diagnosis', '{}'),
};
const artifactStore = {
  async getArtifact(id: string): Promise<Artifact> {
    const a = ARTIFACTS[id];
    if (a === undefined) throw new Error(`no artifact ${id}`);
    return a;
  },
};

let origin: BareRepo;
beforeAll(async () => {
  origin = await createBareRepo({ files: { 'cart.ts': 'export const total = 1;\n' } });
});
afterAll(async () => {
  await origin.remove();
});

/** Fixer runs a test started, so `afterEach` can wait for their background cleanup. */
const started: { r: DockerRunner; runId: string }[] = [];

function runner(over: Partial<Parameters<typeof createDockerRunner>[0]> = {}): DockerRunner {
  const r = createDockerRunner({
    image: 'snapwing-fixer:test',
    docker: join(dir, 'docker'),
    workdirRoot: join(dir, 'scratch'),
    env: {
      apiUrl: 'http://snapwing-api:8080',
      token: (j) => issueFixerToken({ workItemId: j.workItem.id, incidentId: 'INC01', ttl: 'PT45M' }, keys),
    },
    artifacts: artifactStore,
    git: { token: async () => GIT_TOKEN, remoteUrl: () => origin.url },
    ...over,
  });
  const runFixer = r.runFixer.bind(r);
  r.runFixer = async (j) => {
    const out = await runFixer(j);
    started.push({ r, runId: out.runId });
    return out;
  };
  return r;
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
    expect(a).not.toContain('--privileged');
    // As the server's uid:gid, so it can write the host-prepared checkout and the server can remove it.
    expect(a[a.indexOf('--user') + 1]).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
    const forwarded = a.flatMap((x, i) => (x === '-e' ? [a[i + 1]!] : []));
    expect(forwarded.slice(-2)).toEqual(['HOME=/tmp', 'TMPDIR=/tmp']);
  });

  it('prepares the work item in the mount before docker run: a checkout on the work branch, the request, the hooks', async () => {
    await runner().runFixer(job());
    const snap = join(dir, 'snapshot');
    expect(statSync(join(snap, '.git')).isDirectory()).toBe(true);
    expect(git(snap, ['rev-parse', '--abbrev-ref', 'HEAD'])).toBe('fix/WEB-1042-cart');
    expect(readFileSync(join(snap, 'cart.ts'), 'utf8')).toBe('export const total = 1;\n');
    // Where the image's wrapper looks for them.
    expect(FIXER_REQUEST_FILE).toBe(FIXER_REQUEST_PATH);
    expect(readFileSync(join(snap, FIXER_REQUEST_PATH), 'utf8')).toBe(REQUEST_BODY);
    for (const hook of ['commit-msg', 'pre-push']) expect(statSync(join(snap, FIXER_HOOKS_PATH, hook)).mode & 0o111).not.toBe(0);
    expect(git(snap, ['config', 'user.name'])).toBe('snapwing[bot]');
    expect(existsSync(join(snap, '.git/snapwing/review.json'))).toBe(false);
    expect(calls()[0]!.env['SNAPWING_PRIOR_REVIEW_FILE']).toBeUndefined();
  });

  it('uses the git token for the host clone only: none enters the container, its argv, a file, or the remote URL (#266)', async () => {
    let minted = 0;
    await runner({ git: { token: async () => (minted++, GIT_TOKEN), remoteUrl: () => origin.url } }).runFixer(job());
    expect(minted).toBe(1);
    const c = calls()[0]!;
    // The container fetches fresh tokens through the fixer API instead (the image's credential helper).
    expect(c.env['SNAPWING_GIT_TOKEN']).toBeUndefined();
    expect(JSON.stringify(c.env)).not.toContain(GIT_TOKEN);
    const forwarded = c.args.flatMap((x, i) => (x === '-e' ? [c.args[i + 1]!] : []));
    expect(forwarded).not.toContain('SNAPWING_GIT_TOKEN');
    expect(c.args.join(' ')).not.toContain(GIT_TOKEN);
    const snap = join(dir, 'snapshot');
    expect(git(snap, ['config', 'remote.origin.url'])).toBe(origin.url);
    const files = (root: string): string[] =>
      readdirSync(root, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? files(join(root, e.name)) : e.isFile() ? [join(root, e.name)] : []));
    const holding = files(snap).filter((f) => readFileSync(f).includes(GIT_TOKEN));
    expect(holding).toEqual([]);
  });

  it('on a retry writes the review into the mount and names it under /work', async () => {
    await runner().runFixer(job({ review: { artifactId: 'REV01', version: 1 } }));
    const env = calls()[0]!.env;
    expect(env['SNAPWING_PRIOR_REVIEW_FILE']).toBe('/work/.git/snapwing/review.json');
    expect(readFileSync(join(dir, 'snapshot', '.git/snapwing/review.json'), 'utf8')).toBe(REVIEW_BODY);
  });

  it('removes the scratch directory once the container has ended, not before', async () => {
    writeFileSync(join(dir, 'waitmode'), 'running');
    const r = runner();
    await r.runFixer(job());
    const scratch = join(dir, 'scratch', RUN_ID);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(statSync(scratch).isDirectory()).toBe(true);
    writeFileSync(join(dir, 'waitmode'), '');
    await r.wait(RUN_ID);
    expect(existsSync(scratch)).toBe(false);
    expect(calls().map((c) => c.args.slice(0, 2))).toEqual([
      ['run', '--rm'],
      ['wait', `snapwing-fixer-${RUN_ID}`],
    ]);
  });

  it('removes it too when --rm took the container before docker wait saw it', async () => {
    writeFileSync(join(dir, 'waitmode'), 'gone');
    const r = runner();
    await r.runFixer(job());
    await r.wait(RUN_ID);
    expect(existsSync(join(dir, 'scratch', RUN_ID))).toBe(false);
  });

  it('rejects, calling docker never and leaving no directory, when the work item cannot be prepared', async () => {
    const scratch = join(dir, 'scratch', RUN_ID);
    await expect(runner().runFixer(job({ implementationRequestArtifactId: 'DIAG01' }))).rejects.toThrow(/not an implementation-request/);
    await expect(runner().runFixer(job({ implementationRequestArtifactId: 'NOPE' }))).rejects.toThrow(/no artifact NOPE/);
    await expect(runner().runFixer(job({ review: { artifactId: 'ART01', version: 1 } }))).rejects.toThrow(/not a review/);
    await expect(runner({ git: { token: async () => GIT_TOKEN, remoteUrl: () => join(dir, 'no-such-repo.git') } }).runFixer(job())).rejects.toThrow(/^workdir: /);
    await expect(runner({ git: { token: () => Promise.reject(new Error('installation token refused')) } }).runFixer(job())).rejects.toThrow(/installation token refused/);
    await expect(runner({ artifacts: undefined as never }).runFixer(job())).rejects.toThrow(/needs `artifacts` and `git`/);
    expect(existsSync(scratch)).toBe(false);
    expect(calls()).toEqual([]);
  });

  it('never reuses or removes a directory an earlier run of the id left', async () => {
    const scratch = join(dir, 'scratch', RUN_ID);
    mkdirSync(scratch, { recursive: true });
    writeFileSync(join(scratch, 'left.txt'), 'x');
    await expect(runner().runFixer(job())).rejects.toThrow(/EEXIST/);
    expect(readFileSync(join(scratch, 'left.txt'), 'utf8')).toBe('x');
    expect(calls()).toEqual([]);
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
    const forwarded = c.args.flatMap((x, i) => (x === '-e' ? [c.args[i + 1]!] : [])).filter((n) => n !== 'HOME=/tmp' && n !== 'TMPDIR=/tmp');
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
    const all = calls().filter((c) => c.args[0] !== 'wait');
    expect(all.map((c) => c.args[0])).toEqual(['run', 'stop']);
    expect(all[1]!.env['SNAPWING_FIXER_TOKEN']).toBeUndefined();
  });

  it('rejects an invalid run id without calling docker', async () => {
    await expect(runner().cancel('../x')).rejects.toThrow(/plain path segment/);
    expect(calls()).toEqual([]);
  });
});

describe('createDockerRunner sweep (#266)', () => {
  const MIN = 60_000;
  // A fake clock well past the real one: every directory's real mtime is old unless set.
  const NOW = Date.now() + 6 * 60 * MIN;
  const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const runIdAt = (ms: number, tail: string): string => {
    let t = ms;
    let time = '';
    for (let i = 0; i < 10; i++) {
      time = CROCKFORD.charAt(t % 32) + time;
      t = Math.floor(t / 32);
    }
    return time + tail;
  };
  const root = (): string => join(dir, 'scratch');
  const makeDir = (name: string, mtime: number): string => {
    const path = join(root(), name);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'file.txt'), 'checkout, no token');
    utimesSync(path, new Date(mtime), new Date(mtime));
    return name;
  };

  it('removes stale directories with no container and no run; keeps one with a container in any state, a young one, and a live run', async () => {
    const r = runner({ clock: () => new Date(NOW) });
    // A run of this runner whose container docker has not been seen to end.
    writeFileSync(join(dir, 'waitmode'), 'running');
    const live = runIdAt(NOW - 3 * 60 * MIN, 'TESTSWEEPLIVE000');
    await r.runFixer(job({ runId: live }));
    utimesSync(join(root(), live), new Date(NOW - 3 * 60 * MIN), new Date(NOW - 3 * 60 * MIN));

    const stale = makeDir(runIdAt(NOW - 2 * 60 * MIN, 'TESTSWEEPSTALE00'), NOW - 2 * 60 * MIN);
    const exited = makeDir(runIdAt(NOW - 2 * 60 * MIN, 'TESTSWEEPEXITED0'), NOW - 2 * 60 * MIN);
    const young = makeDir(runIdAt(NOW - 20 * MIN, 'TESTSWEEPYOUNG00'), NOW - 20 * MIN);
    writeFileSync(join(dir, 'containers'), `snapwing-fixer-${exited}\nsnapwing-fixer-other\nunrelated\n`);

    const swept = await r.sweep({ maxWallClock: 'PT30M' });

    expect(swept).toEqual({ removed: [stale], kept: [exited, live, young].sort() });
    expect(existsSync(join(root(), stale))).toBe(false);
    for (const name of [exited, live, young]) expect(statSync(join(root(), name)).isDirectory()).toBe(true);
  });

  it('removes nothing when docker cannot list its containers, and says why', async () => {
    const stale = makeDir(runIdAt(NOW - 2 * 60 * MIN, 'TESTSWEEPSTALE00'), NOW - 2 * 60 * MIN);
    writeFileSync(join(dir, 'mode'), 'ps-fail');
    const swept = await runner({ clock: () => new Date(NOW) }).sweep({ maxWallClock: 'PT30M' });
    expect(swept).toEqual({ removed: [], kept: [], skipped: 'docker ps failed (exit 1): Cannot connect to the Docker daemon' });
    expect(existsSync(join(root(), stale))).toBe(true);
  });

  it('ages by the later of the run id time and the mtime, against the wall clock plus the margin', async () => {
    const recentlyTouched = makeDir(runIdAt(NOW - 3 * 60 * MIN, 'TESTSWEEPTOUCHED'), NOW - 40 * MIN);
    const pastCutoff = makeDir(runIdAt(NOW - 46 * MIN, 'TESTSWEEPCUTOFF0'), NOW - 46 * MIN);
    const r = runner({ clock: () => new Date(NOW) });
    expect(await r.sweep({ maxWallClock: 'PT30M' })).toEqual({ removed: [pastCutoff], kept: [recentlyTouched] });
    expect(await r.sweep({ maxWallClock: 'PT1H' })).toEqual({ removed: [], kept: [recentlyTouched] });
    // Only here, with no fixer run in flight, is the fake's log free of a concurrent `docker wait`.
    const ps = calls().filter((c) => c.args[0] === 'ps');
    expect(ps.map((c) => c.args)).toEqual(Array(2).fill(['ps', '-a', '--filter', 'name=snapwing-fixer-', '--format', '{{.Names}}']));
    expect(Object.keys(ps[0]!.env).filter((k) => k.startsWith('SNAPWING_'))).toEqual([]);
  });
});

describe('createDockerRunner runTests (#234, ADR 0017)', () => {
  const TEST_RUN = '01J9ZTESTRUN00000000000001';
  const testJob = (over: Partial<TestRunJob> = {}): TestRunJob => ({
    runId: TEST_RUN,
    checkout: join(dir, 'tree'),
    command: 'pnpm test -- cart',
    timeoutMs: 20_000,
    ...over,
  });

  it('runs the command attached in the fixer image, the tree as its only mount, no token, as the server uid', async () => {
    const r = await runner({ network: 'snapwing-net' }).runTests(testJob({ env: { CI: '1' } }));
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.output).toContain('tests said hello');
    expect(r.output).toContain('and warned on stderr');

    const [c] = calls();
    if (c === undefined) throw new Error('docker was not called');
    const a = c.args;
    expect(a.slice(0, 2)).toEqual(['run', '--rm']);
    expect(a).not.toContain('-d');
    expect(a[a.indexOf('--name') + 1]).toBe(`snapwing-tests-${TEST_RUN}`);
    expect(a[a.indexOf('--network') + 1]).toBe('snapwing-net');
    expect(a[a.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(a).not.toContain('--privileged');
    const mounts = a.flatMap((x, i) => (x === '-v' || x === '--volume' || x === '--mount' ? [a[i + 1]] : []));
    expect(mounts).toEqual([`${join(dir, 'tree')}:/work`]);
    expect(a[a.indexOf('-w') + 1]).toBe('/work');
    expect(a[a.indexOf('--user') + 1]).toBe(`${process.getuid?.()}:${process.getgid?.()}`);
    // The image's own entrypoint is replaced by `sh -c <command>`.
    expect(a[a.indexOf('--entrypoint') + 1]).toBe('sh');
    expect(a.slice(-3)).toEqual(['snapwing-fixer:test', '-c', 'pnpm test -- cart']);

    // The caller's env by name; HOME and TMPDIR inside the container are its /tmp.
    const forwarded = a.flatMap((x, i) => (x === '-e' ? [a[i + 1]!] : []));
    expect(forwarded).toEqual(['CI', 'HOME=/tmp', 'TMPDIR=/tmp']);
    expect(c.env['CI']).toBe('1');
    // No token of any kind, and nothing of the server's environment.
    expect(Object.keys(c.env).filter((k) => k.startsWith('SNAPWING_'))).toEqual([]);
    expect(JSON.stringify(c.env)).not.toContain('server-only-secret');
  });

  it('reports the exit code the container ended with', async () => {
    writeFileSync(join(dir, 'exit'), '3');
    await expect(runner().runTests(testJob())).resolves.toMatchObject({ exitCode: 3, timedOut: false });
  });

  it('rejects when docker itself fails (exit 125), so a broken runner never reads as a failing test', async () => {
    writeFileSync(join(dir, 'mode'), 'run-fail');
    await expect(runner().runTests(testJob())).rejects.toThrow(/docker run failed \(exit 125\): Unable to find image/);
  });

  it('kills the container at the timeout and reports timedOut', async () => {
    writeFileSync(join(dir, 'mode'), 'hang');
    const r = await runner().runTests(testJob({ timeoutMs: 300 }));
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(calls().map((c) => c.args.slice(0, 2))).toEqual([
      ['run', '--rm'],
      ['kill', `snapwing-tests-${TEST_RUN}`],
    ]);
  });

  it('honours a configured --user', async () => {
    await runner({ testUser: '1000:1000' }).runTests(testJob());
    const a = calls()[0]!.args;
    expect(a[a.indexOf('--user') + 1]).toBe('1000:1000');
  });

  it('refuses env that would steer the docker CLI or the run, and bad ids, calling docker never', async () => {
    for (const env of [{ PATH: '/elsewhere' }, { HOME: '/root' }, { DOCKER_HOST: 'tcp://elsewhere:2375' }, { TMPDIR: '/x' }, { 'A=B': 'c' }]) {
      await expect(runner().runTests(testJob({ env }))).rejects.toThrow(/test env/);
    }
    await expect(runner().runTests(testJob({ runId: '../x' }))).rejects.toThrow(/plain path segment/);
    await expect(runner().runTests(testJob({ timeoutMs: 0 }))).rejects.toThrow(/invalid test timeout/);
    expect(calls()).toEqual([]);
  });
});

describe('createDockerRunner runReview (#239, ADR 0017)', () => {
  const REVIEW_RUN = '01J9ZREVIEWRUN000000000001';
  const reviewJob = (over: Partial<ReviewRunJob> = {}): ReviewRunJob => ({
    runId: REVIEW_RUN,
    workItem: { id: 'WI01', issueKey: 'WEB-1042', repo: 'acme/web' },
    harness: { adapter: 'claude-code' },
    budget: { wallClock: 'PT30M', attempts: 1 },
    checkout: join(dir, 'review-tree'),
    inputFile: '.git/snapwing/review-input.xml',
    verdictFile: '.git/snapwing/verdict.json',
    ...over,
  });
  const proxy: DockerModelProxy = {
    url: 'http://snapwing-api:8080/model/',
    token: (run) => issueModelToken({ workItemId: run.workItem.id, runId: run.runId, ttl: 'PT45M' }, keys),
  };

  it('runs the image entrypoint attached as role review, the tree as its only mount, no git credential and no fixer token', async () => {
    const r = await runner({ network: 'snapwing-net' }).runReview(reviewJob());
    expect(r).toMatchObject({ exitCode: 0, timedOut: false });
    expect(r.output).toContain('review agent ran');

    const [c] = calls();
    if (c === undefined) throw new Error('docker was not called');
    const a = c.args;
    expect(a.slice(0, 2)).toEqual(['run', '--rm']);
    expect(a).not.toContain('-d');
    expect(a[a.indexOf('--name') + 1]).toBe(`snapwing-review-${REVIEW_RUN}`);
    expect(a[a.indexOf('--network') + 1]).toBe('snapwing-net');
    expect(a[a.indexOf('--cap-drop') + 1]).toBe('ALL');
    expect(a).not.toContain('--privileged');
    // The image's own entrypoint (its wrapper starts the harness).
    expect(a).not.toContain('--entrypoint');
    expect(a.at(-1)).toBe('snapwing-fixer:test');
    const mounts = a.flatMap((x, i) => (x === '-v' || x === '--volume' || x === '--mount' ? [a[i + 1]] : []));
    expect(mounts).toEqual([`${join(dir, 'review-tree')}:/work`]);
    expect(a[a.indexOf('-w') + 1]).toBe('/work');
    expect(a[a.indexOf('--user') + 1]).toBe(`${process.getuid?.()}:${process.getgid?.()}`);

    expect(c.env).toMatchObject({
      SNAPWING_HARNESS_CONTRACT: '1',
      SNAPWING_ROLE: 'review',
      SNAPWING_RUN_ID: REVIEW_RUN,
      SNAPWING_WORK_ITEM_ID: 'WI01',
      SNAPWING_ISSUE_KEY: 'WEB-1042',
      SNAPWING_REPO: 'acme/web',
      SNAPWING_WORKDIR: '/work',
      SNAPWING_BUDGET_WALL_CLOCK: 'PT30M',
      SNAPWING_BUDGET_ATTEMPTS: '1',
      SNAPWING_HARNESS: 'claude-code',
      SNAPWING_REVIEW_INPUT_FILE: '/work/.git/snapwing/review-input.xml',
      SNAPWING_REVIEW_FILE: '/work/.git/snapwing/verdict.json',
    });
    for (const absent of ['SNAPWING_FIXER_TOKEN', 'SNAPWING_API_URL', 'SNAPWING_GIT_TOKEN', 'GIT_ASKPASS', 'SNAPWING_HARNESS_TEMPLATE', 'ANTHROPIC_API_KEY', 'ANTHROPIC_BASE_URL']) {
      expect(c.env[absent]).toBeUndefined();
    }
    const forwarded = a.flatMap((x, i) => (x === '-e' ? [a[i + 1]!] : []));
    expect(forwarded.slice(-2)).toEqual(['HOME=/tmp', 'TMPDIR=/tmp']);
    const snapwing = Object.keys(c.env).filter((k) => k.startsWith('SNAPWING_'));
    expect(snapwing.sort()).toEqual(forwarded.slice(0, -2).sort());
    expect(JSON.stringify(c.env)).not.toContain('server-only-secret');
    expect(JSON.stringify(c.env)).not.toContain('server-provider-key');
  });

  it('names a generic template', async () => {
    await runner().runReview(reviewJob({ harness: { adapter: 'generic', templateId: 'aider' } }));
    expect(calls()[0]!.env).toMatchObject({ SNAPWING_HARNESS: 'generic', SNAPWING_HARNESS_TEMPLATE: 'aider' });
  });

  it('with a model proxy: the proxy as each CLI base URL and a per-run model token, never a provider key or a fixer token', async () => {
    await runner({ env: { apiUrl: 'http://snapwing-api:8080', token: () => 'unused', modelProxy: proxy } }).runReview(reviewJob());
    const c = calls()[0]!;
    const base = 'http://snapwing-api:8080/model/WI01';
    expect(c.env).toMatchObject({
      SNAPWING_MODEL_PROXY_URL: base,
      ANTHROPIC_BASE_URL: `${base}/anthropic`,
      OPENAI_BASE_URL: `${base}/openai/v1`,
      GOOGLE_GEMINI_BASE_URL: `${base}/google`,
    });
    const token = c.env['ANTHROPIC_API_KEY'];
    if (token === undefined) throw new Error('no model token');
    for (const k of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'GEMINI_API_KEY']) expect(c.env[k]).toBe(token);
    expect(verifyModelToken(token, 'WI01', keys)).toMatchObject({ ok: true, claims: { workItemId: 'WI01', runId: REVIEW_RUN } });
    // Not usable on the fixer API.
    expect(verifyFixerToken(token, 'WI01', keys)).toEqual({ ok: false, reason: 'malformed' });
    expect(c.env['SNAPWING_FIXER_TOKEN']).toBeUndefined();
    expect(c.args.join(' ')).not.toContain(token);
    expect(JSON.stringify(c.env)).not.toContain('server-provider-key');
  });

  it('gives a fixer container the same model proxy env next to its fixer token', async () => {
    await runner({ env: { apiUrl: 'http://snapwing-api:8080', token: (j) => issueFixerToken({ workItemId: j.workItem.id, incidentId: 'INC01', ttl: 'PT45M' }, keys), modelProxy: proxy } }).runFixer(job());
    const c = calls()[0]!;
    expect(c.env['ANTHROPIC_BASE_URL']).toBe('http://snapwing-api:8080/model/WI01/anthropic');
    const token = c.env['ANTHROPIC_API_KEY'];
    expect(verifyModelToken(token ?? '', 'WI01', keys)).toMatchObject({ ok: true, claims: { runId: RUN_ID } });
    expect(token).not.toBe(c.env['SNAPWING_FIXER_TOKEN']);
    expect(JSON.stringify(c.env)).not.toContain('server-provider-key');
  });

  it('reports the exit code, and rejects when docker itself fails (exit 125)', async () => {
    writeFileSync(join(dir, 'exit'), '4');
    await expect(runner().runReview(reviewJob())).resolves.toMatchObject({ exitCode: 4, timedOut: false });
    writeFileSync(join(dir, 'mode'), 'run-fail');
    await expect(runner().runReview(reviewJob())).rejects.toThrow(/docker run failed \(exit 125\): Unable to find image/);
  });

  it('kills the container past the review wall clock and reports timedOut', async () => {
    writeFileSync(join(dir, 'mode'), 'hang');
    const r = await runner().runReview(reviewJob({ budget: { wallClock: 'PT0.3S', attempts: 1 } }));
    expect(r).toMatchObject({ exitCode: null, timedOut: true });
    expect(calls().map((c) => c.args.slice(0, 2))).toEqual([
      ['run', '--rm'],
      ['kill', `snapwing-review-${REVIEW_RUN}`],
    ]);
  });

  it('refuses files outside the tree and bad ids, calling docker never', async () => {
    for (const inputFile of ['/etc/passwd', '../x', '.git/../../x', 'a//b', 'a b']) {
      await expect(runner().runReview(reviewJob({ inputFile }))).rejects.toThrow(/not a plain relative path/);
    }
    await expect(runner().runReview(reviewJob({ verdictFile: '../verdict.json' }))).rejects.toThrow(/not a plain relative path/);
    await expect(runner().runReview(reviewJob({ runId: '../x' }))).rejects.toThrow(/plain path segment/);
    expect(calls()).toEqual([]);
  });
});
