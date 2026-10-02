// src/review/regression.ts: regression proof (main 11.1). The review agent must confirm the fixer's test
// fails without the fix. proveRegression builds a scratch worktree at the base with only the head's test
// files applied and runs the test command (it must fail), then runs it at the head (it must pass).
// Every outcome is a typed result; nothing here throws for a bad input, a failing command, or a timeout.
//
// The test command is the pull request's own code, written by the fixer: untrusted (main 16). It runs
// without the server's environment (only PATH and LANG, plus the caller's `env`), with HOME and TMPDIR
// set to a fresh scratch directory (never the server user's home), with the host's system and global
// git config switched off, and with no askpass or credential helper. Its working directory is a
// scratch tree in the temp directory, refused if that lies in or above the server's own tree. This is
// the host path, for development; ADR 0017 puts it inside the runner's isolation boundary wherever
// real secrets are held. Each scratch
// tree is a fresh `clone --shared` of `workdir`, not a linked worktree: a linked worktree shares the
// repository's config, so a credential helper or an auth header there would reach the test command, and
// anything the test command writes to its config would reach the next git call in `workdir`. Our own git
// calls get the same bare environment and run no hooks.
//
// With a `runner` (the RunnerPort's `runTests`: docker, #234), the test command never runs on this host.
// Each tree is then a self-contained copy (`clone --local --no-hardlinks`: its own objects, no
// alternates pointing back at `workdir`, no remote), the runner exposes only that tree to the command,
// and the command gets only the caller's `env`. Our git calls build each tree before its run and never
// touch it afterwards, so nothing the command plants in a tree's `.git` ever runs here.

import { spawn, execFile } from 'node:child_process';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { createScratchHome, serverTreeConflict, type ScratchHome } from '../harness/untrusted-host.ts';
import type { TestRunner, TestRunResult } from '../ports/runner.ts';
import { parseDuration } from '../util/duration.ts';
import { ulid } from '../util/ulid.ts';
import { isTestFile } from './verdict.ts';

export type RegressionStatus =
  | 'proven' // fails at base with the head's tests, passes at head
  | 'passes-without-fix' // the test command passed at the base: the test does not prove the fix
  | 'fails-with-fix' // the test command failed at the head
  | 'missing-test-file' // a named test file is not in the head commit
  | 'no-test-files' // testFiles was empty
  | 'timeout' // a run exceeded the timeout; `phase` says which
  | 'git-error'; // a revision, worktree, or timeout-value problem, or a runner that could not run; `output` says which

export interface RegressionInput {
  /** A git repository (or worktree) holding both commits. Never modified: scratch worktrees live in the temp dir. */
  workdir: string;
  baseSha: string;
  headSha: string;
  /** Repository-relative paths of the head's test files. */
  testFiles: readonly string[];
  /** Shell command; exit 0 means the tests pass. Runs with the scratch worktree as its cwd. */
  testCommand: string;
  /** Per run: milliseconds or an ISO 8601 duration such as `PT5M`. */
  timeout: number | string;
  /**
   * Extra environment for the test command, for what the repository's tests need. The command gets
   * only PATH and LANG from the host plus these, and a scratch HOME and TMPDIR that these cannot
   * override; nothing else of `process.env`. Never
   * pass a secret or a checkout's git environment (`PreparedWorkdir.env` carries the git token).
   * With a `runner`, these are the command's whole extra environment inside the boundary.
   */
  env?: Readonly<Record<string, string>> | undefined;
  /**
   * Runs the test command inside the RunnerPort's isolation boundary instead of on this host (ADR
   * 0017). Absent: the host path above, for the `local` runner in development.
   */
  runner?: TestRunner | undefined;
}

export interface RegressionResult {
  status: RegressionStatus;
  failsWithoutFix: boolean;
  passesWithFix: boolean;
  /** Both runs' output, each labelled and truncated to its last MAX_RUN_OUTPUT characters. */
  output: string;
  /** Set when status is `missing-test-file`. */
  missingFiles?: string[];
  /** Set when status is `timeout`. */
  phase?: 'base' | 'head';
}

/** Largest slice of one run's output kept, from the end (failures print last). */
export const MAX_RUN_OUTPUT = 8 * 1024;

/** The paths among a diff's changed files that the review treats as tests (same rule as checkConstraints). */
export function selectTestFiles(changedFiles: readonly string[]): string[] {
  return changedFiles.filter(isTestFile);
}

