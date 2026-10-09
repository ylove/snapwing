// Fixer workdir preparation and its guardrails (main 10.2, 16), the hand-off bundle and run record
// (#262), against a local bare repository standing in for GitHub, and the local runner's use of them.

import { execFileSync } from 'node:child_process';
import { mkdtemp, readdir, readFile, rm, stat, writeFile, mkdir } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ulid } from '../../src/util/ulid.ts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { StateNotFoundError, type Artifact } from '../../src/contracts/state.ts';
import { bundleWork, readRunRecord, runLayout, writeRunRecord, type RunRecord } from '../../src/fixer/workdir/handoff.ts';
import { askpassScript, isProtectedPath, messageNamesKey } from '../../src/fixer/workdir/hooks.ts';
import { prepareWorkdir, withoutCredentials, WorkdirError, type PreparedWorkdir } from '../../src/fixer/workdir/index.ts';
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
    expect(p.expectedBase).toBe(p.baseSha);
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

  it('gives the harness no credential: the token is in no file, no config, no remote URL, and not in its environment (#262)', async () => {
    const p = await prepare();
    expect(await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} guard the null price`)).toEqual({ ok: true, stderr: '' });
    const files = await filesUnder(p.workdir);
    expect(files.length).toBeGreaterThan(5);
    for (const file of files) expect((await readFile(file)).includes(TOKEN), file).toBe(false);
    expect(harnessGit(p, ['config', '--local', '--list'])).not.toContain(TOKEN);
    expect(harnessGit(p, ['config', '--local', '--list'])).not.toMatch(/askpass|credential\.helper=./);
    expect(p.env).toEqual({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
    expect(JSON.stringify(p.env)).not.toContain(TOKEN);
    // Only the commit-msg guardrail: nothing in the checkout pushes or answers for a credential.
    expect(await readdir(join(p.workdir, '.git', 'snapwing', 'hooks'))).toEqual(['commit-msg']);
    expect(files.some((f) => f.endsWith('askpass'))).toBe(false);
  });

  it('strips any credential from a clone URL before it can reach the config', () => {
    expect(withoutCredentials('https://x-access-token:test-token-not-real@github.com/acme/web.git')).toBe('https://github.com/acme/web.git');
    expect(withoutCredentials('https://someone@github.com/acme/web.git')).toBe('https://github.com/acme/web.git');
    expect(withoutCredentials('https://github.com/acme/web.git')).toBe('https://github.com/acme/web.git');
    expect(withoutCredentials('/srv/git/acme/web.git')).toBe('/srv/git/acme/web.git');
  });

  it('answers the clone on the host from the environment through the askpass script, which holds no token', async () => {
    const script = join(scratch, 'askpass');
    await writeFile(script, askpassScript(), { mode: 0o700 });
    const ask = (prompt: string): string => execFileSync(script, [prompt], { env: { PATH: process.env['PATH'], SNAPWING_GIT_TOKEN: TOKEN }, encoding: 'utf8' }).trim();
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

  it('uses the remote default branch when no base is given', async () => {
    const p = await prepare({ base: undefined, workdir: join(scratch, 'default') });
    expect(p.base).toBe('main');
    expect(harnessGit(p, ['rev-parse', 'HEAD'])).toBe(git(origin.url, ['rev-parse', 'refs/heads/main']));
  });

  it('checks out the work branch when it already exists on the remote (a retry run), from where it left the base', async () => {
    await origin.remove();
    origin = await createBareRepo({ defaultBranch: 'main', branches: ['dev', BRANCH] });
    const p = await prepare();
    expect(p.resumed).toBe(true);
    expect(harnessGit(p, ['rev-parse', 'HEAD'])).toBe(git(origin.url, ['rev-parse', `refs/heads/${BRANCH}`]));
    // Both branches were cut from main: the retry's work must build on that commit, not on dev's tip.
    expect(p.expectedBase).toBe(git(origin.url, ['rev-parse', 'refs/heads/main']));
    expect(p.baseSha).toBe(git(origin.url, ['rev-parse', 'refs/heads/dev']));
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

  it('classifies protected paths: CI, a CODEOWNERS file anywhere, branch protection settings', () => {
    for (const p of ['.github/workflows/ci.yml', '.github/workflows/sub/x.yaml', 'CODEOWNERS', 'docs/CODEOWNERS', '.github/CODEOWNERS', 'src/CODEOWNERS', '.github/settings.yaml']) {
      expect(isProtectedPath(p), p).toBe(true);
    }
    for (const p of ['src/CODEOWNERS.ts', 'NOTCODEOWNERS', 'workflows/ci.yml', '.github/ISSUE_TEMPLATE.md', 'a/.github/workflows/x.yml']) {
      expect(isProtectedPath(p), p).toBe(false);
    }
  });

  it('checks a commit message names the issue key as a whole token, on any line', () => {
    expect(messageNamesKey(`${KEY}: guard the null price`, KEY)).toBe(true);
    expect(messageNamesKey(`Guard the null price\n\nRefs ${KEY}.`, KEY)).toBe(true);
    expect(messageNamesKey('Fix promo (WEB-1042)', KEY)).toBe(true);
    expect(messageNamesKey('WEB-10420: another issue', KEY)).toBe(false);
    expect(messageNamesKey('XWEB-1042 is not it', KEY)).toBe(false);
    expect(messageNamesKey('guard the null price', KEY)).toBe(false);
  });
});

describe('the hand-off bundle and run record (#262)', () => {
  it('bundles the work branch since the expected base, and no other branch', async () => {
    const p = await prepare();
    expect((await commitFile(p, 'src/fix.ts', 'export {};\n', `${KEY} guard the null price`)).ok).toBe(true);
    harnessGit(p, ['branch', 'side']);
    const file = join(scratch, 'out', 'work.bundle');
    await mkdir(dirname(file));
    await bundleWork({ checkout: p.workdir, branch: BRANCH, expectedBase: p.expectedBase, file, env: { PATH: process.env['PATH'] ?? '' } });
    expect(git(scratch, ['bundle', 'list-heads', file])).toBe(`${harnessGit(p, ['rev-parse', 'HEAD'])} refs/heads/${BRANCH}`);
    // A repository that has the base can take it: the base is its one prerequisite.
    const other = join(scratch, 'other.git');
    git(scratch, ['init', '--quiet', '--bare', other]);
    git(other, ['fetch', '--quiet', origin.url, 'refs/heads/dev:refs/heads/dev']);
    git(other, ['bundle', 'verify', '--quiet', file]);
  });

  it('refuses to bundle a branch with nothing committed beyond its base, or one that is gone', async () => {
    const p = await prepare();
    const file = join(scratch, 'empty.bundle');
    await expect(bundleWork({ checkout: p.workdir, branch: BRANCH, expectedBase: p.expectedBase, file })).rejects.toThrow(/nothing is committed on/);
    await expect(bundleWork({ checkout: p.workdir, branch: 'fix/other', expectedBase: p.expectedBase, file })).rejects.toThrow(/is gone/);
  });

  it('writes the run record once and reads it back checked', async () => {
    const dir = join(scratch, 'run-dir');
    await mkdir(dir);
    const record = { runId: ulid(), repo: 'acme/web', issueKey: KEY, branch: BRANCH, base: 'dev', expectedBase: 'a'.repeat(40) };
    await writeRunRecord(dir, record);
    expect(await readRunRecord(dir)).toEqual(record);
    await expect(writeRunRecord(dir, record)).rejects.toThrow();
    expect(runLayout(dir)).toEqual({ dir, checkout: join(dir, 'work'), out: join(dir, 'out'), bundle: join(dir, 'out', 'work.bundle'), record: join(dir, 'run.json') });

    await writeFile(join(dir, 'run.json'), JSON.stringify({ v: 1, ...record, branch: 'fix/a b' }));
    await expect(readRunRecord(dir)).rejects.toThrow(/not an allowed branch name/);
    await writeFile(join(dir, 'run.json'), JSON.stringify({ v: 1, ...record, expectedBase: 'HEAD' }));
    await expect(readRunRecord(dir)).rejects.toThrow(/malformed/);
    await rm(join(dir, 'run.json'));
    await expect(readRunRecord(dir)).rejects.toThrow(/no record/);
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

  interface Finished {
    result: HarnessResult;
    record: RunRecord | null;
    /** `git bundle list-heads` of the bundle, or null when there was none. */
    bundle: string | null;
  }

  function setup(behave: (workdir: string, opts: HarnessRunOptions) => Promise<HarnessResult>, over: { keepFailedWorkdir?: boolean; token?: () => Promise<string> } = {}) {
    const workdirRoot = join(scratch, 'runs');
    const phases: HarnessCheckpoint[] = [];
    const finished: Finished[] = [];
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
      onFinished: async (run, result) => {
        // What the server reads at the hand-off, while the run directory still exists.
        const layout = runLayout(join(workdirRoot, run.runId));
        const bundle = await stat(layout.bundle).then(() => git(scratch, ['bundle', 'list-heads', layout.bundle]), () => null);
        finished.push({ result, record: await readRunRecord(layout.dir).catch(() => null), bundle });
      },
    });
    return { runner, workdirRoot, phases, seen, tokens, finished };
  }

  const done: HarnessResult = { outcome: 'done', branch: BRANCH, summary: 'ok', testsAdded: [] };

  it('prepares the checkout before the harness, records cloned, hands back a bundle, and removes the run afterwards', async () => {
    const { runner, workdirRoot, phases, seen, tokens, finished } = setup(async (workdir, opts) => {
      await writeFile(join(workdir, 'fix.ts'), 'export {};\n');
      const env = { PATH: process.env['PATH'], ...opts.env };
      git(workdir, ['add', '-A'], env);
      git(workdir, ['commit', '--quiet', '-m', `${KEY} fix`], env);
      await opts.onCheckpoint({ phase: 'tested' });
      return done;
    });
    const { runId } = await runner.runFixer(job());
    expect(await runner.wait(runId)).toEqual(done);
    expect(tokens).toEqual(['acme/web']);
    expect(seen).toHaveLength(1);
    expect(seen[0]?.workdir).toBe(join(workdirRoot, runId, 'work'));
    expect(seen[0]?.branch).toBe(BRANCH);
    expect(seen[0]?.phasesBefore).toEqual(['cloned']);
    // No credential reaches the harness (#262): the clone token stayed with the runner.
    expect(seen[0]?.env).toEqual({ GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' });
    expect(seen[0]?.review).toBeNull();
    const devSha = git(origin.url, ['rev-parse', 'refs/heads/dev']);
    expect(phases).toEqual([{ phase: 'cloned', detail: `dev@${devSha.slice(0, 12)}` }, { phase: 'tested' }]);
    // The run pushed nothing; it left the work branch as a bundle and the runner's record beside it.
    expect(remoteHas(`refs/heads/${BRANCH}`)).toBe(false);
    expect(finished).toHaveLength(1);
    expect(finished[0]?.record).toEqual({ runId, repo: 'acme/web', issueKey: KEY, branch: BRANCH, base: 'dev', expectedBase: devSha });
    expect(finished[0]?.bundle).toMatch(new RegExp(` refs/heads/${BRANCH}$`));
    await expect(stat(join(workdirRoot, runId))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves no bundle when the harness committed nothing, and none for a stopped run', async () => {
    const quiet = setup(async () => done);
    const a = await quiet.runner.runFixer(job());
    await quiet.runner.wait(a.runId);
    expect(quiet.finished[0]?.bundle).toBeNull();
    expect(quiet.finished[0]?.record?.branch).toBe(BRANCH);

    const stopped = setup(async (workdir, opts) => {
      await writeFile(join(workdir, 'fix.ts'), 'export {};\n');
      const env = { PATH: process.env['PATH'], ...opts.env };
      git(workdir, ['add', '-A'], env);
      git(workdir, ['commit', '--quiet', '-m', `${KEY} fix`], env);
      return { outcome: 'stopped', atPhase: 'implemented' };
    });
    const b = await stopped.runner.runFixer(job());
    await stopped.runner.wait(b.runId);
    expect(stopped.finished[0]?.bundle).toBeNull();
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
    expect(seen[0]?.env[PRIOR_REVIEW_ENV]).toBe(join(workdirRoot, runId, 'work', '.git', 'snapwing', 'review.json'));
    await expect(runner.runFixer(job({ review: { artifactId: REQUEST_ID, version: 1 } }))).rejects.toThrow(/not a review/);
  });

  it('keeps a failed checkout only when keepFailedWorkdir is set', async () => {
    const failed: HarnessResult = { outcome: 'failed', reason: 'tests still failing', attempts: 2 };
    let next: HarnessResult = failed;
    const kept = setup(async () => next, { keepFailedWorkdir: true });
    const a = await kept.runner.runFixer(job());
    expect(await kept.runner.wait(a.runId)).toEqual(failed);
    expect((await stat(join(kept.workdirRoot, a.runId, 'work', '.git'))).isDirectory()).toBe(true);
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
