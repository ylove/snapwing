// Contract tests for the GitHub pull request client and CODEOWNERS resolver. Payloads are shaped from GitHub's
// REST and GraphQL documentation (trimmed to the fields the client reads, tokens replaced with obvious fakes).

import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import type { JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import type { GitHubAuth, InstallationTokenRequest } from '../../src/github/auth.ts';
import {
  GitHubApiError,
  GitHubHeadMovedError,
  GitHubNotFoundError,
  GitHubNotMergeableError,
  GitHubRateLimitError,
  GitHubValidationError,
  REVIEW_CHECK_NAME,
  createGitHubClient,
} from '../../src/github/client.ts';
import { compilePattern, createCodeownersResolver, ownersForPath, parseCodeowners } from '../../src/github/codeowners.ts';

const API = 'https://api.github.com';
const REPO = 'octo-org/fixture-repo';
const R = `${API}/repos/${REPO}`;
const NOW = new Date('2026-10-02T12:00:00Z');

const tokenRequests: InstallationTokenRequest[] = [];
const auth: GitHubAuth = {
  async installationToken(request) {
    tokenRequests.push(request);
    return { token: 'ghs_test_installation', expiresAt: '2026-10-02T13:00:00Z' };
  },
};
const client = createGitHubClient(auth, { repo: REPO, now: () => NOW });

interface Seen {
  method: string;
  url: URL;
  authorization: string;
  body: unknown;
}
let seen: Seen[] = [];
async function record(request: Request): Promise<void> {
  const text = await request.text();
  seen.push({ method: request.method, url: new URL(request.url), authorization: request.headers.get('authorization') ?? '', body: text === '' ? undefined : (JSON.parse(text) as unknown) });
}

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  seen = [];
  tokenRequests.length = 0;
});
afterAll(() => server.close());

