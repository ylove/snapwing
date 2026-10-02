// The reconciler's sources of truth (B 8, `ReconcileSources` in `@snapwing/pipeline/reconcile/job.ts`)
// over GitHub and Jira: what the webhooks would have said, asked directly.
//
//   prChecks(pr)      the base branch's required checks for the PR's current head (`combinedStatus`,
//                     never its vacuous combined state): green, red with the failing names, or pending.
//                     A base branch that requires no checks is never green (as the webhook and merge
//                     step read it), so it stays pending.
//   prState(pr)       open, closed, or merged with the merge commit (`GET /pulls/{n}`).
//   issueStatus(key)  the issue's status and, from its changelog, the last status change, with
//                     `byAgent` when the agent's own Jira account made it. Null for a deleted issue.

import { ciChecksOf } from '@snapwing/pipeline/merge/ci.ts';
import type { IssueStatus, PrChecks, PrRef, PrState, ReconcileSources } from '@snapwing/pipeline/reconcile/job.ts';
import type { GitHubAuth } from '../github/auth.ts';
import { createGitHubClient, createGitHubTransport, type GitHubClientOptions } from '../github/client.ts';
import { repoFullName } from '../github/repo.ts';
import type { JiraClient } from '../jira/client/client.ts';

export interface JiraChangelogAccess {
  baseUrl: string;
  email: string;
  apiToken: string;
  fetch?: typeof fetch;
}

export interface ReconcileSourcesOptions {
  github: GitHubAuth;
  githubOptions?: Omit<GitHubClientOptions, 'repo'>;
  /** The agent's own account (`myself`), so its transitions are marked `byAgent`. */
  jira: Pick<JiraClient, 'myself'>;
  /** Read access to an issue's changelog, which the Jira client does not expose. */
  jiraChangelog: JiraChangelogAccess;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function repoOf(pr: PrRef): string {
  if (pr.repo === undefined || pr.repo === '') throw new Error(`incident ${pr.incidentId} has a pull request but no repo`);
  return repoFullName(pr.repo);
}

export function createReconcileSources(options: ReconcileSourcesOptions): ReconcileSources {
  const ghOptions = options.githubOptions ?? {};
  let agentAccount: Promise<string> | undefined;
  const agent = (): Promise<string> => {
    agentAccount ??= options.jira.myself().then((m) => m.accountId);
    agentAccount.catch(() => (agentAccount = undefined));
    return agentAccount;
  };

  return {
    async prChecks(pr): Promise<PrChecks> {
      const client = createGitHubClient(options.github, { ...ghOptions, repo: repoOf(pr) });
      const current = await client.getPullRequest(pr.prNumber);
      const status = await client.combinedStatus(current.headSha, current.baseRef);
      const checks = ciChecksOf(status.required);
      if (checks.state === 'green') return { state: 'green', headSha: current.headSha };
      if (checks.state === 'red') return { state: 'red', headSha: current.headSha, failingChecks: checks.failingChecks };
      return { state: 'pending', headSha: current.headSha };
    },

    async prState(pr): Promise<PrState> {
      const repo = repoOf(pr);
      const call = createGitHubTransport(options.github, { ...ghOptions, repo });
      const res = await call({ method: 'GET', path: `/repos/${repo}/pulls/${pr.prNumber}`, permissions: { pull_requests: 'read' } });
      const body = record(JSON.parse(res.text) as unknown);
      const mergeCommitSha = str(body['merge_commit_sha']);
      if (body['merged'] === true && mergeCommitSha !== undefined) {
        const mergedAt = str(body['merged_at']);
        return { state: 'merged', mergeCommitSha, ...(mergedAt === undefined ? {} : { mergedAt }) };
      }
      return { state: body['state'] === 'closed' ? 'closed' : 'open' };
    },

    async issueStatus(key): Promise<IssueStatus | null> {
      const { baseUrl, email, apiToken } = options.jiraChangelog;
      const doFetch = options.jiraChangelog.fetch ?? ((input: Parameters<typeof fetch>[0], init?: RequestInit) => fetch(input, init));
      const url = `${baseUrl.replace(/\/+$/, '')}/rest/api/3/issue/${encodeURIComponent(key)}?fields=status&expand=changelog`;
      const res = await doFetch(url, {
        headers: { Authorization: `Basic ${Buffer.from(`${email}:${apiToken}`).toString('base64')}`, Accept: 'application/json' },
      });
      if (res.status === 404) return null;
      if (!res.ok) throw new Error(`jira issue ${key} answered ${res.status}`);
      const body = record(await res.json());
      const status = str(record(record(body['fields'])['status'])['name']);
      if (status === undefined) throw new Error(`jira issue ${key} has no status`);
      const histories = Array.isArray(record(body['changelog'])['histories']) ? (record(body['changelog'])['histories'] as unknown[]) : [];
      let last: { from: string; to: string; at: string; actorId?: string } | undefined;
      for (const raw of histories) {
        const h = record(raw);
        const at = str(h['created']);
        if (at === undefined) continue;
        const items = Array.isArray(h['items']) ? (h['items'] as unknown[]).map(record) : [];
        const change = items.find((i) => i['field'] === 'status');
        if (change === undefined) continue;
        if (last !== undefined && Date.parse(at) < Date.parse(last.at)) continue;
        const actorId = str(record(h['author'])['accountId']);
        last = { from: str(change['fromString']) ?? '', to: str(change['toString']) ?? '', at, ...(actorId === undefined ? {} : { actorId }) };
      }
      if (last === undefined) return { status };
      const byAgent = last.actorId !== undefined && last.actorId === (await agent());
      return { status, lastTransition: { ...last, byAgent } };
    },
  };
}
