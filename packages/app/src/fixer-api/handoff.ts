// src/fixer-api/handoff.ts: the server side of a fixer's hand-off (#262, main 10.2, main 16, B 9).
//
// A fixer holds no GitHub credential. It commits on its work branch and leaves a bundle of it
// (pipeline/src/fixer/workdir/handoff.ts); the server imports the bundle, checks it, and pushes it
// with a token of its own:
//
//   1. The run is still going (no stop, no end), checked before the import, again before the push,
//      and again before the pull request: a run stopped before the push pushes nothing.
//   2. The run record (`run.json`, written by the runner on the host and never mounted into a
//      container) names the repository, the work branch, the base, and the commit the work must
//      descend from. Nothing the fixer reports names any of them.
//   3. The bundle in the run's `out/` is opened without following a link or blocking on a FIFO, must
//      be a regular file within the size cap, and is copied into a server-owned directory. No git
//      command ever runs in the fixer's checkout, whose `.git/config` and hooks it controls.
//   4. The import runs in a server-owned bare cache of the repository (`<cache root>/<owner>/<name>.git`)
//      with hooks off (`core.hooksPath=/dev/null`), no system or global config
//      (`GIT_CONFIG_NOSYSTEM`, `GIT_CONFIG_GLOBAL=/dev/null`), and only the file transport for the
//      bundle. The cache first fetches the base, and the work branch when GitHub has it, with a read
//      token, so the bundle's prerequisite commit is there. Then `git bundle verify`; `git bundle
//      list-heads` must name exactly `refs/heads/<work branch>`, or the bundle is refused; and
//      `git fetch <bundle> +refs/heads/<work branch>:refs/heads/<work branch>`, checking every object.
//   5. Checks: the tip descends from the expected base (`merge-base --is-ancestor`), at least one
//      commit is new, every commit message on `base..tip` names the issue key, and the diff between
//      them touches no protected path (`.github/workflows/**`, a CODEOWNERS file anywhere,
//      `.github/settings.yml`), with renames counted on both sides.
//   6. Pushes exactly `refs/heads/<work branch>` with a token minted for this push alone
//      (`contents: write` on the one repository), as a compare-and-swap against what the cache just
//      fetched (`--force-with-lease`). A branch GitHub already has at the tip needs no push. Replacing
//      commits on GitHub (not a fast-forward) is allowed only for a branch the server pushed for an
//      earlier run of the same incident (a retry); anything else is refused.
//   7. `done` only: the open pull request from the branch into the base, else a new one, opened as
//      the App through the server's GitHub client.
//
// A refused check answers `{ ok: false, code: 'refused', reason }` before anything is pushed, and the
// reporter records nothing (409 `handoff-refused`). Git and GitHub failures throw. Imports into one
// repository's cache run one at a time in this process.

import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { chmod, lstat, mkdir, mkdtemp, open, rm, stat, writeFile } from 'node:fs/promises';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { HANDOFF_BUNDLE_FILE, readRunRecord, runLayout, type RunRecord } from '@snapwing/pipeline/fixer/workdir/handoff.ts';
import { askpassScript, isProtectedPath, messageNamesKey, TOKEN_ENV } from '@snapwing/pipeline/fixer/workdir/hooks.ts';
import type { GitHubPermissions } from '../github/auth.ts';
import { GitHubValidationError, type GitHubClient } from '../github/client.ts';
import type { FixerTarget } from './reporter.ts';

/** Largest bundle the server takes, in bytes. A fix is a few commits; anything near this is not one. */
export const MAX_BUNDLE_BYTES = 64 * 1024 * 1024;

/** What the reporter asks of the hand-off for a run's `done`, or a `failed` with partial work. */
export interface HandoffRequest {
  target: FixerTarget;
  runId: string;
  /** `done` pushes and opens the pull request; `failed` pushes the partial work only. */
  outcome: 'done' | 'failed';
  /** The fixer's summary, for the pull request's title and body. */
  summary: string;
  testsAdded: readonly string[];
  /** Work branches the server pushed for earlier runs of this incident: a retry may rewrite its own. */
  pushedBefore: readonly string[];
  /** True while the run is still the incident's running run, with no stop and no end after it. */
  running: () => Promise<boolean>;
}

