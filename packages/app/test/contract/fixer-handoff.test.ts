// The server side of the fixer hand-off (#262, main 10.2, main 16): a fixer's work comes back as a
// bundle of its work branch; the server imports it into a cache of its own, checks it, pushes exactly
// the work branch, and opens the pull request as the App. Local bare repositories stand in for GitHub;
// the GitHub client is an in-memory fake.

import { execFileSync } from 'node:child_process';
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { bundleWork, runLayout, writeRunRecord } from '@snapwing/pipeline/fixer/workdir/handoff.ts';
import { prepareWorkdir, type PreparedWorkdir } from '@snapwing/pipeline/fixer/workdir/index.ts';
import { createBareRepo, git, GIT_ENV, type BareRepo } from '../../../pipeline/test/helpers/git.ts';
import { createFixerHandoff, FETCH_PERMISSIONS, PUSH_PERMISSIONS, type HandoffRequest, type HandoffResult } from '../../src/fixer-api/handoff.ts';
import type { GitHubPermissions } from '../../src/github/auth.ts';
import type { CreatePullRequestInput, PullRequest } from '../../src/github/client.ts';

const KEY = 'WEB-1042';
const BRANCH = 'fix/WEB-1042';
const RUN = '01K6HANDOFF000000000000001';
const TOKEN = 'test-installation-token-not-real';

let scratch: string;
let origin: BareRepo;
let runsRoot: string;
let cacheRoot: string;
let tokens: { repo: string; permissions: GitHubPermissions; fresh: boolean }[];
let pulls: (CreatePullRequestInput & { number: number })[];

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), 'snapwing-handoff-'));
  origin = await createBareRepo({ defaultBranch: 'main', files: { 'src/cart.ts': 'export const total = 1;\n', '.github/workflows/ci.yml': 'on: push\n' } });
  runsRoot = join(scratch, 'fixer');
  cacheRoot = join(scratch, 'handoff');
  tokens = [];
  pulls = [];
});

afterEach(async () => {
  await origin.remove();
  await rm(scratch, { recursive: true, force: true });
});

function handoff(over: { maxBundleBytes?: number } = {}) {
  return createFixerHandoff({
    runDir: (runId) => join(runsRoot, runId),
    cacheRoot,
    remoteUrl: () => origin.url,
    token: async (repo, permissions, fresh) => {
      tokens.push({ repo, permissions, fresh });
      return TOKEN;
    },
    github: () => ({
      findOpenPullRequest: async (head, base) => {
        const found = pulls.find((p) => p.head === head && p.base === base);
        return found === undefined ? undefined : pr(found);
      },
      createPullRequest: async (input) => {
        const created = { ...input, number: pulls.length + 1 };
        pulls.push(created);
        return pr(created);
      },
    }),
    ...over,
  });
}

function pr(p: CreatePullRequestInput & { number: number }): PullRequest {
  return { number: p.number, title: p.title, body: p.body, headRef: p.head, baseRef: p.base } as unknown as PullRequest;
}

/** A run laid out as both runners lay it out: the checkout on the work branch, `out/`, and the record. */
async function run(runId = RUN, over: { base?: string } = {}): Promise<PreparedWorkdir> {
  const layout = runLayout(join(runsRoot, runId));
  await mkdir(layout.out, { recursive: true });
  const p = await prepareWorkdir({ repo: 'acme/web', base: over.base ?? 'main', branch: BRANCH, issueKey: KEY, token: TOKEN, workdir: layout.checkout, remoteUrl: origin.url });
  await writeRunRecord(layout.dir, { runId, repo: 'acme/web', issueKey: KEY, branch: p.branch, base: p.base, expectedBase: p.expectedBase });
  return p;
}

/** Git in the checkout as the fixer runs it. */
function fixerGit(p: PreparedWorkdir, args: string[]): string {
  return git(p.workdir, args, { ...GIT_ENV, ...p.env });
}

async function commit(p: PreparedWorkdir, files: Record<string, string | null>, message: string): Promise<string> {
  for (const [path, body] of Object.entries(files)) {
    if (body === null) fixerGit(p, ['rm', '--quiet', path]);
    else {
      await mkdir(dirname(join(p.workdir, path)), { recursive: true });
      await writeFile(join(p.workdir, path), body);
      fixerGit(p, ['add', path]);
    }
  }
  fixerGit(p, ['commit', '--quiet', '--no-verify', '-m', message]);
  return fixerGit(p, ['rev-parse', 'HEAD']);
}