interface RunOutcome {
  exitCode: number | null;
  timedOut: boolean;
  output: string;
}

/** Host variables the test command inherits; mirrors the harness adapters (docs/harness-generic.md section 7). */
const INHERITED_ENV = ['PATH', 'LANG'] as const;

/** Git with no host config, no prompts, no askpass, and no credential helper. Applied last, so `env` cannot undo it. */
const GIT_GUARD_ENV: Readonly<Record<string, string>> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_CONFIG_GLOBAL: devNull,
  GIT_TERMINAL_PROMPT: '0',
  // Set but empty: git then skips core.askPass and SSH_ASKPASS too.
  GIT_ASKPASS: '',
  // Command-line level config, which git reads last: an empty helper clears every helper set before it.
  GIT_CONFIG_COUNT: '1',
  GIT_CONFIG_KEY_0: 'credential.helper',
  GIT_CONFIG_VALUE_0: '',
};

/**
 * The test command's environment: the allowlisted host variables, the caller's `env`, then the
 * scratch HOME and TMPDIR, then the git guards. The last two win over `extra`.
 */
export function regressionEnv(
  scratch: Pick<ScratchHome, 'home' | 'tmp'>,
  extra: Readonly<Record<string, string>> = {},
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of INHERITED_ENV) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...extra, HOME: scratch.home, TMPDIR: scratch.tmp, ...GIT_GUARD_ENV };
}

/** Our own git calls: the same bare environment without HOME. */
function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'LANG', 'TMPDIR'] as const) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...GIT_GUARD_ENV };
}

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    // No hooks: a checkout must not run anything from the repository's or the host's hook directory.
    const argv = ['-c', `core.hooksPath=${devNull}`, ...args];
    execFile('git', argv, { cwd, env: gitEnv(), maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() || (err ? err.message : '') });
    });
  });
}

function tail(text: string): string {
  return text.length <= MAX_RUN_OUTPUT ? text : `[truncated]\n${text.slice(text.length - MAX_RUN_OUTPUT)}`;
}

function runCommand(command: string, cwd: string, env: Record<string, string>, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let buf = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, { cwd, env, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
    const keep = (chunk: Buffer): void => {
      // Bound memory: only the tail is ever reported.
      buf = (buf + chunk.toString('utf8')).slice(-MAX_RUN_OUTPUT * 2);
    };
    child.stdout?.on('data', keep);
    child.stderr?.on('data', keep);
    const finish = (exitCode: number | null, extra = ''): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ exitCode, timedOut, output: tail(buf + extra) });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      try {
        if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
      } catch {
        child.kill('SIGKILL');
      }
    }, timeoutMs);
    child.on('error', (e) => finish(null, `\n${e.message}`));
    // 'close' waits for the pipes; the group kill above also takes down grandchildren holding them open.
    child.on('close', (code) => finish(code));
  });
}