export type HandoffResult =
  | { ok: true; branch: string; sha: string; prNumber?: number }
  | { ok: false; code: 'refused'; reason: string }
  | { ok: false; code: 'stopped' };

export type FixerHandoff = (request: HandoffRequest) => Promise<HandoffResult>;

export interface FixerHandoffDeps {
  /** The run's directory on this host (both runners: `<workdir root>/fixer/<runId>`). */
  runDir: (runId: string) => string;
  /** Server-owned directory for the per-repository caches; no container ever sees it. */
  cacheRoot: string;
  /** The URL to fetch from and push to for `owner/name`; default GitHub's. Tests use a local bare repo. */
  remoteUrl?: (repo: string) => string;
  /** An installation token for `repo` with `permissions`; `fresh` mints one for this use alone. */
  token: (repo: string, permissions: GitHubPermissions, fresh: boolean) => Promise<string>;
  github: (repo: string) => Pick<GitHubClient, 'findOpenPullRequest' | 'createPullRequest'>;
  /** Default `MAX_BUNDLE_BYTES`. */
  maxBundleBytes?: number;
}

/** The read token the cache fetches with; the push token is minted per push with `PUSH_PERMISSIONS`. */
export const FETCH_PERMISSIONS: GitHubPermissions = Object.freeze({ contents: 'read' });
export const PUSH_PERMISSIONS: GitHubPermissions = Object.freeze({ contents: 'write' });

const STOPPED: HandoffResult = { ok: false, code: 'stopped' };
const refused = (reason: string): HandoffResult => ({ ok: false, code: 'refused', reason });

class Refusal extends Error {}