/** The wrapper's (or the local runner's) part: the bundle of the work branch in `out/`. */
async function bundle(p: PreparedWorkdir, runId = RUN): Promise<void> {
  await bundleWork({ checkout: p.workdir, branch: BRANCH, expectedBase: p.expectedBase, file: runLayout(join(runsRoot, runId)).bundle, env: { PATH: process.env['PATH'] ?? '' } });
}

function request(over: Partial<HandoffRequest> = {}): HandoffRequest {
  return {
    target: { workItemId: 'INC1', incidentId: 'INC1' },
    runId: RUN,
    outcome: 'done',
    summary: 'Guard the null cart total',
    testsAdded: ['test/cart.test.ts'],
    pushedBefore: [],
    running: async () => true,
    ...over,
  };
}

const remoteSha = (ref: string): string | undefined => {
  const out = git(origin.url, ['for-each-ref', '--format=%(objectname)', ref]);
  return out === '' ? undefined : out;
};
const remoteRefs = (): string[] => git(origin.url, ['for-each-ref', '--format=%(refname)']).split('\n').filter((r) => r !== '');

function refused(r: HandoffResult): string {
  if (r.ok || r.code !== 'refused') throw new Error(`expected a refusal, got ${JSON.stringify(r)}`);
  return r.reason;
}

