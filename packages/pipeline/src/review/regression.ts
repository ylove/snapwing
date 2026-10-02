// src/review/regression.ts: regression proof (main 11.1). The review agent must confirm the fixer's test
// fails without the fix. proveRegression builds a scratch worktree at the base with only the head's test
// files applied and runs the test command (it must fail), then runs it at the head (it must pass).
// Every outcome is a typed result; nothing here throws for a bad input, a failing command, or a timeout.

import { spawn, execFile } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseDuration } from '../util/duration.ts';
import { isTestFile } from './verdict.ts';

export type RegressionStatus =
  | 'proven' // fails at base with the head's tests, passes at head
  | 'passes-without-fix' // the test command passed at the base: the test does not prove the fix
  | 'fails-with-fix' // the test command failed at the head
  | 'missing-test-file' // a named test file is not in the head commit
  | 'no-test-files' // testFiles was empty
  | 'timeout' // a run exceeded the timeout; `phase` says which
  | 'git-error'; // a revision, worktree, or timeout-value problem; `output` carries the message

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

function git(cwd: string, args: string[]): Promise<{ ok: boolean; out: string }> {
  return new Promise((resolve) => {
    execFile('git', args, { cwd, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}`.trim() || (err ? err.message : '') });
    });
  });
}

function tail(text: string): string {
  return text.length <= MAX_RUN_OUTPUT ? text : `[truncated]\n${text.slice(text.length - MAX_RUN_OUTPUT)}`;
}

function runCommand(command: string, cwd: string, timeoutMs: number): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let buf = '';
    let timedOut = false;
    let settled = false;
    const child = spawn(command, { cwd, shell: true, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
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

  let scratchRoot: string | undefined;
  const added: string[] = [];
  try {
    scratchRoot = await mkdtemp(join(tmpdir(), 'snapwing-regression-'));
    const baseTree = join(scratchRoot, 'base');
    const headTree = join(scratchRoot, 'head');

    const addBase = await git(workdir, ['worktree', 'add', '--detach', baseTree, baseSha]);
    if (!addBase.ok) return result('git-error', `worktree at base failed: ${addBase.out}`);
    added.push(baseTree);
    const apply = await git(baseTree, ['checkout', headSha, '--', ...testFiles]);
    if (!apply.ok) return result('git-error', `applying test files failed: ${apply.out}`);

    const base = await runCommand(testCommand, baseTree, timeoutMs);
    const baseLabel = `--- at base ${baseSha.slice(0, 12)} with head tests (exit ${base.exitCode ?? 'none'}) ---\n${base.output}`;
    if (base.timedOut) return result('timeout', baseLabel, { phase: 'base' });
    if (base.exitCode === 0) return result('passes-without-fix', baseLabel);

    const addHead = await git(workdir, ['worktree', 'add', '--detach', headTree, headSha]);
    if (!addHead.ok) return result('git-error', `worktree at head failed: ${addHead.out}`, { failsWithoutFix: true });
    added.push(headTree);

    const head = await runCommand(testCommand, headTree, timeoutMs);
    const output = `${baseLabel}\n--- at head ${headSha.slice(0, 12)} (exit ${head.exitCode ?? 'none'}) ---\n${head.output}`;
    if (head.timedOut) return result('timeout', output, { failsWithoutFix: true, phase: 'head' });
    if (head.exitCode !== 0) return result('fails-with-fix', output, { failsWithoutFix: true });
    return result('proven', output, { failsWithoutFix: true, passesWithFix: true });
  } catch (e) {
    return result('git-error', e instanceof Error ? e.message : String(e));
  } finally {
    for (const tree of added) await git(workdir, ['worktree', 'remove', '--force', tree]);
    if (scratchRoot) await rm(scratchRoot, { recursive: true, force: true }).catch(() => undefined);
    await git(workdir, ['worktree', 'prune']);
  }
}
