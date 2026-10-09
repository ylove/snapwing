// src/fixer/workdir/index.ts: prepares the fixer's checkout on the host (main 10.2, 10.3, 16, #262).
//
// `prepareWorkdir` makes `workdir` a checkout of `repo` on the work branch, ready for a harness:
//
//   1. `git init`; everything Snapwing keeps in the checkout goes under `.git/snapwing/`, which no
//      commit can include: the commit-msg hook (and, put there by the runners, the request and review).
//   2. Local config: `origin` with any credential stripped from its URL, the bot identity, no signing,
//      an empty `credential.helper` (so no helper from the host answers for it), and `core.hooksPath`
//      pointing at our hooks (so a host-wide hooks path cannot replace them).
//   3. Fetch the base (the remote's default branch when none is given) and the work branch when it
//      already exists on the remote (a retry run continues its branch); otherwise cut the branch from
//      the base.
//
// The token is used for those fetches only. It reaches git as `SNAPWING_GIT_TOKEN` in the environment
// of the runner's own git processes, read by an askpass script in a private temporary directory
// outside the checkout that is removed before this returns; it is never written to `.git/config`, the
// remote URL, or any file in the checkout. Git runs with the host's system and global config switched
// off and without the server's environment. The harness gets no credential at all: `env` in the result
// only switches the host's config off for it too. A fixer commits on the work branch and never pushes;
// the server pushes its work after checking it (handoff.ts, app/src/fixer-api/handoff.ts).

import { execFile } from 'node:child_process';
import { chmod, mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { devNull, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repoFullName } from '../../util/repo.ts';
import { askpassScript, commitMsgHook, TOKEN_ENV } from './hooks.ts';

export { isProtectedPath, messageNamesKey, PROTECTED_PATH_PATTERNS } from './hooks.ts';

export interface GitIdentity {
  name: string;
  email: string;
}

/** The identity fixer commits carry when the caller names none. */
export const DEFAULT_BOT_IDENTITY: GitIdentity = Object.freeze({
  name: 'snapwing[bot]',
  email: 'snapwing[bot]@users.noreply.github.com',
});

export interface PrepareWorkdirInput {
  /** `owner/name` of the target repository; the map's `github.com/owner/name` is reduced to it. */
  repo: string;
  /** The branch the pull request targets (handoff/@base); the remote's default branch when omitted. */
  base?: string | undefined;
  /** The work branch (handoff/@branch, else `fix/<issue key>`). */
  branch: string;
  /** The Jira key every commit message must contain. */
  issueKey: string;
  /** A GitHub App installation token scoped to `repo`, for the clone on the host only. */
  token: string;
  /** Absolute path of the checkout to create; it must be absent or empty. */
  workdir: string;
  /** The URL to clone; default `https://github.com/<repo>.git`. Tests point it at a local bare repo. */
  remoteUrl?: string;
  identity?: GitIdentity;
  /** Aborts the git processes (a Stop before clone, main 10.4). */
  signal?: AbortSignal;
}

export interface PreparedWorkdir {
  workdir: string;
  branch: string;
  /** The base actually used (the remote's default branch when the input named none). */
  base: string;
  /** The commit the base was at when fetched. */
  baseSha: string;
  /**
   * The commit the run's work must descend from, and the floor of its hand-off bundle: `baseSha` for
   * a new branch, and for a retry the merge base of `baseSha` and the remote work branch.
   */
  expectedBase: string;
  /** True when the work branch already existed on the remote and was checked out from there. */
  resumed: boolean;
  /** Environment the harness needs for git in this checkout: no host config, no prompts, no credential. */
  env: Record<string, string>;
}

export class WorkdirError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkdirError';
  }
}

const REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const ISSUE_KEY = /^[A-Z][A-Z0-9_]*-[1-9][0-9]*$/;
/** Branch names the hooks can embed safely; `git check-ref-format` then applies git's own rules. */
const BRANCH = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;