const pullPayload = {
  url: `${R}/pulls/418`,
  id: 1,
  node_id: 'PR_kwDOtest418',
  html_url: `https://github.com/${REPO}/pull/418`,
  number: 418,
  state: 'open',
  draft: false,
  merged: false,
  mergeable: true,
  title: 'WEB-1042: fix checkout total',
  body: 'Fixes the rounding bug.',
  user: { login: 'snapwing[bot]' },
  labels: [{ id: 5, name: 'fixer' }],
  requested_reviewers: [{ login: 'webDev1' }],
  head: { ref: 'snapwing/WEB-1042', sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e' },
  base: { ref: 'main', sha: 'a3f1' },
  additions: 41,
  deletions: 6,
  changed_files: 2,
};

describe('pull requests', () => {
  it('gets a pull request', async () => {
    server.use(http.get(`${R}/pulls/418`, async ({ request }) => (await record(request), HttpResponse.json(pullPayload))));
    const pr = await client.getPullRequest(418);
    expect(pr).toMatchObject({
      number: 418,
      nodeId: 'PR_kwDOtest418',
      state: 'open',
      draft: false,
      mergeable: true,
      headSha: '6dcb09b5b57875f334f61aebed695e2e4193db5e',
      headRef: 'snapwing/WEB-1042',
      baseRef: 'main',
      additions: 41,
      deletions: 6,
      changedFiles: 2,
      requestedReviewers: ['webDev1'],
      labels: ['fixer'],
    });
    expect(seen[0]?.authorization).toBe('Bearer ghs_test_installation');
    expect(tokenRequests[0]).toEqual({ repo: REPO, permissions: { pull_requests: 'read' } });
  });

  it('lists files with additions and deletions across pages', async () => {
    const file = (i: number) => ({ sha: `s${i}`, filename: `src/f${i}.ts`, status: 'modified', additions: i, deletions: 1, changes: i + 1 });
    server.use(
      http.get(`${R}/pulls/418/files`, ({ request }) => {
        const page = Number(new URL(request.url).searchParams.get('page'));
        return HttpResponse.json(page === 1 ? Array.from({ length: 100 }, (_, i) => file(i)) : [file(100)]);
      }),
    );
    const files = await client.listPullRequestFiles(418);
    expect(files).toHaveLength(101);
    expect(files[100]).toEqual({ filename: 'src/f100.ts', status: 'modified', additions: 100, deletions: 1, changes: 101 });
  });

  it('requests reviewers', async () => {
    server.use(http.post(`${R}/pulls/418/requested_reviewers`, async ({ request }) => (await record(request), HttpResponse.json(pullPayload, { status: 201 }))));
    await client.requestReviewers(418, { users: ['webDev1'], teams: ['web-owners'] });
    expect(seen[0]?.body).toEqual({ reviewers: ['webDev1'], team_reviewers: ['web-owners'] });
    expect(tokenRequests[0]?.permissions).toEqual({ pull_requests: 'write' });
  });

  it('creates a review pinned to a commit', async () => {
    server.use(
      http.post(`${R}/pulls/418/reviews`, async ({ request }) => (await record(request), HttpResponse.json({ id: 80, state: 'APPROVED', html_url: `https://github.com/${REPO}/pull/418#pullrequestreview-80` }))),
    );
    const review = await client.createReview(418, { event: 'APPROVE', body: 'Looks right.', commitId: 'abc123' });
    expect(review).toEqual({ id: 80, state: 'APPROVED', htmlUrl: `https://github.com/${REPO}/pull/418#pullrequestreview-80` });
    expect(seen[0]?.body).toEqual({ event: 'APPROVE', body: 'Looks right.', commit_id: 'abc123' });
  });

  it('adds labels', async () => {
    server.use(http.post(`${R}/issues/418/labels`, async ({ request }) => (await record(request), HttpResponse.json([{ id: 1, name: 'fixer-incomplete' }, { id: 2, name: 'fixer' }]))));
    expect(await client.addLabels(418, ['fixer-incomplete'])).toEqual(['fixer-incomplete', 'fixer']);
    expect(seen[0]?.body).toEqual({ labels: ['fixer-incomplete'] });
  });

  it('closes with a comment, comment first', async () => {
    server.use(
      http.post(`${R}/issues/418/comments`, async ({ request }) => (await record(request), HttpResponse.json({ id: 9, body: 'Stopped.' }, { status: 201 }))),
      http.patch(`${R}/pulls/418`, async ({ request }) => (await record(request), HttpResponse.json({ ...pullPayload, state: 'closed' }))),
    );
    await client.closePullRequest(418, 'Stopped by a human.');
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([`POST /repos/${REPO}/issues/418/comments`, `PATCH /repos/${REPO}/pulls/418`]);
    expect(seen[0]?.body).toEqual({ body: 'Stopped by a human.' });
    expect(seen[1]?.body).toEqual({ state: 'closed' });
  });

  it('marks a pull request draft through GraphQL using its node id', async () => {
    server.use(
      http.get(`${R}/pulls/418`, () => HttpResponse.json(pullPayload)),
      http.post(`${API}/graphql`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ data: { convertPullRequestToDraft: { pullRequest: { number: 418, isDraft: true } } } });
      }),
    );
    await client.markDraft(418);
    const gql = seen.find((s) => s.url.pathname === '/graphql');
    expect(gql?.body).toMatchObject({ variables: { id: 'PR_kwDOtest418' } });
    expect(JSON.stringify(gql?.body)).toContain('convertPullRequestToDraft');
  });

  it('deletes a branch, encoding each path segment', async () => {
    server.use(http.delete(`${R}/git/refs/heads/snapwing/WEB-1042`, async ({ request }) => (await record(request), new HttpResponse(null, { status: 204 }))));
    await client.deleteBranch('snapwing/WEB-1042');
    expect(seen[0]?.method).toBe('DELETE');
    expect(tokenRequests[0]?.permissions).toEqual({ contents: 'write' });
  });

  it('opens a revert pull request through GraphQL revertPullRequest', async () => {
    server.use(
      http.get(`${R}/pulls/418`, () => HttpResponse.json({ ...pullPayload, merged: true, state: 'closed' })),
      http.post(`${API}/graphql`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ data: { revertPullRequest: { revertPullRequest: { id: 'PR_kwDOrevert', number: 419, url: `https://github.com/${REPO}/pull/419` } } } });
      }),
    );
    const revert = await client.openRevertPullRequest(418, { title: 'Revert WEB-1042', draft: false });
    expect(revert).toEqual({ number: 419, url: `https://github.com/${REPO}/pull/419`, nodeId: 'PR_kwDOrevert' });
    const gql = seen.find((s) => s.url.pathname === '/graphql');
    expect(gql?.body).toMatchObject({ variables: { input: { pullRequestId: 'PR_kwDOtest418', title: 'Revert WEB-1042', draft: false } } });
    expect(JSON.stringify(gql?.body)).toContain('revertPullRequest');
  });

  it('maps a GraphQL NOT_FOUND to a not-found error and a GraphQL rate limit to a rate-limit error', async () => {
    server.use(http.get(`${R}/pulls/418`, () => HttpResponse.json(pullPayload)));
    server.use(http.post(`${API}/graphql`, () => HttpResponse.json({ data: null, errors: [{ type: 'NOT_FOUND', message: 'Could not resolve to a node' }] })));
    await expect(client.markDraft(418)).rejects.toBeInstanceOf(GitHubNotFoundError);
    server.use(http.post(`${API}/graphql`, () => HttpResponse.json({ data: null, errors: [{ type: 'RATE_LIMITED', message: 'API rate limit exceeded' }] }, { headers: { 'retry-after': '30' } })));
    await expect(client.markDraft(418)).rejects.toMatchObject({ retryAfterMs: 30_000 });
  });
});