export async function proveRegression(input: RegressionInput): Promise<RegressionResult> {
  const { workdir, baseSha, headSha, testFiles, testCommand } = input;
  const result = (status: RegressionStatus, output: string, extra: Partial<RegressionResult> = {}): RegressionResult => ({
    status,
    failsWithoutFix: false,
    passesWithFix: false,
    output,
    ...extra,
  });

  let timeoutMs: number;
  try {
    timeoutMs = typeof input.timeout === 'number' ? input.timeout : parseDuration(input.timeout);
  } catch (e) {
    return result('git-error', `invalid timeout: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) return result('git-error', `invalid timeout: ${String(input.timeout)}`);

  if (testFiles.length === 0) return result('no-test-files', 'no test files given');

  const baseOk = await git(workdir, ['rev-parse', '--verify', '--quiet', `${baseSha}^{commit}`]);
  if (!baseOk.ok) return result('git-error', `base commit not found: ${baseSha}`);
  const headOk = await git(workdir, ['rev-parse', '--verify', '--quiet', `${headSha}^{commit}`]);
  if (!headOk.ok) return result('git-error', `head commit not found: ${headSha}`);

  const missing: string[] = [];
  for (const file of testFiles) {
    const unsafe = file.startsWith('/') || file.split('/').includes('..') || file.startsWith('-');
    const exists = !unsafe && (await git(workdir, ['cat-file', '-e', `${headSha}:${file}`])).ok;
    if (!exists) missing.push(file);
  }
  if (missing.length > 0) {
    return result('missing-test-file', `not in ${headSha}: ${missing.join(', ')}`, { missingFiles: missing });
  }

  let scratch: ScratchHome | undefined;
  try {
    scratch = await createScratchHome('regression');
    const conflict = serverTreeConflict(scratch.root);
    if (conflict !== undefined) return result('git-error', `scratch tree: ${conflict}`);
    const env = regressionEnv(scratch, input.env);
    const baseTree = join(scratch.root, 'base');
    const headTree = join(scratch.root, 'head');

    const isolated = input.runner;
    const run = (tree: string): Promise<RunOutcome> =>
      isolated === undefined ? runCommand(testCommand, tree, env, timeoutMs) : runIsolated(isolated, tree, testCommand, input.env, timeoutMs);

    const addBase = await scratchTree(workdir, baseTree, baseSha, isolated !== undefined);
    if (!addBase.ok) return result('git-error', `worktree at base failed: ${addBase.out}`);
    const apply = await git(baseTree, ['checkout', headSha, '--', ...testFiles]);
    if (!apply.ok) return result('git-error', `applying test files failed: ${apply.out}`);

    const base = await run(baseTree);
    const baseLabel = `--- at base ${baseSha.slice(0, 12)} with head tests (exit ${base.exitCode ?? 'none'}) ---\n${base.output}`;
    if (base.timedOut) return result('timeout', baseLabel, { phase: 'base' });
    if (base.exitCode === 0) return result('passes-without-fix', baseLabel);

    const addHead = await scratchTree(workdir, headTree, headSha, isolated !== undefined);
    if (!addHead.ok) return result('git-error', `worktree at head failed: ${addHead.out}`, { failsWithoutFix: true });

    const head = await run(headTree);
    const output = `${baseLabel}\n--- at head ${headSha.slice(0, 12)} (exit ${head.exitCode ?? 'none'}) ---\n${head.output}`;
    if (head.timedOut) return result('timeout', output, { failsWithoutFix: true, phase: 'head' });
    if (head.exitCode !== 0) return result('fails-with-fix', output, { failsWithoutFix: true });
    return result('proven', output, { failsWithoutFix: true, passesWithFix: true });
  } catch (e) {
    return result('git-error', e instanceof Error ? e.message : String(e));
  } finally {
    await scratch?.dispose();
  }
}

/** One run inside the runner's boundary. A runner that cannot run at all throws; the caller reports `git-error`. */
async function runIsolated(
  runner: TestRunner,
  checkout: string,
  command: string,
  env: Readonly<Record<string, string>> | undefined,
  timeoutMs: number,
): Promise<RunOutcome> {
  let r: TestRunResult;
  try {
    r = await runner.runTests({ runId: ulid(), checkout, command, timeoutMs, ...(env === undefined ? {} : { env: { ...env } }) });
  } catch (e) {
    throw new Error(`runner: ${e instanceof Error ? e.message : String(e)}`, { cause: e });
  }
  return { exitCode: r.timedOut ? null : r.exitCode, timedOut: r.timedOut, output: tail(r.output) };
}

/**
 * A self-contained checkout of `sha` at `dest` for a runner's boundary (the review agent's tree, #239):
 * its own objects and fresh config, no alternates, no remote, no hooks run while building it. The
 * caller runs nothing of git in it after the runner had it.
 */
export function isolatedTree(workdir: string, dest: string, sha: string): Promise<{ ok: boolean; out: string }> {
  return scratchTree(workdir, dest, sha, true);
}

/**
 * A checkout of `sha` at `dest` with its own fresh config: `clone --shared` borrows `workdir`'s objects
 * through an alternates file and copies none of its config, so nothing in `workdir`'s config (a
 * credential helper, an auth header, a remote URL with a token) is visible from the scratch tree.
 * `selfContained` (a runner's tree) copies the objects instead, so the tree works where `workdir`'s
 * path does not exist and the command cannot reach `workdir`'s object store through it.
 */
async function scratchTree(workdir: string, dest: string, sha: string, selfContained: boolean): Promise<{ ok: boolean; out: string }> {
  const share = selfContained ? ['--local', '--no-hardlinks'] : ['--shared'];
  const clone = await git(workdir, ['clone', '--quiet', ...share, '--no-checkout', '--', '.', dest]);
  if (!clone.ok) return clone;
  const removeRemote = await git(dest, ['remote', 'remove', 'origin']);
  if (!removeRemote.ok) return removeRemote;
  return git(dest, ['checkout', '--quiet', '--detach', sha]);
}
