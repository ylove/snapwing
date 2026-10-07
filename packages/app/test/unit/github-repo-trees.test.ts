// The GitHub-backed RepoTrees (#377): the default branch's blob paths through the git trees API, read
// with a `contents: read` token for that one repo, cached per repo, and undefined when unreadable.

import { describe, expect, it } from 'vitest';
import type { GitHubAuth, InstallationTokenRequest } from '../../src/github/auth.ts';
import { createRepoTrees, REPO_TREE_FAILURE_TTL_MS, REPO_TREE_TTL_MS } from '../../src/github/repo-trees.ts';

function fakeAuth(): GitHubAuth & { requests: InstallationTokenRequest[] } {
  const requests: InstallationTokenRequest[] = [];
  return {
    requests,
    installationToken(request) {
      requests.push(request);
      return Promise.resolve({ token: 'test-installation-token', expiresAt: '2026-10-03T10:00:00Z' });
    },
  };
}

function fakeGitHub(repos: Record<string, { branch: string; tree: unknown[] } | number>) {
  const calls: string[] = [];
  const doFetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = new URL(String(input));
    calls.push(`${url.pathname}${url.search}`);
    expect(new Headers(init?.headers).get('authorization')).toBe('Bearer test-installation-token');
    const m = /^\/repos\/([^/]+\/[^/]+)(?:\/(branches|git\/trees)\/(.+))?$/.exec(url.pathname);
    const repo = m?.[1] === undefined ? undefined : repos[m[1]];
    if (repo === undefined || typeof repo === 'number') return Promise.resolve(Response.json({ message: 'Not Found' }, { status: typeof repo === 'number' ? repo : 404 }));
    if (m?.[2] === undefined) return Promise.resolve(Response.json({ default_branch: repo.branch }));
    if (m[2] === 'branches') {
      expect(decodeURIComponent(m[3] ?? '')).toBe(repo.branch);
      return Promise.resolve(Response.json({ name: repo.branch, commit: { sha: 'c0ffee', commit: { tree: { sha: 'tree-sha-1' } } } }));
    }
    expect(m[3]).toBe('tree-sha-1');
    expect(url.searchParams.get('recursive')).toBe('1');
    return Promise.resolve(Response.json({ sha: 'tree-sha-1', tree: repo.tree, truncated: false }));
  };
  return { calls, fetch: doFetch as typeof fetch };
}

const TREE = [
  { path: 'src', type: 'tree' },
  { path: 'src/cart/total.ts', type: 'blob' },
  { path: 'README.md', type: 'blob' },
  { path: 'vendor/lib', type: 'commit' },
];

describe('createRepoTrees', () => {
  it('reads the default branch tree of a map repo and keeps only file paths', async () => {
    const gh = fakeGitHub({ 'acme/web': { branch: 'main', tree: TREE } });
    const auth = fakeAuth();
    const trees = createRepoTrees(auth, { fetch: gh.fetch, apiBase: 'https://api.example.test' });
    expect(await trees('github.com/acme/web')).toEqual(['src/cart/total.ts', 'README.md']);
    expect(gh.calls).toEqual(['/repos/acme/web', '/repos/acme/web/branches/main', '/repos/acme/web/git/trees/tree-sha-1?recursive=1']);
    expect(auth.requests.every((r) => r.repo === 'acme/web' && JSON.stringify(r.permissions) === '{"contents":"read"}')).toBe(true);
  });

  it('caches a tree per repo for the TTL, sharing a read in flight', async () => {
    let t = 0;
    const gh = fakeGitHub({ 'acme/web': { branch: 'trunk/v2', tree: TREE } });
    const trees = createRepoTrees(fakeAuth(), { fetch: gh.fetch, apiBase: 'https://api.example.test', now: () => t });
    await Promise.all([trees('github.com/acme/web'), trees('acme/web')]);
    expect(gh.calls).toEqual(['/repos/acme/web', '/repos/acme/web/branches/trunk/v2', '/repos/acme/web/git/trees/tree-sha-1?recursive=1']);
    t += REPO_TREE_TTL_MS - 1;
    await trees('github.com/acme/web');
    expect(gh.calls).toHaveLength(3);
    t += 2;
    await trees('github.com/acme/web');
    expect(gh.calls).toHaveLength(6);
  });

  it('answers undefined for a repo it cannot read, and retries after the failure TTL', async () => {
    let t = 0;
    const gh = fakeGitHub({ 'acme/private': 403 });
    const trees = createRepoTrees(fakeAuth(), { fetch: gh.fetch, apiBase: 'https://api.example.test', now: () => t });
    expect(await trees('github.com/acme/private')).toBeUndefined();
    expect(await trees('github.com/acme/private')).toBeUndefined();
    expect(gh.calls).toHaveLength(1);
    t += REPO_TREE_FAILURE_TTL_MS + 1;
    expect(await trees('github.com/acme/private')).toBeUndefined();
    expect(gh.calls).toHaveLength(2);
  });
});