describe('check runs', () => {
  const checkRun = { id: 4, name: REVIEW_CHECK_NAME, status: 'in_progress', conclusion: null, html_url: `https://github.com/${REPO}/runs/4` };

  it('creates the snapwing/review check run by default', async () => {
    server.use(http.post(`${R}/check-runs`, async ({ request }) => (await record(request), HttpResponse.json(checkRun, { status: 201 }))));
    const run = await client.createCheckRun({ headSha: 'abc123', status: 'in_progress', output: { title: 'Review', summary: 'Running' } });
    expect(run).toEqual({ id: 4, name: 'snapwing/review', status: 'in_progress', conclusion: null, htmlUrl: `https://github.com/${REPO}/runs/4` });
    expect(seen[0]?.body).toEqual({ name: 'snapwing/review', head_sha: 'abc123', status: 'in_progress', output: { title: 'Review', summary: 'Running' } });
    expect(tokenRequests[0]?.permissions).toEqual({ checks: 'write' });
  });

  it('updates a check run to completed', async () => {
    server.use(http.patch(`${R}/check-runs/4`, async ({ request }) => (await record(request), HttpResponse.json({ ...checkRun, status: 'completed', conclusion: 'success' }))));
    const run = await client.updateCheckRun(4, { status: 'completed', conclusion: 'success' });
    expect(run.conclusion).toBe('success');
    expect(seen[0]?.body).toEqual({ status: 'completed', conclusion: 'success' });
  });
});