/** Directory under `.git` that holds what Snapwing adds to a checkout. */
export const SNAPWING_GIT_DIR = 'snapwing';

/** The environment a harness's git needs: the host's system and global config off, no prompts. */
export function harnessGitEnv(): Record<string, string> {
  return { GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: devNull, GIT_TERMINAL_PROMPT: '0' };
}

/** The bare git environment: no host config, no prompts, nothing of the server's environment. */
function baseGitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'LANG', 'TMPDIR'] as const) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return { ...env, ...harnessGitEnv() };
}

/**
 * `url` without any user name or password in it, so a credential never reaches `.git/config`. A local
 * path (tests) is returned as it is.
 */
export function withoutCredentials(url: string): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return url;
  }
  if (parsed.username === '' && parsed.password === '') return url;
  parsed.username = '';
  parsed.password = '';
  return parsed.toString();
}

interface Git {
  (args: string[], options?: { allowFail?: boolean }): Promise<{ code: number; stdout: string; stderr: string }>;
}

function gitIn(cwd: string, env: Record<string, string>, signal: AbortSignal | undefined): Git {
  return (args, options = {}) =>
    new Promise((resolvePromise, reject) => {
      execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (err, stdout, stderr) => {
        if (err === null) {
          resolvePromise({ code: 0, stdout, stderr });
          return;
        }
        const code = typeof err.code === 'number' ? err.code : -1;
        if (options.allowFail === true && code > 0) {
          resolvePromise({ code, stdout, stderr });
          return;
        }
        if (err.name === 'AbortError') {
          reject(err);
          return;
        }
        reject(new WorkdirError(`git ${args[0] ?? ''} failed: ${stderr.trim() || err.message}`));
      });
    });
}

async function assertEmptyDir(path: string): Promise<void> {
  try {
    if ((await readdir(path)).length > 0) throw new WorkdirError(`work directory ${path} is not empty`);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
  }
}

/** Checks the names before any of them reaches git or a hook script. */
export function validateWorkdirNames(input: Pick<PrepareWorkdirInput, 'repo' | 'branch' | 'issueKey' | 'base'>): void {
  if (!REPO.test(input.repo) || input.repo.split('/').some((part) => part === '.' || part === '..')) {
    throw new WorkdirError(`repo ${JSON.stringify(input.repo)} is not owner/name`);
  }
  if (!ISSUE_KEY.test(input.issueKey)) throw new WorkdirError(`issue key ${JSON.stringify(input.issueKey)} is not a Jira key`);
  for (const [what, name] of [['branch', input.branch], ['base', input.base]] as const) {
    if (name !== undefined && !BRANCH.test(name)) throw new WorkdirError(`${what} ${JSON.stringify(name)} is not an allowed branch name`);
  }
}

