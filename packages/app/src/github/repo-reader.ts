// Read-only GitHub RepoReader (main 8.1): code search and file contents through an installation token
// limited to `contents: read` on one repository. Nothing here writes.

import type { RepoReader, RepoSearchHit } from '@snapwing/pipeline/triage/scout.ts';
import { GitHubApiError, errorMessage } from './auth.ts';
import type { GitHubAuth } from './auth.ts';

export interface GitHubRepoReaderOptions {
  /** `owner/name`. */
  repo: string;
  /** Branch, tag, or sha for contents reads; default is the repository's default branch. */
  ref?: string;
  fetch?: typeof fetch;
  apiBase?: string;
  /** Search results per page, default 12. */
  perPage?: number;
}

const SNIPPET_CHARS = 200;

function record(value: unknown): Record<string, unknown> | undefined {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

export function createGitHubRepoReader(auth: GitHubAuth, options: GitHubRepoReaderOptions): RepoReader {
  const doFetch = options.fetch ?? fetch;
  const base = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const permissions = { contents: 'read' } as const;

  async function get(url: string, accept: string): Promise<unknown> {
    const { token } = await auth.installationToken({ repo: options.repo, permissions });
    const res = await doFetch(url, {
      headers: { Authorization: `Bearer ${token}`, Accept: accept, 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new GitHubApiError(res.status, await errorMessage(res));
    return res.json();
  }

  return {
    async search(query) {
      const q = encodeURIComponent(`${query} repo:${options.repo}`);
      const body = record(await get(`${base}/search/code?q=${q}&per_page=${options.perPage ?? 12}`, 'application/vnd.github.text-match+json'));
      const items = Array.isArray(body?.items) ? (body.items as unknown[]) : [];
      const hits: RepoSearchHit[] = [];
      for (const raw of items) {
        const item = record(raw);
        if (item === undefined || typeof item.path !== 'string') continue;
        const matches = Array.isArray(item.text_matches) ? (item.text_matches as unknown[]) : [];
        const fragment = record(matches[0])?.fragment;
        hits.push(typeof fragment === 'string' && fragment.trim() !== '' ? { path: item.path, snippet: fragment.trim().slice(0, SNIPPET_CHARS) } : { path: item.path });
      }
      return hits;
    },

    async read(path) {
      const encoded = path.split('/').map(encodeURIComponent).join('/');
      const ref = options.ref === undefined ? '' : `?ref=${encodeURIComponent(options.ref)}`;
      const body = record(await get(`${base}/repos/${options.repo}/contents/${encoded}${ref}`, 'application/vnd.github+json'));
      if (body === undefined || body.type !== 'file' || typeof body.content !== 'string' || body.encoding !== 'base64') {
        throw new GitHubApiError(422, `${path} is not a file with base64 content`);
      }
      return Buffer.from(body.content, 'base64').toString('utf8');
    },
  };
}