describe('combinedStatus', () => {
  const SHA = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
  function serve(opts: { protection: unknown | 404; runs: unknown[]; statuses: unknown[] }): void {
    server.use(
      http.get(`${R}/branches/main/protection/required_status_checks`, () =>
        opts.protection === 404 ? HttpResponse.json({ message: 'Branch not protected' }, { status: 404 }) : HttpResponse.json(opts.protection as JsonBodyType),
      ),
      http.get(`${R}/commits/${SHA}/check-runs`, () => HttpResponse.json({ total_count: opts.runs.length, check_runs: opts.runs })),
      http.get(`${R}/commits/${SHA}/status`, () => HttpResponse.json({ state: 'pending', sha: SHA, statuses: opts.statuses })),
    );
  }
  const protection = { strict: true, contexts: ['ci/legacy'], checks: [{ context: 'unit', app_id: 15368 }, { context: 'snapwing/review', app_id: null }] };

  it('is success when every required check, from either source, is green', async () => {
    serve({
      protection,
      runs: [
        { id: 1, name: 'unit', status: 'completed', conclusion: 'success' },
        { id: 2, name: 'snapwing/review', status: 'completed', conclusion: 'neutral' },
        { id: 3, name: 'extra', status: 'completed', conclusion: 'failure' },
      ],
      statuses: [{ context: 'ci/legacy', state: 'success' }],
    });
    const status = await client.combinedStatus(SHA, 'main');
    expect(status.state).toBe('success');
    expect(status.required.map((r) => [r.name, r.state, r.source]).sort()).toEqual([
      ['ci/legacy', 'success', 'status'],
      ['snapwing/review', 'success', 'check-run'],
      ['unit', 'success', 'check-run'],
    ]);
    expect(status.all).toHaveLength(4);
    expect(tokenRequests.some((t) => t.permissions.administration === 'read')).toBe(true);
  });

  it('is pending while a required check is queued or has not reported', async () => {
    serve({ protection, runs: [{ id: 1, name: 'unit', status: 'in_progress', conclusion: null }], statuses: [{ context: 'ci/legacy', state: 'success' }] });
    const status = await client.combinedStatus(SHA, 'main');
    expect(status.state).toBe('pending');
    expect(status.required.find((r) => r.name === 'snapwing/review')).toEqual({ name: 'snapwing/review', state: 'pending', source: null });
  });

  it('is failure when a required check failed, and a rerun supersedes the earlier failure', async () => {
    serve({
      protection: { contexts: [], checks: [{ context: 'unit' }] },
      runs: [
        { id: 1, name: 'unit', status: 'completed', conclusion: 'failure' },
        { id: 7, name: 'unit', status: 'completed', conclusion: 'success' },
      ],
      statuses: [],
    });
    expect((await client.combinedStatus(SHA, 'main')).state).toBe('success');
    server.resetHandlers();
    serve({ protection: { contexts: ['ci/legacy'], checks: [] }, runs: [], statuses: [{ context: 'ci/legacy', state: 'error' }] });
    expect((await client.combinedStatus(SHA, 'main')).state).toBe('failure');
  });

  it('requires nothing on an unprotected branch', async () => {
    serve({ protection: 404, runs: [{ id: 1, name: 'unit', status: 'completed', conclusion: 'failure' }], statuses: [] });
    const status = await client.combinedStatus(SHA, 'main');
    expect(status).toMatchObject({ state: 'success', required: [] });
    expect(status.all).toEqual([{ name: 'unit', state: 'failure', source: 'check-run' }]);
  });
});

describe('merge', () => {
  const merged = { sha: 'ffee00', merged: true, message: 'Pull Request successfully merged' };

  it('squash merges pinned to the expected head sha with the installation token', async () => {
    server.use(http.put(`${R}/pulls/418/merge`, async ({ request }) => (await record(request), HttpResponse.json(merged))));
    const result = await client.mergePullRequest(418, { expectedHeadSha: 'abc123', commitTitle: 'WEB-1042: fix checkout total (#418)' });
    expect(result).toEqual({ merged: true, sha: 'ffee00', message: 'Pull Request successfully merged' });
    expect(seen[0]?.body).toEqual({ merge_method: 'squash', sha: 'abc123', commit_title: 'WEB-1042: fix checkout total (#418)' });
    expect(seen[0]?.authorization).toBe('Bearer ghs_test_installation');
    expect(tokenRequests[0]?.permissions).toEqual({ contents: 'write', pull_requests: 'write' });
  });

  it('uses a user-to-server token when one is passed, and mints no installation token', async () => {
    server.use(http.put(`${R}/pulls/418/merge`, async ({ request }) => (await record(request), HttpResponse.json(merged))));
    await client.mergePullRequest(418, { expectedHeadSha: 'abc123', userToken: 'ghu_test_user' });
    expect(seen[0]?.authorization).toBe('Bearer ghu_test_user');
    expect(tokenRequests).toHaveLength(0);
  });
});

