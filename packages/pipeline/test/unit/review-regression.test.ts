import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { MAX_RUN_OUTPUT, proveRegression, regressionEnv, selectTestFiles } from '../../src/review/regression.ts';

const fixtures = join(dirname(fileURLToPath(import.meta.url)), '..', 'fixtures', 'regression');

let root: string;
let repo: string;
let baseSha: string;
let headSha: string; // fix plus the test
let testOnlySha: string; // the test with no fix

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: repo,
    encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.com', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.com' },
  }).trim();
}

function put(fixture: string, dest: string): void {
  mkdirSync(dirname(join(repo, dest)), { recursive: true });
  copyFileSync(join(fixtures, fixture), join(repo, dest));
}

const CMD = 'node test/add.test.js';

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'regression-test-'));
  repo = join(root, 'repo');
  mkdirSync(repo);
  git('init', '-q', '-b', 'main');
  git('config', 'commit.gpgsign', 'false');
  put('add.buggy.js.txt', 'add.js');
  git('add', '-A');
  git('commit', '-q', '-m', 'seed the bug');
  baseSha = git('rev-parse', 'HEAD');

  // Test only: still buggy.
  put('add.test.js.txt', 'test/add.test.js');
  git('add', '-A');
  git('commit', '-q', '-m', 'add test');
  testOnlySha = git('rev-parse', 'HEAD');

  put('add.fixed.js.txt', 'add.js');
  git('add', '-A');
  git('commit', '-q', '-m', 'fix');
  headSha = git('rev-parse', 'HEAD');
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

const base = () => ({ workdir: repo, baseSha, headSha, testFiles: ['test/add.test.js'], testCommand: CMD, timeout: 20_000 });

describe('proveRegression', () => {
  it('proves a test that fails at the base and passes at the head', async () => {
    const r = await proveRegression(base());
    expect(r.status).toBe('proven');
    expect(r.failsWithoutFix).toBe(true);
    expect(r.passesWithFix).toBe(true);
    expect(r.output).toContain('expected 5, got -1');
    expect(r.output).toContain('ok');
  });

  it('cleans up its scratch worktrees and leaves the repository alone', async () => {
    // A private TMPDIR: other test files (review-job) run proofs in parallel in the shared one.
    const scratch = join(root, 'private-tmp');
    mkdirSync(scratch, { recursive: true });
    const r = await withProcessEnv({ TMPDIR: scratch }, () => proveRegression(base()));
    expect(r.status).toBe('proven');
    expect(git('worktree', 'list').split('\n')).toHaveLength(1);
    expect(git('status', '--porcelain')).toBe('');
    expect(readdirSync(scratch)).toEqual([]);
  });

  it('reports a test that passes without the fix', async () => {
    // Head is the test-only commit's parent-fixed variant: base already contains the fix.
    const r = await proveRegression({ ...base(), baseSha: headSha, headSha });
    expect(r.status).toBe('passes-without-fix');
    expect(r.failsWithoutFix).toBe(false);
    expect(r.passesWithFix).toBe(false);
  });

  it('reports a test that still fails at the head', async () => {
    const r = await proveRegression({ ...base(), headSha: testOnlySha });
    expect(r.status).toBe('fails-with-fix');
    expect(r.failsWithoutFix).toBe(true);
    expect(r.passesWithFix).toBe(false);
  });

  it('reports a missing test file without throwing', async () => {
    const r = await proveRegression({ ...base(), testFiles: ['test/add.test.js', 'test/nope.test.js'] });
    expect(r.status).toBe('missing-test-file');
    expect(r.missingFiles).toEqual(['test/nope.test.js']);
    expect(r.failsWithoutFix).toBe(false);
  });

  it('rejects paths that escape the repository as missing', async () => {
    const r = await proveRegression({ ...base(), testFiles: ['../outside.test.js'] });
    expect(r.status).toBe('missing-test-file');
  });

  it('reports an empty test file list', async () => {
    expect((await proveRegression({ ...base(), testFiles: [] })).status).toBe('no-test-files');
  });

  it('reports a timeout at the base, killing the process', async () => {
    const r = await proveRegression({ ...base(), testCommand: 'sleep 30', timeout: 300 });
    expect(r.status).toBe('timeout');
    expect(r.phase).toBe('base');
    expect(r.failsWithoutFix).toBe(false);
  });

  it('reports a timeout at the head, with an ISO duration', async () => {
    // Fails fast at the base (the buggy source), hangs at the head (the fixed source).
    const r = await proveRegression({
      ...base(),
      testCommand: 'grep -q "a + b" add.js && sleep 30; exit 1',
      timeout: 'PT0.4S',
    });
    expect(r.status).toBe('timeout');
    expect(r.phase).toBe('head');
    expect(r.failsWithoutFix).toBe(true);
  });

  it('reports unknown revisions and bad timeouts as typed results', async () => {
    expect((await proveRegression({ ...base(), baseSha: 'deadbeef'.repeat(5) })).status).toBe('git-error');
    expect((await proveRegression({ ...base(), headSha: 'nonexistent-ref' })).status).toBe('git-error');
    expect((await proveRegression({ ...base(), timeout: 'soon' })).status).toBe('git-error');
    expect((await proveRegression({ ...base(), timeout: 0 })).status).toBe('git-error');
    expect((await proveRegression({ ...base(), workdir: join(root, 'not-a-repo') })).status).toBe('git-error');
  });

  it('truncates long output to the tail', async () => {
    const r = await proveRegression({
      ...base(),
      testCommand: 'node -e "console.log(\'x\'.repeat(100000)); console.error(\'LAST-LINE\'); process.exit(1)"',
    });
    expect(r.status).toBe('fails-with-fix');
    expect(r.output.length).toBeLessThan(2 * MAX_RUN_OUTPUT + 400);
    expect(r.output).toContain('[truncated]');
    expect(r.output).toContain('LAST-LINE');
  });
});