export async function prepareWorkdir(given: PrepareWorkdirInput): Promise<PreparedWorkdir> {
  // Incidents carry the map's `github.com/owner/name`; the checkout and its default URL want `owner/name`.
  const input: PrepareWorkdirInput = { ...given, repo: repoFullName(given.repo) };
  validateWorkdirNames(input);
  if (input.token === '') throw new WorkdirError('the git token is empty');
  const workdir = resolve(input.workdir);
  const identity = input.identity ?? DEFAULT_BOT_IDENTITY;
  const remoteUrl = input.remoteUrl ?? `https://github.com/${input.repo}.git`;
  await assertEmptyDir(workdir);
  await mkdir(workdir, { recursive: true });

  const hooksDir = join(workdir, '.git', SNAPWING_GIT_DIR, 'hooks');
  // The askpass script lives outside the checkout, only for as long as this function's git runs.
  const own = await mkdtemp(join(tmpdir(), 'snapwing-clone-'));
  try {
    const askpass = join(own, 'askpass');
    await writeFile(askpass, askpassScript(), { mode: 0o700 });
    await chmod(askpass, 0o700);
    // A fixed reflog message: fetch's default would copy its arguments, the URL among them, into `.git/logs`.
    const git = gitIn(workdir, { ...baseGitEnv(), GIT_ASKPASS: askpass, [TOKEN_ENV]: input.token, GIT_REFLOG_ACTION: 'snapwing prepare' }, input.signal);

    await git(['init', '--quiet']);
    await mkdir(hooksDir, { recursive: true });

    for (const name of ['branch', 'base'] as const) {
      const value = input[name];
      if (value !== undefined) await git(['check-ref-format', '--branch', value]);
    }

    const config: [string, string][] = [
      ['remote.origin.url', withoutCredentials(remoteUrl)],
      ['user.name', identity.name],
      ['user.email', identity.email],
      ['commit.gpgsign', 'false'],
      ['tag.gpgsign', 'false'],
      ['credential.helper', ''],
      ['core.hooksPath', hooksDir],
    ];
    for (const [key, value] of config) await git(['config', key, value]);

    let base = input.base;
    if (base === undefined) {
      const head = await git(['ls-remote', '--symref', remoteUrl, 'HEAD']);
      const match = /^ref: refs\/heads\/(\S+)\tHEAD$/m.exec(head.stdout);
      if (match?.[1] === undefined) throw new WorkdirError(`could not find the default branch of ${input.repo}`);
      base = match[1];
      validateWorkdirNames({ ...input, base });
    }
    if (base === input.branch) throw new WorkdirError(`the work branch ${input.branch} is the base`);

    const heads = await git(['ls-remote', '--heads', remoteUrl, `refs/heads/${base}`, `refs/heads/${input.branch}`]);
    const remoteHeads = new Set(heads.stdout.split('\n').map((line) => line.split('\t')[1]).filter((r) => r !== undefined));
    if (!remoteHeads.has(`refs/heads/${base}`)) throw new WorkdirError(`the base ${base} does not exist in ${input.repo}`);
    const resumed = remoteHeads.has(`refs/heads/${input.branch}`);

    // From the URL itself, so a credential in it serves these fetches and stays out of the config;
    // `--no-write-fetch-head` keeps it out of FETCH_HEAD too.
    const refspecs = [`+refs/heads/${base}:refs/remotes/origin/${base}`];
    if (resumed) refspecs.push(`+refs/heads/${input.branch}:refs/remotes/origin/${input.branch}`);
    await git(['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', remoteUrl, ...refspecs]);
    const baseSha = (await git(['rev-parse', '--verify', `refs/remotes/origin/${base}^{commit}`])).stdout.trim();

    let expectedBase = baseSha;
    if (resumed) {
      await git(['checkout', '--quiet', '-b', input.branch, `refs/remotes/origin/${input.branch}`]);
      const fork = await git(['merge-base', baseSha, `refs/remotes/origin/${input.branch}`], { allowFail: true });
      if (fork.code !== 0 || fork.stdout.trim() === '') throw new WorkdirError(`the work branch ${input.branch} shares no history with the base ${base}`);
      expectedBase = fork.stdout.trim();
    } else {
      await git(['checkout', '--quiet', '--no-track', '-b', input.branch, baseSha]);
    }
    await git(['config', `branch.${input.branch}.remote`, 'origin']);
    await git(['config', `branch.${input.branch}.merge`, `refs/heads/${input.branch}`]);

    // The hook last: nothing above commits, and an installed hook should only ever see the run.
    await writeHook(hooksDir, 'commit-msg', commitMsgHook(input.issueKey));

    return { workdir, branch: input.branch, base, baseSha, expectedBase, resumed, env: harnessGitEnv() };
  } finally {
    await rm(own, { recursive: true, force: true });
  }
}

async function writeHook(dir: string, name: string, script: string): Promise<void> {
  const path = join(dir, name);
  await writeFile(path, script, { mode: 0o755 });
  await chmod(path, 0o755);
}