describe('typed errors', () => {
  it('404 is GitHubNotFoundError', async () => {
    server.use(http.get(`${R}/pulls/9`, () => HttpResponse.json({ message: 'Not Found', documentation_url: 'https://docs.github.com/rest/pulls/pulls#get-a-pull-request' }, { status: 404 })));
    const err = await client.getPullRequest(9).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubNotFoundError);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).toMatchObject({ status: 404, message: 'GitHub API 404: Not Found' });
  });

  it('409 on merge is GitHubHeadMovedError', async () => {
    server.use(http.put(`${R}/pulls/418/merge`, () => HttpResponse.json({ message: 'Head branch was modified. Review and try the merge again.' }, { status: 409 })));
    await expect(client.mergePullRequest(418, { expectedHeadSha: 'stale' })).rejects.toBeInstanceOf(GitHubHeadMovedError);
  });

  it('405 on merge is GitHubNotMergeableError', async () => {
    server.use(http.put(`${R}/pulls/418/merge`, () => HttpResponse.json({ message: 'Pull Request is not mergeable' }, { status: 405 })));
    await expect(client.mergePullRequest(418, { expectedHeadSha: 'abc' })).rejects.toBeInstanceOf(GitHubNotMergeableError);
  });

  it('422 is GitHubValidationError carrying the field errors', async () => {
    server.use(
      http.post(`${R}/check-runs`, () =>
        HttpResponse.json({ message: 'Validation Failed', errors: [{ resource: 'CheckRun', code: 'missing_field', field: 'conclusion' }] }, { status: 422 }),
      ),
    );
    const err = await client.createCheckRun({ headSha: 'abc', status: 'completed' }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubValidationError);
    expect((err as GitHubValidationError).details).toEqual([{ resource: 'CheckRun', code: 'missing_field', field: 'conclusion' }]);
  });

  it('429 with Retry-After carries retryAfterMs', async () => {
    server.use(http.get(`${R}/pulls/418`, () => HttpResponse.json({ message: 'You have exceeded a secondary rate limit.' }, { status: 429, headers: { 'retry-after': '17' } })));
    const err = await client.getPullRequest(418).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubRateLimitError);
    expect((err as GitHubRateLimitError).retryAfterMs).toBe(17_000);
  });

  it('403 with an exhausted primary limit uses x-ratelimit-reset', async () => {
    const reset = String(NOW.getTime() / 1000 + 120);
    server.use(http.get(`${R}/pulls/418`, () => HttpResponse.json({ message: 'API rate limit exceeded for installation' }, { status: 403, headers: { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': reset } })));
    await expect(client.getPullRequest(418)).rejects.toMatchObject({ name: 'GitHubRateLimitError', status: 403, retryAfterMs: 120_000 });
  });

  it('403 secondary limit without headers defaults to 60 s, and a plain 403 is not a rate limit', async () => {
    server.use(http.get(`${R}/pulls/418`, () => HttpResponse.json({ message: 'You have exceeded a secondary rate limit. Please wait a few minutes.' }, { status: 403 })));
    await expect(client.getPullRequest(418)).rejects.toMatchObject({ retryAfterMs: 60_000 });
    server.use(http.get(`${R}/pulls/418`, () => HttpResponse.json({ message: 'Resource not accessible by integration' }, { status: 403 })));
    const err = await client.getPullRequest(418).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(GitHubApiError);
    expect(err).not.toBeInstanceOf(GitHubRateLimitError);
  });

  it('never puts a token in an error message', async () => {
    server.use(http.get(`${R}/pulls/418`, () => HttpResponse.json({ message: 'Bad credentials' }, { status: 401 })));
    const err = await client.getPullRequest(418).catch((e: unknown) => e);
    expect((err as Error).message).not.toContain('ghs_test_installation');
  });
});

describe('CODEOWNERS', () => {
  const file = [
    '# owners',
    '*       @org/everyone',
    '/docs/  @docs-team',
    '*.ts    @ts-owner',
    'packages/app/   @app-team @alice  # trailing comment',
    '/packages/app/src/github/client.ts @gh-owner',
    'packages/app/generated/*.ts',
    '',
  ].join('\n');

  it('resolves with last-match-wins', () => {
    const rules = parseCodeowners(file);
    expect(ownersForPath(rules, 'README.md')).toEqual(['@org/everyone']);
    expect(ownersForPath(rules, 'docs/guide/a.md')).toEqual(['@docs-team']);
    expect(ownersForPath(rules, 'tools/x.ts')).toEqual(['@ts-owner']);
    expect(ownersForPath(rules, 'packages/app/src/other.ts')).toEqual(['@app-team', '@alice']);
    expect(ownersForPath(rules, 'packages/app/src/github/client.ts')).toEqual(['@gh-owner']);
    // A pattern with no owners unsets ownership.
    expect(ownersForPath(rules, 'packages/app/generated/x.ts')).toEqual([]);
  });

  it('compiles gitignore-style patterns', () => {
    expect(compilePattern('*.js')('a/b/c.js')).toBe(true);
    expect(compilePattern('/build/')('build/x/y')).toBe(true);
    expect(compilePattern('/build/')('src/build/x')).toBe(false);
    expect(compilePattern('build/')('src/build/x')).toBe(true);
    expect(compilePattern('docs/*')('docs/a.md')).toBe(true);
    expect(compilePattern('docs/*')('docs/sub/a.md')).toBe(true);
    expect(compilePattern('src/**/test.ts')('src/a/b/test.ts')).toBe(true);
    expect(compilePattern('src/**/test.ts')('src/test.ts')).toBe(true);
    expect(compilePattern('abc/**')('abc/d/e')).toBe(true);
    expect(compilePattern('a?c.txt')('abc.txt')).toBe(true);
    expect(compilePattern('/README.md')('docs/README.md')).toBe(false);
  });

  it('fetches from .github/ first, then root, then docs/, and resolves per path', async () => {
    const asked: string[] = [];
    server.use(
      http.get(`${R}/contents/.github/CODEOWNERS`, () => (asked.push('.github'), HttpResponse.json({ message: 'Not Found' }, { status: 404 }))),
      http.get(`${R}/contents/CODEOWNERS`, () => (asked.push('root'), HttpResponse.json({ message: 'Not Found' }, { status: 404 }))),
      http.get(`${R}/contents/docs/CODEOWNERS`, ({ request }) => {
        asked.push(`docs accept=${request.headers.get('accept') ?? ''}`);
        return new HttpResponse(file, { headers: { 'content-type': 'text/plain' } });
      }),
    );
    const resolver = createCodeownersResolver(auth, { repo: REPO, ref: 'main' });
    const result = await resolver.codeownersFor(['README.md', 'packages/app/src/other.ts']);
    expect(asked).toEqual(['.github', 'root', 'docs accept=application/vnd.github.raw+json']);
    expect(result.source).toBe('docs/CODEOWNERS');
    expect(result.byPath).toEqual({ 'README.md': ['@org/everyone'], 'packages/app/src/other.ts': ['@app-team', '@alice'] });
    expect(result.owners).toEqual(['@org/everyone', '@app-team', '@alice']);
    expect(tokenRequests[0]?.permissions).toEqual({ contents: 'read' });
  });

  it('returns no owners when the repository has no CODEOWNERS, and rethrows other errors', async () => {
    server.use(http.get(`${R}/contents/*`, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })));
    const resolver = createCodeownersResolver(auth, { repo: REPO });
    expect(await resolver.codeownersFor(['a.ts'])).toEqual({ source: null, byPath: { 'a.ts': [] }, owners: [] });
    server.use(http.get(`${R}/contents/.github/CODEOWNERS`, () => HttpResponse.json({ message: 'Server Error' }, { status: 500 })));
    await expect(resolver.codeownersFor(['a.ts'])).rejects.toMatchObject({ status: 500 });
  });
});
