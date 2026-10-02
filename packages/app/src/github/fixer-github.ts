// The GitHub side of the fixer's stop and failure paths (main 10.4): `FixerGitHub` from
// `@snapwing/pipeline/fixer/job.ts`, over the App's installation tokens.
//
//   markIncomplete(branch)  the branch's open pull request is marked draft and labeled
//                           `fixer-incomplete`; with none open, a draft pull request from the branch to
//                           the repository's default branch is opened with that label. Idempotent: a
//                           second call finds the draft it opened.
//   closePr(pr, comment)    comments on and closes the pull request; one already closed is left alone.

import type { FixerGitHub, FixerGitHubContext } from '@snapwing/pipeline/fixer/job.ts';
import type { GitHubAuth } from './auth.ts';
import { createGitHubClient, createGitHubTransport, type GitHubClientOptions } from './client.ts';
import { repoFullName } from './repo.ts';

/** The label a partial branch's draft pull request carries (main 10.4). */
export const FIXER_INCOMPLETE_LABEL = 'fixer-incomplete';

export type FixerGitHubOptions = Omit<GitHubClientOptions, 'repo'>;

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function parse(text: string): unknown {
  try {
    return text === '' ? undefined : (JSON.parse(text) as unknown);
  } catch {
    return undefined;
  }
}

export function createFixerGitHub(auth: GitHubAuth, options: FixerGitHubOptions = {}): FixerGitHub {
  return {
    async markIncomplete(branch: string, ctx: FixerGitHubContext): Promise<void> {
      const repo = repoFullName(ctx.repo);
      const owner = repo.slice(0, repo.indexOf('/'));
      const call = createGitHubTransport(auth, { ...options, repo });
      const client = createGitHubClient(auth, { ...options, repo });
      const open = await call({
        method: 'GET',
        path: `/repos/${repo}/pulls`,
        permissions: { pull_requests: 'read' },
        query: { state: 'open', head: `${owner}:${branch}`, per_page: 1 },
      });
      const existing = Array.isArray(parse(open.text)) ? (parse(open.text) as unknown[]) : [];
      const first = record(existing[0]);
      let number = typeof first['number'] === 'number' ? first['number'] : undefined;
      if (number !== undefined) {
        if (first['draft'] !== true) await client.markDraft(number);
      } else {
        const info = record(parse((await call({ method: 'GET', path: `/repos/${repo}`, permissions: { metadata: 'read' } })).text));
        const base = typeof info['default_branch'] === 'string' ? info['default_branch'] : 'main';
        const title = `${ctx.issueKey === undefined ? '' : `${ctx.issueKey}: `}incomplete fix (fixer did not finish)`;
        const created = await call({
          method: 'POST',
          path: `/repos/${repo}/pulls`,
          permissions: { pull_requests: 'write' },
          body: {
            title,
            head: branch,
            base,
            draft: true,
            body: 'The fixer stopped before it finished. This draft keeps its partial work for a human to pick up.',
          },
        });
        const pr = record(parse(created.text));
        number = typeof pr['number'] === 'number' ? pr['number'] : undefined;
        if (number === undefined) throw new Error(`GitHub opened no pull request for ${repo} ${branch}`);
      }
      await client.addLabels(number, [FIXER_INCOMPLETE_LABEL]);
    },

    async closePr(pr: number, comment: string, ctx: FixerGitHubContext): Promise<void> {
      const client = createGitHubClient(auth, { ...options, repo: repoFullName(ctx.repo) });
      const current = await client.getPullRequest(pr);
      if (current.state === 'closed') return;
      await client.closePullRequest(pr, comment);
    },
  };
}