export function createFixerHandoff(deps: FixerHandoffDeps): FixerHandoff {
  const cap = deps.maxBundleBytes ?? MAX_BUNDLE_BYTES;
  const remoteUrl = deps.remoteUrl ?? ((repo: string): string => `https://github.com/${repo}.git`);
  const tails = new Map<string, Promise<void>>();

  /** Runs `fn` after every earlier call for `key` has settled. */
  async function serial<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = tails.get(key) ?? Promise.resolve();
    let release: () => void = () => undefined;
    const mine = new Promise<void>((resolve) => (release = resolve));
    const tail = prev.then(() => mine);
    tails.set(key, tail);
    await prev;
    try {
      return await fn();
    } finally {
      release();
      if (tails.get(key) === tail) tails.delete(key);
    }
  }

  return async (req) => {
    if (!(await req.running())) return STOPPED;
    const dir = deps.runDir(req.runId);
    let record: RunRecord;
    try {
      record = await readRunRecord(dir);
    } catch (e) {
      return refused(`the run has no usable record (${message(e)})`);
    }
    if (record.runId !== req.runId) return refused('the run record names another run');
    return serial(record.repo, async () => {
      try {
        return await relay(req, record, dir);
      } catch (e) {
        if (e instanceof Refusal) return refused(e.message);
        throw e;
      }
    });
  };

  async function relay(req: HandoffRequest, record: RunRecord, dir: string): Promise<HandoffResult> {
    const { repo, branch, base, expectedBase, issueKey } = record;
    const ref = `refs/heads/${branch}`;
    await mkdir(join(deps.cacheRoot, 'tmp'), { recursive: true, mode: 0o700 });
    const own = await mkdtemp(join(deps.cacheRoot, 'tmp', 'handoff-'));
    try {
      const bundle = join(own, HANDOFF_BUNDLE_FILE);
      await copyBundle(runLayout(dir), bundle, cap);
      const cache = await ensureCache(join(deps.cacheRoot, repo.split('/')[0] ?? '', `${repo.split('/')[1] ?? ''}.git`), own);
      const git = cacheGit(cache, own);
      const url = remoteUrl(repo);
      const net = { url, askpass: await writeAskpass(own) };

      // The base, and the work branch when GitHub has it: the bundle's prerequisite and the lease.
      const fetchToken = await deps.token(repo, FETCH_PERMISSIONS, false);
      const heads = (await git.remote(net, fetchToken, ['ls-remote', '--heads', url, `refs/heads/${base}`, ref])).stdout;
      const listed = new Set(heads.split('\n').map((l) => l.split('\t')[1]).filter((r) => r !== undefined));
      if (!listed.has(`refs/heads/${base}`)) throw new Refusal(`the base ${base} is gone from ${repo}`);
      const tracking = `refs/snapwing/remote/${branch}`;
      const refspecs = [`+refs/heads/${base}:refs/snapwing/base/${base}`, ...(listed.has(ref) ? [`+${ref}:${tracking}`] : [])];
      await git.remote(net, fetchToken, ['fetch', '--quiet', '--no-tags', '--no-write-fetch-head', url, ...refspecs]);
      const onGitHub = listed.has(ref) ? await git.run(['rev-parse', '--verify', `${tracking}^{commit}`]) : undefined;

      // The bundle: valid against the cache, carrying exactly the work branch.
      const verify = await git.bundle(['bundle', 'verify', '--quiet', bundle]);
      if (verify.code !== 0) throw new Refusal(`the bundle does not apply to ${repo}: ${firstLine(verify.stderr)}`);
      const carried = (await git.run(['bundle', 'list-heads', bundle])).split('\n').filter((l) => l !== '').map((l) => l.split(' ')[1] ?? '');
      const others = carried.filter((r) => r !== ref);
      if (others.length > 0 || carried.length !== 1) throw new Refusal(`the bundle may carry ${ref} only, not ${others.length > 0 ? others.join(', ') : 'nothing'}`);
      const fetched = await git.bundle(['-c', 'fetch.fsckObjects=true', 'fetch', '--quiet', '--no-tags', '--no-write-fetch-head', '--no-recurse-submodules', bundle, `+${ref}:${ref}`]);
      if (fetched.code !== 0) throw new Refusal(`the bundle could not be imported: ${firstLine(fetched.stderr)}`);
      const tip = await git.run(['rev-parse', '--verify', `${ref}^{commit}`]);

      // The checks.
      const ancestor = await git.code(['merge-base', '--is-ancestor', expectedBase, tip]);
      if (ancestor !== 0) throw new Refusal(`the work on ${branch} does not build on the base commit ${expectedBase.slice(0, 12)}`);
      const commits = (await git.run(['log', '-z', '--no-color', '--format=%H%n%B', `${expectedBase}..${tip}`])).split('\0').filter((c) => c.trim() !== '');
      if (commits.length === 0) throw new Refusal(`nothing is committed on ${branch} beyond its base`);
      const unnamed = commits.filter((c) => !messageNamesKey(c.slice(c.indexOf('\n') + 1), issueKey)).map((c) => c.slice(0, 12));
      if (unnamed.length > 0) throw new Refusal(`commit ${unnamed.join(', ')} does not name ${issueKey} in its message`);
      const paths = (await git.run(['diff', '--no-ext-diff', '--no-textconv', '--no-renames', '--name-only', '-z', expectedBase, tip])).split('\0').filter((p) => p !== '');
      const touched = [...new Set(paths.filter(isProtectedPath))];
      if (touched.length > 0) throw new Refusal(`the work changes CI, CODEOWNERS, or branch protection files: ${touched.slice(0, 10).join(', ')}`);

      // The push: the work branch only, never past a stop, and only over what was just fetched.
      if (!(await req.running())) return STOPPED;
      if (onGitHub !== tip) {
        if (onGitHub !== undefined && !req.pushedBefore.includes(branch) && (await git.code(['merge-base', '--is-ancestor', onGitHub, tip])) !== 0) {
          throw new Refusal(`${branch} on GitHub has commits this run does not build on`);
        }
        const pushToken = await deps.token(repo, PUSH_PERMISSIONS, true);
        const pushed = await git.remote(net, pushToken, ['push', '--porcelain', '--no-verify', '--recurse-submodules=no', `--force-with-lease=${ref}:${onGitHub ?? ''}`, url, `${ref}:${ref}`], { allowFail: true });
        if (pushed.code !== 0) {
          if (/^!\t/m.test(pushed.stdout)) throw new Refusal(`${branch} changed on GitHub during the hand-off`);
          throw new Error(`push of ${branch} to ${repo} failed: ${firstLine(pushed.stderr)}`);
        }
      }
      if (req.outcome === 'failed') return { ok: true, branch, sha: tip };

      // The pull request, as the App.
      if (!(await req.running())) return STOPPED;
      const github = deps.github(repo);
      const open = (await github.findOpenPullRequest(branch, base)) ?? (await createPr(github, { branch, base, issueKey, summary: req.summary, testsAdded: req.testsAdded }));
      return { ok: true, branch, sha: tip, prNumber: open.number };
    } finally {
      await rm(own, { recursive: true, force: true });
    }
  }
}

