// src/fixer/workdir/handoff.ts: how a fixer run hands its work back (main 10.2, main 16, #262).
//
// A fixer holds no GitHub credential and never pushes. Both runners lay out each run's directory on
// the host the same way:
//
//   <run dir>/work      the checkout the harness works in (the docker runner mounts it at `/work`)
//   <run dir>/out       where the run leaves its bundle (the docker runner mounts it at `/out`)
//   <run dir>/run.json  the run record: what the runner prepared on the host before the harness
//                       started. With docker it is never mounted, so nothing in the container can
//                       change it.
//
// When the harness ends with `done`, or `failed` with partial work, the image's wrapper (or the local
// runner, its equivalent on the host) writes `git bundle create out/work.bundle
// <expected base>..refs/heads/<work branch>` (`bundleWork`). The server then reads the record and a
// copy of the bundle, never the checkout, and imports, checks, and pushes the work itself
// (app/src/fixer-api/handoff.ts).

import { execFile } from 'node:child_process';
import { lstat, readFile, rm, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { harnessGitEnv, validateWorkdirNames, WorkdirError } from './index.ts';

/** The checkout, under the run directory. */
export const RUN_CHECKOUT_DIR = 'work';
/** Where the run leaves its bundle, under the run directory. */
export const RUN_OUT_DIR = 'out';
/** The run record, under the run directory. */
export const RUN_RECORD_FILE = 'run.json';
/** The bundle's name in the out directory. */
export const HANDOFF_BUNDLE_FILE = 'work.bundle';

export interface RunLayout {
  dir: string;
  checkout: string;
  out: string;
  bundle: string;
  record: string;
}

export function runLayout(dir: string): RunLayout {
  const out = join(dir, RUN_OUT_DIR);
  return { dir, checkout: join(dir, RUN_CHECKOUT_DIR), out, bundle: join(out, HANDOFF_BUNDLE_FILE), record: join(dir, RUN_RECORD_FILE) };
}

/** What the runner prepared for a run, as the server reads it back at the hand-off. */
export interface RunRecord {
  runId: string;
  /** `owner/name`. */
  repo: string;
  issueKey: string;
  /** The work branch: the only ref the hand-off may carry. */
  branch: string;
  /** The pull request's base. */
  base: string;
  /** The commit the work must descend from (`PreparedWorkdir.expectedBase`). */
  expectedBase: string;
}

const SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
const RUN_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Writes the record, readable by the server's user only. */
export async function writeRunRecord(dir: string, record: RunRecord): Promise<void> {
  await writeFile(runLayout(dir).record, `${JSON.stringify({ v: 1, ...record })}\n`, { mode: 0o600, flag: 'wx' });
}

/** Reads and checks the record of the run in `dir`; throws `WorkdirError` when it is missing or malformed. */
export async function readRunRecord(dir: string): Promise<RunRecord> {
  const path = runLayout(dir).record;
  const st = await lstat(path).catch(() => undefined);
  if (st === undefined || !st.isFile()) throw new WorkdirError('the run has no record');
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new WorkdirError('the run record is not JSON');
  }
  const r = typeof raw === 'object' && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
  const field = (name: string): string => {
    const v = r[name];
    if (typeof v !== 'string' || v === '') throw new WorkdirError(`the run record has no ${name}`);
    return v;
  };
  const record: RunRecord = {
    runId: field('runId'),
    repo: field('repo'),
    issueKey: field('issueKey'),
    branch: field('branch'),
    base: field('base'),
    expectedBase: field('expectedBase'),
  };
  if (r['v'] !== 1 || !RUN_ID.test(record.runId) || !SHA.test(record.expectedBase)) throw new WorkdirError('the run record is malformed');
  validateWorkdirNames(record);
  return record;
}

export interface BundleWorkInput {
  /** The checkout. */
  checkout: string;
  /** The work branch; only `refs/heads/<branch>` goes into the bundle. */
  branch: string;
  /** The commit the bundle starts after (`RunRecord.expectedBase`). */
  expectedBase: string;
  /** Where the bundle goes; anything already there is replaced. */
  file: string;
  /** Environment for git, for example PATH; the host's config is switched off on top of it. */
  env?: Readonly<Record<string, string>>;
}

/**
 * Writes the bundle of the work branch's commits since `expectedBase`. Throws `WorkdirError` when the
 * branch is gone or holds no commit beyond the base (git refuses an empty bundle).
 */
export async function bundleWork(input: BundleWorkInput): Promise<void> {
  // The checkout's own config still applies (it is the fixer's), but not its hooks or fsmonitor.
  const env = { ...input.env, ...harnessGitEnv() };
  const git = (args: string[]): Promise<string> =>
    new Promise((resolve, reject) => {
      execFile('git', ['-c', `core.hooksPath=${devNull}`, '-c', 'core.fsmonitor=false', ...args], { cwd: input.checkout, env, encoding: 'utf8', maxBuffer: 1024 * 1024 }, (err, stdout, stderr) => {
        if (err === null) resolve(stdout.trim());
        else reject(new WorkdirError(`git ${args[0] ?? ''} failed: ${stderr.trim().split('\n')[0] ?? err.message}`));
      });
    });
  const ref = `refs/heads/${input.branch}`;
  const tip = await git(['rev-parse', '--verify', '--quiet', `${ref}^{commit}`]).catch(() => '');
  if (tip === '') throw new WorkdirError(`the work branch ${input.branch} is gone`);
  const count = Number(await git(['rev-list', '--count', `${input.expectedBase}..${ref}`]));
  if (!(count > 0)) throw new WorkdirError(`nothing is committed on ${input.branch} beyond its base`);
  await rm(input.file, { force: true });
  await git(['bundle', 'create', '--quiet', input.file, `${input.expectedBase}..${ref}`]);
}
