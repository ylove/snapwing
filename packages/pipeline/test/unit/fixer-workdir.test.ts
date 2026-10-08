// Fixer workdir preparation and its guardrails (main 10.2, 16), against a local bare repository
// standing in for GitHub, and the local runner's use of it.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ulid } from '../../src/util/ulid.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateNotFoundError, type Artifact } from '../../src/contracts/state.ts';
import { askpassScript, isProtectedPath } from '../../src/fixer/workdir/hooks.ts';
import { prepareWorkdir, WorkdirError, type PreparedWorkdir } from '../../src/fixer/workdir/index.ts';
import type { HarnessCheckpoint, HarnessPort, HarnessResult, HarnessRunOptions } from '../../src/ports/harness.ts';
import type { FixerJob } from '../../src/ports/runner.ts';
import { buildImplementationRequest } from '../../src/prompts/implementation-request.ts';
import { createLocalRunner, PRIOR_REVIEW_ENV } from '../../src/providers/local/runner.ts';
import { createBareRepo, git, type BareRepo } from '../helpers/git.ts';

const TOKEN = 'test-installation-token-not-real';
const KEY = 'WEB-1042';
const BRANCH = 'fix/WEB-1042-promo-null-price';

let scratch: string;
let origin: BareRepo;

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-workdir-'));
  origin = await createBareRepo({ defaultBranch: 'main', branches: ['dev'] });
});

afterEach(async () => {
  await origin.remove();
  await rm(scratch, { recursive: true, force: true });
});

function prepare(over: Partial<Parameters<typeof prepareWorkdir>[0]> = {}): Promise<PreparedWorkdir> {
  return prepareWorkdir({
    repo: 'acme/web',
    base: 'dev',
    branch: BRANCH,
    issueKey: KEY,
    token: TOKEN,
    workdir: join(scratch, 'run'),
    remoteUrl: origin.url,
    ...over,
  });
}

/** Git in the checkout the way the harness runs it: only the prepared environment plus PATH. */
function harnessGit(p: PreparedWorkdir, args: string[]): string {
  return git(p.workdir, args, { PATH: process.env['PATH'], ...p.env });
}

/** Like harnessGit, but returns the exit status and stderr instead of throwing. */
function tryHarnessGit(p: PreparedWorkdir, args: string[]): { ok: boolean; stderr: string } {
  try {
    execFileSync('git', args, { cwd: p.workdir, env: { PATH: process.env['PATH'], ...p.env }, stdio: ['ignore', 'pipe', 'pipe'] });
    return { ok: true, stderr: '' };
  } catch (e) {
    return { ok: false, stderr: String((e as { stderr?: Buffer }).stderr ?? '') };
  }
}

async function commitFile(p: PreparedWorkdir, path: string, body: string, msg: string): Promise<{ ok: boolean; stderr: string }> {
  await mkdir(dirname(join(p.workdir, path)), { recursive: true });
  await writeFile(join(p.workdir, path), body);
  harnessGit(p, ['add', '-A']);
  return tryHarnessGit(p, ['commit', '--quiet', '-m', msg]);
}

async function filesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await filesUnder(path)));
    else out.push(path);
  }
  return out;
}

const remoteHas = (ref: string): boolean => git(origin.url, ['for-each-ref', '--format=%(refname)', ref]) !== '';

