// GitHub-backed RepoTrees (main 15.3, #375, #377): every file path in a map repo at its default branch,
// for the resolve step's file-path match. Read-only (`contents: read`, one repository per token), through
// the default branch's tree sha and the git trees API with `recursive=1`. Trees are cached per repo, so a
// burst of captures reads each tree once; a failure is cached briefly and reads as undefined (the step
// then treats the repo as unknown).
// `RepoTrees` stays an interface: a local-checkout source plugs into the engine the same way.

import type { RepoTrees } from '@snapwing/pipeline/resolve/paths.ts';
import { GitHubApiError, errorMessage, type GitHubAuth } from './auth.ts';
import { repoFullName } from './repo.ts';

export interface GitHubRepoTreesOptions {
  fetch?: typeof fetch;
  /** Default `https://api.github.com`. */
  apiBase?: string;
  /** How long a read tree is reused. Default ten minutes. */
  ttlMs?: number;
  /** How long a failed read answers undefined before trying again. Default one minute. */
  failureTtlMs?: number;
  now?: () => number;
}

export const REPO_TREE_TTL_MS = 10 * 60 * 1000;
export const REPO_TREE_FAILURE_TTL_MS = 60 * 1000;

interface Entry {
  paths: Promise<readonly string[] | undefined>;
  expiresAt: number;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function createGitHubRepoTrees(auth: GitHubAuth, options: GitHubRepoTreesOptions = {}): RepoTrees {
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const ttl = options.ttlMs ?? REPO_TREE_TTL_MS;
  const failureTtl = options.failureTtlMs ?? REPO_TREE_FAILURE_TTL_MS;
  const now = options.now ?? Date.now;
  const cache = new Map<string, Entry>();

  async function get(repo: string, path: string): Promise<Record<string, unknown> | undefined> {
    const { token } = await auth.installationToken({ repo, permissions: { contents: 'read' } });
    const res = await doFetch(`${base}/repos/${repo}${path}`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new GitHubApiError(res.status, await errorMessage(res));
    return record(await res.json());
  }

  /**
   * Blob paths of the default branch's tree: the repo's default branch, its head commit's tree sha (so a
   * branch name with a slash never lands in the trees path), then the tree. A truncated tree (a very
   * large repo) gives what GitHub sent.
   */
  async function read(repo: string): Promise<readonly string[]> {
    const branch = (await get(repo, ''))?.['default_branch'];
    if (typeof branch !== 'string' || branch === '') throw new GitHubApiError(422, `${repo} has no default branch`);
    const encoded = branch.split('/').map(encodeURIComponent).join('/');
    const head = record(record((await get(repo, `/branches/${encoded}`))?.['commit'])?.['commit']);
    const sha = record(head?.['tree'])?.['sha'];
    if (typeof sha !== 'string' || sha === '') throw new GitHubApiError(422, `${repo} branch ${branch} has no tree`);
    const tree = (await get(repo, `/git/trees/${encodeURIComponent(sha)}?recursive=1`))?.['tree'];
    if (!Array.isArray(tree)) throw new GitHubApiError(422, `${repo} returned no tree`);
    const paths: string[] = [];
    for (const raw of tree) {
      const item = record(raw);
      if (item?.['type'] === 'blob' && typeof item['path'] === 'string') paths.push(item['path']);
    }
    return paths;
  }

  return (mapRepo) => {
    const repo = repoFullName(mapRepo);
    const at = now();
    const cached = cache.get(repo);
    if (cached !== undefined && cached.expiresAt > at) return cached.paths;
    const entry: Entry = { paths: Promise.resolve(undefined), expiresAt: at + ttl };
    entry.paths = read(repo).catch(() => {
      entry.expiresAt = now() + failureTtl;
      return undefined;
    });
    cache.set(repo, entry);
    return entry.paths;
  };
}