describe('the fixer hand-off (#262)', () => {
  it('imports the bundle, pushes exactly the work branch with a token minted for the push, and opens the pull request as the App', async () => {
    const p = await run();
    const mainBefore = remoteSha('refs/heads/main');
    const tip = await commit(p, { 'src/cart.ts': 'export const total = 2;\n', 'test/cart.test.ts': 'ok\n' }, `${KEY}: guard the null cart total`);
    await bundle(p);

    const r = await handoff()(request());

    expect(r).toEqual({ ok: true, branch: BRANCH, sha: tip, prNumber: 1 });
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBe(tip);
    expect(remoteSha('refs/heads/main')).toBe(mainBefore);
    expect(remoteRefs()).toEqual(['refs/heads/fix/WEB-1042', 'refs/heads/main']);
    expect(pulls).toEqual([
      expect.objectContaining({ number: 1, head: BRANCH, base: 'main', title: `${KEY}: Guard the null cart total` }),
    ]);
    expect(pulls[0]?.body).toContain('test/cart.test.ts');
    // A read token for the fetch; a write token minted fresh for the push, on the one repository.
    expect(tokens).toEqual([
      { repo: 'acme/web', permissions: FETCH_PERMISSIONS, fresh: false },
      { repo: 'acme/web', permissions: PUSH_PERMISSIONS, fresh: true },
    ]);
    expect(PUSH_PERMISSIONS).toEqual({ contents: 'write' });
    // The import ran in the server's own bare cache of the repository.
    expect(git(join(cacheRoot, 'acme', 'web.git'), ['rev-parse', '--is-bare-repository'])).toBe('true');
  });

  it('is idempotent: a repeated hand-off has nothing to push and finds the open pull request', async () => {
    const p = await run();
    const tip = await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    await bundle(p);
    expect(await handoff()(request())).toMatchObject({ ok: true, prNumber: 1 });
    expect(await handoff()(request())).toEqual({ ok: true, branch: BRANCH, sha: tip, prNumber: 1 });
    expect(pulls).toHaveLength(1);
    expect(tokens.filter((t) => t.fresh)).toHaveLength(1);
  });

  it('pushes a failed run\'s partial work without opening a pull request', async () => {
    const p = await run();
    const tip = await commit(p, { 'src/cart.ts': 'export const total = 3;\n' }, `${KEY} partial`);
    await bundle(p);
    expect(await handoff()(request({ outcome: 'failed' }))).toEqual({ ok: true, branch: BRANCH, sha: tip });
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBe(tip);
    expect(pulls).toEqual([]);
  });

  it('refuses a bundle carrying another ref, pushing nothing', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    fixerGit(p, ['checkout', '--quiet', '-b', 'side']);
    await commit(p, { 'side.txt': 'side\n' }, `${KEY} side`);
    const file = runLayout(join(runsRoot, RUN)).bundle;
    fixerGit(p, ['bundle', 'create', '--quiet', file, `${p.expectedBase}..refs/heads/${BRANCH}`, `${p.expectedBase}..refs/heads/side`]);

    expect(refused(await handoff()(request()))).toMatch(/may carry refs\/heads\/fix\/WEB-1042 only, not refs\/heads\/side/);
    expect(remoteRefs()).toEqual(['refs/heads/main']);

    // A bundle of only another branch is refused the same way.
    fixerGit(p, ['bundle', 'create', '--quiet', file, `${p.expectedBase}..refs/heads/side`]);
    expect(refused(await handoff()(request()))).toMatch(/not refs\/heads\/side/);
    expect(remoteRefs()).toEqual(['refs/heads/main']);
  });

  it('refuses work that does not build on the expected base', async () => {
    const p = await run();
    // History of its own: an orphan branch carrying a fix.
    fixerGit(p, ['checkout', '--quiet', '--orphan', 'elsewhere']);
    fixerGit(p, ['rm', '-r', '--quiet', '--cached', '.']);
    await commit(p, { 'src/cart.ts': 'export const total = 9;\n' }, `${KEY} unrelated history`);
    fixerGit(p, ['branch', '-f', BRANCH, 'HEAD']);
    const file = runLayout(join(runsRoot, RUN)).bundle;
    fixerGit(p, ['bundle', 'create', '--quiet', file, `refs/heads/${BRANCH}`]);

    expect(refused(await handoff()(request()))).toMatch(/does not build on the base commit/);
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBeUndefined();
  });

  it('refuses a commit whose message lacks the issue key, wherever it is in the range', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, 'guard the null cart total');
    await commit(p, { 'test/cart.test.ts': 'ok\n' }, `${KEY}: add the test`);
    await bundle(p);
    expect(refused(await handoff()(request()))).toMatch(/does not name WEB-1042/);
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBeUndefined();
    expect(pulls).toEqual([]);
  });

  it.each([
    ['a workflow', { '.github/workflows/release.yml': 'on: push\n' }, '.github/workflows/release.yml'],
    ['a CODEOWNERS file anywhere', { 'src/CODEOWNERS': '* @someone\n' }, 'src/CODEOWNERS'],
    ['the branch protection settings', { '.github/settings.yml': 'branches: []\n' }, '.github/settings.yml'],
    ['a workflow deleted', { '.github/workflows/ci.yml': null }, '.github/workflows/ci.yml'],
  ] as const)('refuses work that touches %s', async (_what, files, path) => {
    const p = await run();
    await commit(p, { ...files, 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    await bundle(p);
    expect(refused(await handoff()(request()))).toContain(path);
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBeUndefined();
  });

  it('refuses a workflow renamed out of .github/workflows: the old path counts', async () => {
    const p = await run();
    fixerGit(p, ['mv', '.github/workflows/ci.yml', 'ci.yml']);
    fixerGit(p, ['commit', '--quiet', '-m', `${KEY} move the workflow`]);
    await bundle(p);
    expect(refused(await handoff()(request()))).toContain('.github/workflows/ci.yml');
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBeUndefined();
  });

  it('refuses a run with no bundle, a bundle that is a link, and one over the size cap', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    expect(refused(await handoff()(request()))).toMatch(/left no bundle/);

    const layout = runLayout(join(runsRoot, RUN));
    await writeFile(join(scratch, 'secret.txt'), 'server-only file\n');
    await symlink(join(scratch, 'secret.txt'), layout.bundle);
    expect(refused(await handoff()(request()))).toMatch(/is a link/);

    await rm(layout.bundle);
    await bundle(p);
    expect(refused(await handoff({ maxBundleBytes: 64 })(request()))).toMatch(/larger than 64 bytes/);
    expect(remoteRefs()).toEqual(['refs/heads/main']);
  });

  it('refuses a run without its record, or with a record for another run', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    await bundle(p);
    expect(refused(await handoff()(request({ runId: '01K6HANDOFF00000000000000X' })))).toMatch(/no usable record/);
    await mkdir(join(runsRoot, 'OTHER'), { recursive: true });
    await writeRunRecord(join(runsRoot, 'OTHER'), { runId: RUN, repo: 'acme/web', issueKey: KEY, branch: BRANCH, base: 'main', expectedBase: p.expectedBase });
    expect(refused(await handoff()(request({ runId: 'OTHER' })))).toMatch(/names another run/);
  });

  it('a stopped run pushes nothing: the run is checked before the import and again before the push', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    await bundle(p);

    expect(await handoff()(request({ running: async () => false }))).toEqual({ ok: false, code: 'stopped' });
    expect(existsSync(join(cacheRoot, 'acme', 'web.git'))).toBe(false);

    let asked = 0;
    expect(await handoff()(request({ running: async () => ++asked < 2 }))).toEqual({ ok: false, code: 'stopped' });
    expect(asked).toBe(2);
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBeUndefined();
    expect(tokens.some((t) => t.fresh)).toBe(false);
    expect(pulls).toEqual([]);

    // Stopped after the push: the branch stays (main 10.4), but no pull request is opened.
    asked = 0;
    expect(await handoff()(request({ running: async () => ++asked < 3 }))).toEqual({ ok: false, code: 'stopped' });
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBeDefined();
    expect(pulls).toEqual([]);
  });

  it('never runs git in the fixer\'s checkout: its hooks and config do not run on the server', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    await bundle(p);
    // What a fixer could plant for the next git that opens its checkout.
    const marker = join(scratch, 'ran-on-the-server');
    const script = join(scratch, 'planted.sh');
    await writeFile(script, `#!/bin/sh\necho ran >> '${marker}'\nexit 0\n`);
    await chmod(script, 0o755);
    fixerGit(p, ['config', 'core.fsmonitor', script]);
    fixerGit(p, ['config', 'core.hooksPath', join(p.workdir, '.git', 'hooks')]);
    for (const hook of ['pre-push', 'post-checkout', 'reference-transaction', 'pre-auto-gc']) {
      await writeFile(join(p.workdir, '.git', 'hooks', hook), `#!/bin/sh\n'${script}'\n`, { mode: 0o755 });
    }

    expect(await handoff()(request())).toMatchObject({ ok: true, prNumber: 1 });
    expect(existsSync(marker)).toBe(false);
    // The plant is live: any git that opened the checkout would have run it.
    fixerGit(p, ['status', '--porcelain']);
    expect(existsSync(marker)).toBe(true);
  });

  it('on a retry, replaces commits on GitHub only on a branch the server pushed for an earlier run of the incident', async () => {
    // The first run's work, pushed by the server.
    const first = await run('01K6HANDOFF000000000000001');
    await commit(first, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} first try`);
    await bundle(first, '01K6HANDOFF000000000000001');
    expect(await handoff()(request({ runId: '01K6HANDOFF000000000000001' }))).toMatchObject({ ok: true });
    const firstTip = remoteSha(`refs/heads/${BRANCH}`);

    // The retry resumes the branch, rewrites it, and hands it back.
    const retry = await run('01K6HANDOFF000000000000002');
    expect(retry.resumed).toBe(true);
    fixerGit(retry, ['reset', '--quiet', '--hard', retry.expectedBase]);
    const rewritten = await commit(retry, { 'src/cart.ts': 'export const total = 4;\n' }, `${KEY} second try`);
    await bundle(retry, '01K6HANDOFF000000000000002');

    const notOurs = refused(await handoff()(request({ runId: '01K6HANDOFF000000000000002' })));
    expect(notOurs).toMatch(/has commits this run does not build on/);
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBe(firstTip);

    expect(await handoff()(request({ runId: '01K6HANDOFF000000000000002', pushedBefore: [BRANCH] }))).toEqual({ ok: true, branch: BRANCH, sha: rewritten, prNumber: 1 });
    expect(remoteSha(`refs/heads/${BRANCH}`)).toBe(rewritten);
    expect(pulls).toHaveLength(1);
  });

  it('refuses when the branch changed on GitHub after the cache looked (the lease), pushing nothing over it', async () => {
    const p = await run();
    await commit(p, { 'src/cart.ts': 'export const total = 2;\n' }, `${KEY} fix`);
    await bundle(p);
    // Someone else creates the branch while the hand-off is checking: the push must not replace it.
    let asked = 0;
    const r = await handoff()(
      request({
        running: async () => {
          asked += 1;
          if (asked === 2) {
            const other = join(scratch, 'other');
            git(scratch, ['clone', '--quiet', origin.url, other]);
            execFileSync('git', ['commit', '--quiet', '--allow-empty', '-m', 'someone else'], { cwd: other, env: GIT_ENV });
            git(other, ['push', '--quiet', 'origin', `HEAD:refs/heads/${BRANCH}`]);
          }
          return true;
        },
      }),
    );
    expect(refused(r)).toMatch(/changed on GitHub during the hand-off/);
    expect(git(origin.url, ['log', '-1', '--format=%s', `refs/heads/${BRANCH}`])).toBe('someone else');
  });
});