describe('prepareWorkdir', () => {
  it('clones the base, cuts the work branch from it, and sets the bot identity', async () => {
    const p = await prepare();
    expect(p).toMatchObject({ branch: BRANCH, base: 'dev', resumed: false });
    expect(p.baseSha).toBe(git(origin.url, ['rev-parse', 'refs/heads/dev']));
    expect(harnessGit(p, ['branch', '--show-current'])).toBe(BRANCH);
    expect(harnessGit(p, ['rev-parse', 'HEAD'])).toBe(p.baseSha);
    expect(harnessGit(p, ['config', 'user.name'])).toBe('snapwing[bot]');
    expect(harnessGit(p, ['config', 'user.email'])).toBe('snapwing[bot]@users.noreply.github.com');
    expect(harnessGit(p, ['remote', 'get-url', 'origin'])).toBe(origin.url);
    expect(harnessGit(p, ['status', '--porcelain'])).toBe('');
    expect((await readFile(join(p.workdir, 'dev.txt'), 'utf8')).trim()).toBe('dev');
  });

  it("takes the workspace map's github.com/owner/name form of the repo an incident records", async () => {
    const p = await prepare({ repo: 'github.com/acme/web' });
    expect(harnessGit(p, ['branch', '--show-current'])).toBe(BRANCH);
    await rm(p.workdir, { recursive: true, force: true });
    await expect(prepare({ repo: 'github.com/acme/web/extra' })).rejects.toThrow('is not owner/name');
  });

  it('never writes the token to any file under the work directory', async () => {
    const p = await prepare();
    expect(await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} guard the null price`)).toEqual({ ok: true, stderr: '' });
    expect(tryHarnessGit(p, ['push', '--quiet', 'origin', BRANCH]).ok).toBe(true);
    const files = await filesUnder(p.workdir);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect((await readFile(file)).includes(TOKEN), file).toBe(false);
    expect(harnessGit(p, ['config', '--local', '--list'])).not.toContain(TOKEN);
    // The token lives only in the environment the harness gets.
    expect(p.env['SNAPWING_GIT_TOKEN']).toBe(TOKEN);
    expect(p.env['GIT_ASKPASS']).toBe(join(p.workdir, '.git', 'snapwing', 'askpass'));
  });

  it('answers git credential prompts from the environment through the askpass script', async () => {
    const p = await prepare();
    const ask = (prompt: string): string =>
      execFileSync(p.env['GIT_ASKPASS'] as string, [prompt], { env: { PATH: process.env['PATH'], SNAPWING_GIT_TOKEN: TOKEN }, encoding: 'utf8' }).trim();
    expect(ask("Username for 'https://github.com': ")).toBe('x-access-token');
    expect(ask("Password for 'https://x-access-token@github.com': ")).toBe(TOKEN);
    expect(askpassScript()).not.toContain(TOKEN);
  });

  it('rejects a commit whose message lacks the issue key', async () => {
    const p = await prepare();
    const bare = await commitFile(p, 'a.txt', 'a\n', 'guard the null price');
    expect(bare.ok).toBe(false);
    expect(bare.stderr).toContain(`must contain the issue key ${KEY}`);
    expect((await commitFile(p, 'a.txt', 'a\n', 'WEB-10420 is a different issue')).ok).toBe(false);
    expect((await commitFile(p, 'a.txt', 'a\n', 'Fix promo null price (WEB-1042)')).ok).toBe(true);
    expect(harnessGit(p, ['log', '-1', '--format=%an <%ae>'])).toBe('snapwing[bot] <snapwing[bot]@users.noreply.github.com>');
  });

  it('pushes the work branch and rejects a push to the base or any other ref', async () => {
    const p = await prepare();
    expect((await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} fix`)).ok).toBe(true);
    const head = harnessGit(p, ['rev-parse', 'HEAD']);

    const toBase = tryHarnessGit(p, ['push', 'origin', 'HEAD:dev']);
    expect(toBase.ok).toBe(false);
    expect(toBase.stderr).toContain('pushing to the base branch dev is not allowed');
    expect(git(origin.url, ['rev-parse', 'refs/heads/dev'])).toBe(p.baseSha);

    const toMain = tryHarnessGit(p, ['push', 'origin', 'HEAD:main']);
    expect(toMain.ok).toBe(false);
    expect(toMain.stderr).toContain('only the work branch');
    expect(tryHarnessGit(p, ['push', 'origin', 'HEAD:refs/tags/v1']).ok).toBe(false);
    expect(remoteHas('refs/tags/v1')).toBe(false);

    // Plain `git push` goes to the work branch (push.default upstream).
    expect(tryHarnessGit(p, ['push', '--quiet']).ok).toBe(true);
    expect(git(origin.url, ['rev-parse', `refs/heads/${BRANCH}`])).toBe(head);
    expect(tryHarnessGit(p, ['push', 'origin', `:${BRANCH}`]).ok).toBe(false);
    expect(remoteHas(`refs/heads/${BRANCH}`)).toBe(true);
  });

  it.each([['.github/workflows/ci.yml'], ['CODEOWNERS'], ['.github/CODEOWNERS'], ['.github/settings.yml']])(
    'rejects a push whose diff touches %s',
    async (path) => {
      const p = await prepare();
      expect((await commitFile(p, path, 'x: 1\n', `${KEY} sneak`)).ok).toBe(true);
      expect((await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} fix`)).ok).toBe(true);
      const push = tryHarnessGit(p, ['push', 'origin', BRANCH]);
      expect(push.ok).toBe(false);
      expect(push.stderr).toContain('may not change CI config');
      expect(push.stderr).toContain(path);
      expect(remoteHas(`refs/heads/${BRANCH}`)).toBe(false);
    },
  );

  it('counts a workflow file moved or deleted in an earlier push of the branch', async () => {
    await origin.remove();
    origin = await createBareRepo({ defaultBranch: 'main', files: { '.github/workflows/ci.yml': 'on: push\n' } });
    const p = await prepare({ base: 'main' });
    harnessGit(p, ['mv', '.github/workflows/ci.yml', 'ci.yml']);
    expect(tryHarnessGit(p, ['commit', '--quiet', '-m', `${KEY} move`]).ok).toBe(true);
    expect(tryHarnessGit(p, ['push', 'origin', BRANCH]).ok).toBe(false);
  });

  it('uses the remote default branch when no base is given', async () => {
    const p = await prepare({ base: undefined, workdir: join(scratch, 'default') });
    expect(p.base).toBe('main');
    expect(harnessGit(p, ['rev-parse', 'HEAD'])).toBe(git(origin.url, ['rev-parse', 'refs/heads/main']));
    expect((await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} fix`)).ok).toBe(true);
    expect(tryHarnessGit(p, ['push', 'origin', 'HEAD:main']).stderr).toContain('pushing to the base branch main is not allowed');
  });

  it('checks out the work branch when it already exists on the remote (a retry run)', async () => {
    await origin.remove();
    origin = await createBareRepo({ defaultBranch: 'main', branches: ['dev', BRANCH] });
    const p = await prepare();
    expect(p.resumed).toBe(true);
    expect(harnessGit(p, ['rev-parse', 'HEAD'])).toBe(git(origin.url, ['rev-parse', `refs/heads/${BRANCH}`]));
    expect((await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} address review`)).ok).toBe(true);
    expect(tryHarnessGit(p, ['push', '--quiet']).ok).toBe(true);
  });

  it('refuses unsafe names, a missing base, the base as the work branch, and a non-empty directory', async () => {
    await expect(prepare({ repo: '../web' })).rejects.toBeInstanceOf(WorkdirError);
    await expect(prepare({ issueKey: 'web-1042; rm -rf /' })).rejects.toThrow(/not a Jira key/);
    await expect(prepare({ branch: "fix/it'; true" })).rejects.toThrow(/not an allowed branch name/);
    await expect(prepare({ branch: 'fix/a..b' })).rejects.toThrow(/check-ref-format/);
    await expect(prepare({ token: '' })).rejects.toThrow(/token is empty/);
    await expect(prepare({ base: 'nope', workdir: join(scratch, 'w1') })).rejects.toThrow(/base nope does not exist/);
    await expect(prepare({ branch: 'dev', workdir: join(scratch, 'w2') })).rejects.toThrow(/is the base/);
    await mkdir(join(scratch, 'w3'));
    await writeFile(join(scratch, 'w3', 'x'), 'x');
    await expect(prepare({ workdir: join(scratch, 'w3') })).rejects.toThrow(/not empty/);
  });

  it('classifies protected paths', () => {
    for (const p of ['.github/workflows/ci.yml', '.github/workflows/sub/x.yaml', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/settings.yaml']) {
      expect(isProtectedPath(p), p).toBe(true);
    }
    for (const p of ['src/CODEOWNERS.ts', 'workflows/ci.yml', '.github/ISSUE_TEMPLATE.md', 'a/.github/workflows/x.yml']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });
});

describe('local runner workdir', () => {
  const WS = '01HZXTESTWORKSPACE00000000';
  const INC = '01HZXTESTINCIDENT000000000';
  const REQUEST_ID = '01HZXTESTREQUEST0000000000';
  const REVIEW_ID = '01HZXTESTREVIEW00000000000';
  const REVIEW_BODY = '{"verdict":"request-changes","reasons":["add a regression test"],"constraintViolations":[]}';

  const artifact = (id: string, kind: Artifact['kind'], body: string): Artifact => ({
    id,
    version: 1,
    workspaceId: WS,
    incidentId: INC,
    kind,
    contentType: kind === 'review' ? 'application/json' : 'application/xml',
    sha256: '0'.repeat(64),
    body,
    createdBy: 'test',
    createdAt: '2026-10-02T09:00:00.000Z',
  });

  const request = (handoff: { branch?: string; base?: string }): string =>
    buildImplementationRequest({
      issue: KEY,
      intent: 'Promo codes with a null price crash checkout.',
      evidence: [{ kind: 'report', source: 'slack', text: 'checkout breaks with PROMO10' }],
      constraints: { scope: 'checkout only', tests: { required: true, text: 'add a regression test' }, forbidden: [] },
      handoff: { mode: 'review', autonomy: 2, ...handoff },
    });

  let artifacts: Record<string, Artifact>;
  const store = {
    async getArtifact(id: string): Promise<Artifact> {
      const a = artifacts[id];
      if (a === undefined) throw new StateNotFoundError('artifact', id);
      return a;
    },
  };

  beforeEach(() => {
    artifacts = {
      [REQUEST_ID]: artifact(REQUEST_ID, 'implementation-request', request({ branch: BRANCH, base: 'dev' })),
      [REVIEW_ID]: artifact(REVIEW_ID, 'review', REVIEW_BODY),
    };
  });

  const job = (over: Partial<FixerJob> = {}): FixerJob => ({
    runId: ulid(),
    workItem: { id: '01HZXTESTWORKITEM0000000000', issueKey: KEY, repo: 'acme/web' },
    implementationRequestArtifactId: REQUEST_ID,
    harness: { adapter: 'generic', templateId: 'fake' },
    budget: { wallClock: 'PT1M', attempts: 2 },
    ...over,
  });

  interface Seen {
    workdir: string;
    branch: string;
    env: Readonly<Record<string, string>>;
    review: string | null;
    phasesBefore: string[];
  }

  function setup(behave: (workdir: string, opts: HarnessRunOptions) => Promise<HarnessResult>, over: { keepFailedWorkdir?: boolean; token?: () => Promise<string> } = {}) {
    const workdirRoot = join(scratch, 'runs');
    const phases: HarnessCheckpoint[] = [];
    const seen: Seen[] = [];
    const harness: HarnessPort = {
      async run(_workItem, _request, workdir, opts) {
        const env = opts.env ?? {};
        const reviewFile = env[PRIOR_REVIEW_ENV];
        seen.push({
          workdir,
          branch: git(workdir, ['branch', '--show-current']),
          env,
          review: reviewFile === undefined ? null : await readFile(reviewFile, 'utf8'),
          phasesBefore: phases.map((c) => c.phase),
        });
        return behave(workdir, opts);
      },
    };
    const tokens: string[] = [];
    const runner = createLocalRunner({
      resolveHarness: () => harness,
      artifacts: store,
      workdirRoot,
      git: {
        token: over.token ?? (async (w) => {
          tokens.push(w.repo);
          return TOKEN;
        }),
        remoteUrl: () => origin.url,
      },
      ...(over.keepFailedWorkdir === undefined ? {} : { keepFailedWorkdir: over.keepFailedWorkdir }),
      onCheckpoint: async (_run, c) => {
        phases.push(c);
      },
    });
    return { runner, workdirRoot, phases, seen, tokens };
  }

  const done: HarnessResult = { outcome: 'done', branch: BRANCH, summary: 'ok', testsAdded: [] };

  it('prepares the checkout before the harness, records cloned, and removes the checkout afterwards', async () => {
    const { runner, workdirRoot, phases, seen, tokens } = setup(async (workdir, opts) => {
      await writeFile(join(workdir, 'fix.ts'), 'export {};\n');
      const env = { PATH: process.env['PATH'], ...opts.env };
      git(workdir, ['add', '-A'], env);
      git(workdir, ['commit', '--quiet', '-m', `${KEY} fix`], env);
      git(workdir, ['push', '--quiet'], env);
      await opts.onCheckpoint({ phase: 'pushed' });
      return done;
    });
    const { runId } = await runner.runFixer(job());
    expect(await runner.wait(runId)).toEqual(done);
    expect(tokens).toEqual(['acme/web']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.workdir).toBe(join(workdirRoot, runId));
    expect(seen[0]?.branch).toBe(BRANCH);
    expect(seen[0]?.phasesBefore).toEqual(['cloned']);
    expect(seen[0]?.env['SNAPWING_GIT_TOKEN']).toBe(TOKEN);
    expect(seen[0]?.review).toBeNull();
    const devSha = git(origin.url, ['rev-parse', 'refs/heads/dev']);
    expect(phases).toEqual([{ phase: 'cloned', detail: `dev@${devSha.slice(0, 12)}` }, { phase: 'pushed' }]);
    expect(remoteHas(`refs/heads/${BRANCH}`)).toBe(true);
    await expect(stat(join(workdirRoot, runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('branches fix/<key> from the default branch when the handoff names neither', async () => {
    artifacts[REQUEST_ID] = artifact(REQUEST_ID, 'implementation-request', request({}));
    const { runner, seen } = setup(async () => done);
    const { runId } = await runner.runFixer(job());
    await runner.wait(runId);
    expect(seen[0]?.branch).toBe(`fix/${KEY}`);
  });

  it('hands the review artifact of a retry run to the harness as a file named in the environment', async () => {
    const { runner, workdirRoot, seen } = setup(async () => done);
    const { runId } = await runner.runFixer(job({ review: { artifactId: REVIEW_ID, version: 1 } }));
    await runner.wait(runId);
    expect(seen[0]?.review).toBe(REVIEW_BODY);
    expect(seen[0]?.env[PRIOR_REVIEW_ENV]).toBe(join(workdirRoot, runId, '.git', 'snapwing', 'review.json'));
    await expect(runner.runFixer(job({ review: { artifactId: REQUEST_ID, version: 1 } }))).rejects.toThrow(/not a review/);
  });

  it('keeps a failed checkout only when keepFailedWorkdir is set', async () => {
    const failed: HarnessResult = { outcome: 'failed', reason: 'tests still failing', attempts: 2 };
    let next: HarnessResult = failed;
    const kept = setup(async () => next, { keepFailedWorkdir: true });
    const a = await kept.runner.runFixer(job());
    expect(await kept.runner.wait(a.runId)).toEqual(failed);
    expect((await stat(join(kept.workdirRoot, a.runId, '.git'))).isDirectory()).toBe(true);
    next = { outcome: 'stopped', atPhase: 'implemented' };
    const ok = await kept.runner.runFixer(job());
    await kept.runner.wait(ok.runId);
    await expect(stat(join(kept.workdirRoot, ok.runId))).rejects.toMatchObject({ code: 'ENOENT' });

    const removed = setup(async () => failed);
    const b = await removed.runner.runFixer(job());
    await removed.runner.wait(b.runId);
    await expect(stat(join(removed.workdirRoot, b.runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('fails the run without starting the harness when the checkout cannot be prepared', async () => {
    artifacts[REQUEST_ID] = artifact(REQUEST_ID, 'implementation-request', request({ base: 'gone' }));
    const { runner, seen, phases, workdirRoot } = setup(async () => done);
    const { runId } = await runner.runFixer(job());
    const result = await runner.wait(runId);
    expect(result).toMatchObject({ outcome: 'failed', attempts: 0 });
    if (result.outcome === 'failed') expect(result.reason).toMatch(/^workdir: the base gone does not exist/);
    expect(seen).toEqual([]);
    expect(phases).toEqual([]);
    await expect(stat(join(workdirRoot, runId))).rejects.toMatchObject({ code: 'ENOENT' });

    const noToken = setup(async () => done, { token: async () => Promise.reject(new Error('installation not found')) });
    const second = await noToken.runner.runFixer(job());
    expect(await noToken.runner.wait(second.runId)).toEqual({ outcome: 'failed', reason: 'workdir: installation not found', attempts: 0 });
  });

  it('stops at cloned when cancelled before the harness starts', async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { runner, seen } = setup(async () => done, {
      token: async () => {
        await gate;
        return TOKEN;
      },
    });
    const { runId } = await runner.runFixer(job());
    const cancelled = runner.cancel(runId);
    release();
    await cancelled;
    expect(await runner.wait(runId)).toEqual({ outcome: 'stopped', atPhase: 'cloned' });
    expect(seen).toEqual([]);
  });

  it('starts nothing for a request that does not parse', async () => {
    artifacts[REQUEST_ID] = artifact(REQUEST_ID, 'implementation-request', '<implementation-request>no namespace</implementation-request>');
    const { runner } = setup(async () => done);
    await expect(runner.runFixer(job())).rejects.toThrow(/Invalid implementation request/);
    expect(runner.active()).toEqual([]);
  });
});