/** Sets process.env entries for the length of `fn`, then restores them. */
async function withProcessEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return await fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('proveRegression environment (the test command is untrusted pull request code)', () => {
  it('does not show the test command the server environment, only the allowlist and env', async () => {
    const r = await withProcessEnv(
      { SNAPWING_REGRESSION_PROBE: 'server-only-value', SNAPWING_FIXER_TOKEN_SECRET: 'test-fixer-secret', GIT_ASKPASS: '/nonexistent/askpass' },
      () =>
        proveRegression({
          ...base(),
          env: { REPO_TEST_FLAG: 'from-input' },
          testCommand: 'echo "seen: probe=[$SNAPWING_REGRESSION_PROBE] flag=[$REPO_TEST_FLAG] home=[$HOME] askpass=[$GIT_ASKPASS]"; env; exit 1',
        }),
    );
    expect(r.status).toBe('fails-with-fix');
    expect(r.output).toContain('probe=[] flag=[from-input]');
    expect(r.output).toContain(`home=[${process.env['HOME'] ?? ''}]`);
    expect(r.output).toContain('askpass=[]');
    expect(r.output).not.toContain('server-only-value');
    expect(r.output).not.toContain('test-fixer-secret');
    expect(r.output).not.toContain('/nonexistent/askpass');

    const names = new Set([...r.output.matchAll(/^([A-Za-z_][A-Za-z0-9_]*)=/gm)].map((m) => m[1]));
    const allowed = new Set([...Object.keys(regressionEnv({ REPO_TEST_FLAG: 'x' })), 'PWD', 'OLDPWD', 'SHLVL', '_']);
    expect([...names].filter((n) => n !== undefined && !allowed.has(n))).toEqual([]);
    expect(names.has('PATH')).toBe(true);
  });

  it('builds the environment from PATH, HOME, LANG, TMPDIR, env, and the git guards only', () => {
    const env = withProcessEnvSync({ PATH: '/bin', HOME: '/home/x', LANG: 'C', TMPDIR: '/tmp/x', OTHER_SERVER_VALUE: 'nope' }, () =>
      regressionEnv({ NODE_ENV: 'test', GIT_ASKPASS: '/from/caller', GIT_CONFIG_GLOBAL: '/from/caller' }),
    );
    expect(env).toMatchObject({ PATH: '/bin', HOME: '/home/x', LANG: 'C', TMPDIR: '/tmp/x', NODE_ENV: 'test' });
    expect(env['OTHER_SERVER_VALUE']).toBeUndefined();
    // The caller's env cannot switch the git guards off.
    expect(env['GIT_ASKPASS']).toBe('');
    expect(env['GIT_CONFIG_GLOBAL']).not.toBe('/from/caller');
    expect(env['GIT_CONFIG_NOSYSTEM']).toBe('1');
    expect([env['GIT_CONFIG_KEY_0'], env['GIT_CONFIG_VALUE_0']]).toEqual(['credential.helper', '']);
  });

  it('gives the scratch tree a fresh git config: no helper or header from the repository or HOME, and no writes back', async () => {
    const home = join(root, 'fake-home');
    mkdirSync(home, { recursive: true });
    writeFileSync(join(home, '.gitconfig'), '[credential]\n\thelper = store --file=/nonexistent/home-creds\n');
    git('config', 'credential.helper', 'store --file=/nonexistent/repo-creds');
    git('config', 'http.extraHeader', 'X-Test-Header: not-a-secret');
    try {
      const r = await withProcessEnv({ HOME: home }, () =>
        proveRegression({
          ...base(),
          testCommand:
            'echo "helpers=[$(git config --get-all credential.helper | tr "\\n" ",")] header=[$(git config --get-all http.extraheader)]"; ' +
            'git config --local credential.helper written-by-test; exit 1',
        }),
      );
      expect(r.status).toBe('fails-with-fix');
      expect(r.output).toContain('helpers=[');
      expect(r.output).toContain('header=[]');
      expect(r.output).not.toContain('nonexistent');
      expect(r.output).not.toContain('X-Test-Header');
      expect(git('config', '--local', '--get-all', 'credential.helper')).toBe('store --file=/nonexistent/repo-creds');
    } finally {
      git('config', '--unset-all', 'credential.helper');
      git('config', '--unset-all', 'http.extraHeader');
    }
  });
});

function withProcessEnvSync<T>(vars: Record<string, string>, fn: () => T): T {
  const saved = Object.fromEntries(Object.keys(vars).map((k) => [k, process.env[k]]));
  Object.assign(process.env, vars);
  try {
    return fn();
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
}

describe('selectTestFiles', () => {
  it('keeps the paths the review treats as tests', () => {
    expect(selectTestFiles(['src/a.ts', 'test/unit/a.ts', 'src/a.test.ts', 'src/b.spec.js', 'src/__tests__/c.ts', 'docs/x.md'])).toEqual([
      'test/unit/a.ts',
      'src/a.test.ts',
      'src/b.spec.js',
      'src/__tests__/c.ts',
    ]);
  });
});