// Private ----------------------------------------------------------------------------------------

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function firstLine(s: string): string {
  return s.trim().split('\n')[0] ?? '';
}

/**
 * Copies the run's bundle into `dest` (server-owned). The run's `out/` must be a real directory, and
 * the bundle a regular file of at most `cap` bytes, opened without following a link or waiting on a
 * FIFO; read with a bound, so a file still growing cannot pass the cap.
 */
async function copyBundle(layout: ReturnType<typeof runLayout>, dest: string, cap: number): Promise<void> {
  const out = await lstat(layout.out).catch(() => undefined);
  if (out === undefined || !out.isDirectory()) throw new Refusal('the run has no hand-off directory');
  let handle;
  try {
    handle = await open(layout.bundle, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') throw new Refusal('the run left no bundle of its work branch; the fixer must commit its change on it');
    throw new Refusal(code === 'ELOOP' ? 'the bundle is a link' : 'the bundle could not be opened');
  }
  try {
    const st = await handle.stat();
    if (!st.isFile()) throw new Refusal('the bundle is not a regular file');
    if (st.size > cap) throw new Refusal(`the bundle is larger than ${cap} bytes`);
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const chunk = Buffer.alloc(64 * 1024);
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      total += bytesRead;
      if (total > cap) throw new Refusal(`the bundle is larger than ${cap} bytes`);
      chunks.push(chunk.subarray(0, bytesRead));
    }
    await writeFile(dest, Buffer.concat(chunks), { mode: 0o600, flag: 'wx' });
  } finally {
    await handle.close();
  }
}

/** The environment of every git the hand-off runs: nothing of the server's but PATH and LANG. */
function cleanEnv(home: string, extra: Record<string, string> = {}): Record<string, string> {
  const env: Record<string, string> = {};
  for (const name of ['PATH', 'LANG'] as const) {
    const v = process.env[name];
    if (v !== undefined) env[name] = v;
  }
  return {
    ...env,
    HOME: home,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_REFLOG_ACTION: 'snapwing handoff',
    ...extra,
  };
}

/** Options every git in the cache gets first: hooks off, no detached maintenance. */
const CACHE_CONFIG = ['-c', `core.hooksPath=${devNull}`, '-c', 'gc.autoDetach=false', '-c', 'maintenance.autoDetach=false'];

interface Run {
  code: number;
  stdout: string;
  stderr: string;
}

function exec(args: string[], cwd: string, env: Record<string, string>): Promise<Run> {
  return new Promise((resolve, reject) => {
    execFile('git', args, { cwd, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err === null) resolve({ code: 0, stdout, stderr });
      else if (typeof err.code === 'number') resolve({ code: err.code, stdout, stderr });
      else reject(err);
    });
  });
}

/** Creates the bare cache once: no template (so no sample hooks), owned by the server's user only. */
async function ensureCache(path: string, home: string): Promise<string> {
  if (await stat(join(path, 'HEAD')).then((s) => s.isFile(), () => false)) return path;
  await mkdir(path, { recursive: true, mode: 0o700 });
  const r = await exec(['init', '--quiet', '--bare', '--template=', path], path, cleanEnv(home));
  if (r.code !== 0) throw new Error(`could not create the hand-off cache: ${firstLine(r.stderr)}`);
  return path;
}

async function writeAskpass(dir: string): Promise<string> {
  const path = join(dir, 'askpass');
  await writeFile(path, askpassScript(), { mode: 0o700 });
  await chmod(path, 0o700);
  return path;
}

/** The transport a remote URL needs: https for GitHub, file for a local path (tests); nothing else. */
function transportOf(url: string): 'https' | 'file' {
  if (url.startsWith('https://')) return 'https';
  if (/^[A-Za-z][A-Za-z0-9+.-]*:/.test(url) && !url.startsWith('file:')) throw new Error(`the hand-off pushes over https only, not ${url.split(':')[0] ?? ''}`);
  return 'file';
}

function cacheGit(cache: string, home: string) {
  const env = cleanEnv(home);
  const inCache = (args: string[], extra: Record<string, string> = env): Promise<Run> => exec([...CACHE_CONFIG, '--git-dir', cache, ...args], cache, extra);
  return {
    /** Trimmed stdout; throws on failure. */
    async run(args: string[]): Promise<string> {
      const r = await inCache(args);
      if (r.code !== 0) throw new Error(`git ${args[0] ?? ''} failed in the hand-off cache: ${firstLine(r.stderr)}`);
      return r.stdout.trim();
    },
    async code(args: string[]): Promise<number> {
      return (await inCache(args)).code;
    },
    /** With the bundle the only transport allowed. */
    bundle(args: string[]): Promise<Run> {
      return inCache(['-c', 'protocol.allow=never', '-c', 'protocol.file.allow=always', ...args]);
    },
    /** Against GitHub, with `token` answered by the askpass script from this process's environment only. */
    async remote(net: { url: string; askpass: string }, token: string, args: string[], options: { allowFail?: boolean } = {}): Promise<Run> {
      const transport = transportOf(net.url);
      const r = await inCache(['-c', 'protocol.allow=never', '-c', `protocol.${transport}.allow=always`, '-c', 'credential.helper=', ...args], { ...env, GIT_ASKPASS: net.askpass, [TOKEN_ENV]: token });
      if (r.code !== 0 && options.allowFail !== true) throw new Error(`git ${args[0] ?? ''} against ${net.url} failed: ${firstLine(r.stderr)}`);
      return r;
    },
  };
}

/** Opens the pull request as the App; when GitHub says one already exists (a race), finds it. */
async function createPr(
  github: Pick<GitHubClient, 'findOpenPullRequest' | 'createPullRequest'>,
  pr: { branch: string; base: string; issueKey: string; summary: string; testsAdded: readonly string[] },
): Promise<{ number: number }> {
  const subject = pr.summary.trim().split('\n')[0]?.trim() ?? '';
  const title = (subject === '' ? `${pr.issueKey}: fix from Snapwing` : subject.includes(pr.issueKey) ? subject : `${pr.issueKey}: ${subject}`).slice(0, 200);
  const tests = pr.testsAdded.length === 0 ? 'None listed.' : pr.testsAdded.slice(0, 50).map((t) => `- \`${t.replaceAll('`', '')}\``).join('\n');
  const body = [
    pr.summary.trim() === '' ? 'The fixer gave no summary.' : pr.summary.trim(),
    '',
    '**Tests added**',
    tests,
    '',
    `Opened by Snapwing for ${pr.issueKey} from the fixer's commits on \`${pr.branch}\`. Before pushing, Snapwing checked that every commit names ${pr.issueKey} and that no CI, CODEOWNERS, or branch protection file changed.`,
  ].join('\n');
  try {
    return await github.createPullRequest({ title, head: pr.branch, base: pr.base, body });
  } catch (e) {
    if (!(e instanceof GitHubValidationError)) throw e;
    const found = await github.findOpenPullRequest(pr.branch, pr.base);
    if (found === undefined) throw e;
    return found;
  }
}
