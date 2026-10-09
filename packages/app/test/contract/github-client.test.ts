// Contract tests for the GitHub pull request client and CODEOWNERS resolver. Payloads are shaped from GitHub's
// REST and GraphQL documentation (trimmed to the fields the client reads, tokens replaced with obvious fakes).

import { readFileSync } from 'node:fs';
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
  COMPARE_FILE_LIMIT,
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
/** This App's id: `snapwing/review` counts only from its check runs (#264). */
const APP_ID = 900001;
/** GitHub Actions' app id, as branch protection names it for a workflow's check. */
const ACTIONS_APP_ID = 15368;
const client = createGitHubClient(auth, { repo: REPO, appId: APP_ID, now: () => NOW });

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

  it('lists the files of exactly one commit against the base, a renamed file with its old path (#264)', async () => {
    const head = '6dcb09b5b57875f334f61aebed695e2e4193db5e';
    server.use(
      http.get(`${R}/compare/:basehead`, async ({ request, params }) => {
        await record(request);
        expect(params['basehead']).toBe(`main...${head}`);
        return HttpResponse.json({
          status: 'ahead',
          ahead_by: 2,
          behind_by: 0,
          files: [
            { sha: 's1', filename: 'src/cart.ts', status: 'modified', additions: 3, deletions: 1, changes: 4 },
            { sha: 's2', filename: 'src/deploy.tf', previous_filename: 'infra/deploy.tf', status: 'renamed', additions: 0, deletions: 0, changes: 0 },
          ],
        });
      }),
    );
    const out = await client.compareFiles('main', head);
    expect(out).toEqual({
      files: [
        { filename: 'src/cart.ts', status: 'modified', additions: 3, deletions: 1, changes: 4 },
        { filename: 'src/deploy.tf', status: 'renamed', additions: 0, deletions: 0, changes: 0, previousFilename: 'infra/deploy.tf' },
      ],
      complete: true,
    });
    expect(tokenRequests[0]?.permissions).toEqual({ contents: 'read' });
  });

  it('says a comparison list of the most files GitHub returns may be cut short, and keeps a slashed base a ref', async () => {
    const file = (i: number) => ({ sha: `s${i}`, filename: `src/f${i}.ts`, status: 'modified', additions: 1, deletions: 0, changes: 1 });
    server.use(
      http.get(`${R}/compare/release/:basehead`, ({ params }) => {
        expect(params['basehead']).toBe('1.2...abc1234');
        return HttpResponse.json({ status: 'ahead', files: Array.from({ length: COMPARE_FILE_LIMIT }, (_, i) => file(i)) });
      }),
    );
    const out = await client.compareFiles('release/1.2', 'abc1234');
    expect(out.files).toHaveLength(COMPARE_FILE_LIMIT);
    expect(out.complete).toBe(false);
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
    // Recorded live: an App without issues: write is refused (422) a token that asks for it.
    expect(tokenRequests[0]?.permissions).toEqual({ pull_requests: 'write' });
  });

  it('closes with a comment, comment first', async () => {
    server.use(
      http.post(`${R}/issues/418/comments`, async ({ request }) => (await record(request), HttpResponse.json({ id: 9, body: 'Stopped.' }, { status: 201 }))),
      http.patch(`${R}/pulls/418`, async ({ request }) => (await record(request), HttpResponse.json({ ...pullPayload, state: 'closed' }))),
    );
    await client.closePullRequest(418, 'Stopped by a human.');
    expect(seen.map((s) => `${s.method} ${s.url.pathname}`)).toEqual([`POST /repos/${REPO}/issues/418/comments`, `PATCH /repos/${REPO}/pulls/418`]);
    expect(seen[0]?.body).toEqual({ body: 'Stopped by a human.' });
    expect(tokenRequests.every((t) => Object.keys(t.permissions).join() === 'pull_requests')).toBe(true);
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

  it('opens the revert as the person whose user-to-server token it is (#264); a person without access is a 403', async () => {
    server.use(
      http.get(`${R}/pulls/418`, () => HttpResponse.json({ ...pullPayload, merged: true, state: 'closed' })),
      http.post(`${API}/graphql`, async ({ request }) => {
        await record(request);
        return HttpResponse.json({ data: { revertPullRequest: { revertPullRequest: { id: 'PR_kwDOrevert', number: 419, url: `https://github.com/${REPO}/pull/419` } } } });
      }),
    );
    await client.openRevertPullRequest(418, { title: 'Revert WEB-1042', userToken: 'ghu_test_user' });
    expect(seen.find((s) => s.url.pathname === '/graphql')?.authorization).toBe('Bearer ghu_test_user');
    // The PR is read with the installation token; only the mutation is the person's.
    expect(tokenRequests.map((t) => t.permissions)).toEqual([{ pull_requests: 'read' }]);

    server.use(http.post(`${API}/graphql`, () => HttpResponse.json({ data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by user' }] })));
    await expect(client.openRevertPullRequest(418, { userToken: 'ghu_test_user' })).rejects.toMatchObject({ status: 403 });
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
  /** `rules`: the branch's rules from repository rulesets, or 404 (default: none). */
  function serve(opts: { protection: unknown | 404; rules?: unknown[] | 404; runs: unknown[]; statuses: unknown[] }): void {
    const rules = opts.rules ?? [];
    server.use(
      http.get(`${R}/branches/main/protection/required_status_checks`, () =>
        opts.protection === 404 ? HttpResponse.json({ message: 'Branch not protected' }, { status: 404 }) : HttpResponse.json(opts.protection as JsonBodyType),
      ),
      http.get(`${R}/rules/branches/main`, ({ request }) => {
        if (rules === 404) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
        // One page of rules; a later page is empty.
        return HttpResponse.json(Number(new URL(request.url).searchParams.get('page') ?? '1') === 1 ? (rules as JsonBodyType) : []);
      }),
      http.get(`${R}/commits/${SHA}/check-runs`, () => HttpResponse.json({ total_count: opts.runs.length, check_runs: opts.runs })),
      http.get(`${R}/commits/${SHA}/status`, () => HttpResponse.json({ state: 'pending', sha: SHA, statuses: opts.statuses })),
    );
  }
  const protection = { strict: true, contexts: ['ci/legacy'], checks: [{ context: 'unit', app_id: ACTIONS_APP_ID }, { context: 'snapwing/review', app_id: null }] };
  const actions = { id: ACTIONS_APP_ID, slug: 'github-actions' };
  const snapwing = { id: APP_ID, slug: 'snapwing' };
  const other = { id: 424242, slug: 'other-app' };

  it('is success when every required check, from either source, is green', async () => {
    serve({
      protection,
      runs: [
        { id: 1, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA, app: actions },
        { id: 2, name: 'snapwing/review', status: 'completed', conclusion: 'neutral', head_sha: SHA, app: snapwing },
        { id: 3, name: 'extra', status: 'completed', conclusion: 'failure', head_sha: SHA, app: actions },
      ],
      statuses: [{ context: 'ci/legacy', state: 'success' }],
    });
    const status = await client.combinedStatus(SHA, 'main');
    expect(status.state).toBe('success');
    expect(status.required.map((r) => [r.name, r.state, r.source, r.appId ?? null]).sort()).toEqual([
      ['ci/legacy', 'success', 'status', null],
      ['snapwing/review', 'success', 'check-run', APP_ID],
      ['unit', 'success', 'check-run', ACTIONS_APP_ID],
    ]);
    expect(status.all).toHaveLength(4);
    expect(tokenRequests.some((t) => t.permissions.administration === 'read')).toBe(true);
  });

  it('reads the recorded required_status_checks shape, a name in both contexts and checks counted once', async () => {
    const recorded = JSON.parse(readFileSync(new URL('../fixtures/github/required-status-checks.json', import.meta.url), 'utf8')) as unknown;
    serve({ protection: recorded, runs: [{ id: 1, name: 'snapwing/review', status: 'completed', conclusion: 'success', head_sha: SHA, app: snapwing }], statuses: [] });
    const status = await client.combinedStatus(SHA, 'main');
    expect(status.required).toEqual([{ name: 'snapwing/review', state: 'success', source: 'check-run', appId: APP_ID }]);
    expect(status.state).toBe('success');
  });

  it('is pending while a required check is queued or has not reported', async () => {
    serve({ protection, runs: [{ id: 1, name: 'unit', status: 'in_progress', conclusion: null, head_sha: SHA, app: actions }], statuses: [{ context: 'ci/legacy', state: 'success' }] });
    const status = await client.combinedStatus(SHA, 'main');
    expect(status.state).toBe('pending');
    expect(status.required.find((r) => r.name === 'snapwing/review')).toEqual({ name: 'snapwing/review', state: 'pending', source: null, appId: APP_ID });
  });

  describe('a required check counts only from the app that must report it, on exactly that sha (#264)', () => {
    it('snapwing/review from another app, or as a commit status, is not reported, even when branch protection lets any source report it', async () => {
      serve({
        protection: { contexts: ['snapwing/review'], checks: [{ context: 'snapwing/review', app_id: null }] },
        runs: [{ id: 9, name: 'snapwing/review', status: 'completed', conclusion: 'success', head_sha: SHA, app: actions }],
        statuses: [{ context: 'snapwing/review', state: 'success' }],
      });
      const status = await client.combinedStatus(SHA, 'main');
      expect(status.required).toEqual([{ name: 'snapwing/review', state: 'pending', source: null, appId: APP_ID }]);
      expect(status.state).toBe('pending');
    });

    it("another app's newer run of the same name neither passes nor hides the pinned app's own result", async () => {
      serve({
        protection: { contexts: [], checks: [{ context: 'unit', app_id: ACTIONS_APP_ID }, { context: 'snapwing/review', app_id: APP_ID }] },
        runs: [
          { id: 1, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: SHA, app: actions },
          { id: 2, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA, app: other },
          { id: 3, name: 'snapwing/review', status: 'completed', conclusion: 'failure', head_sha: SHA, app: snapwing },
          { id: 4, name: 'snapwing/review', status: 'completed', conclusion: 'success', head_sha: SHA, app: other },
        ],
        statuses: [{ context: 'unit', state: 'success' }],
      });
      const status = await client.combinedStatus(SHA, 'main');
      expect(status.required).toEqual([
        { name: 'unit', state: 'failure', source: 'check-run', appId: ACTIONS_APP_ID },
        { name: 'snapwing/review', state: 'failure', source: 'check-run', appId: APP_ID },
      ]);
      expect(status.state).toBe('failure');
    });

    it('a run reported for another sha does not count', async () => {
      serve({
        protection: { contexts: [], checks: [{ context: 'snapwing/review', app_id: null }] },
        runs: [{ id: 1, name: 'snapwing/review', status: 'completed', conclusion: 'success', head_sha: 'b'.repeat(40), app: snapwing }],
        statuses: [],
      });
      expect((await client.combinedStatus(SHA, 'main')).required).toEqual([{ name: 'snapwing/review', state: 'pending', source: null, appId: APP_ID }]);
    });

    it('a client without the App id never counts snapwing/review', async () => {
      serve({
        protection: { contexts: [], checks: [{ context: 'snapwing/review', app_id: null }] },
        runs: [{ id: 1, name: 'snapwing/review', status: 'completed', conclusion: 'success', head_sha: SHA, app: snapwing }],
        statuses: [],
      });
      const noAppId = createGitHubClient(auth, { repo: REPO, now: () => NOW });
      expect((await noAppId.combinedStatus(SHA, 'main')).required).toEqual([{ name: 'snapwing/review', state: 'pending', source: null }]);
    });

    it('a branch protected by rulesets alone: each required_status_checks rule counts, pinned to its integration_id', async () => {
      serve({
        protection: 404,
        rules: [
          { type: 'pull_request', parameters: { required_approving_review_count: 1 }, ruleset_source_type: 'Repository', ruleset_source: REPO, ruleset_id: 7 },
          {
            type: 'required_status_checks',
            parameters: {
              strict_required_status_checks_policy: false,
              required_status_checks: [{ context: 'unit', integration_id: ACTIONS_APP_ID }, { context: 'lint' }, { context: 'snapwing/review', integration_id: APP_ID }],
            },
            ruleset_source_type: 'Repository',
            ruleset_source: REPO,
            ruleset_id: 7,
          },
        ],
        runs: [
          { id: 1, name: 'unit', status: 'in_progress', conclusion: null, head_sha: SHA, app: actions },
          { id: 2, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA, app: other },
          { id: 3, name: 'snapwing/review', status: 'completed', conclusion: 'success', head_sha: SHA, app: snapwing },
        ],
        statuses: [{ context: 'lint', state: 'success' }],
      });
      const status = await client.combinedStatus(SHA, 'main');
      // CI still running is pending, never green, though another app reported the same name as passing.
      expect(status.required).toEqual([
        { name: 'unit', state: 'pending', source: 'check-run', appId: ACTIONS_APP_ID },
        { name: 'lint', state: 'success', source: 'status' },
        { name: 'snapwing/review', state: 'success', source: 'check-run', appId: APP_ID },
      ]);
      expect(status.state).toBe('pending');
      expect(tokenRequests.some((t) => t.permissions.metadata === 'read')).toBe(true);
    });

    it('classic protection only: the rulesets endpoint answering 404 requires nothing more', async () => {
      serve({
        protection: { contexts: [], checks: [{ context: 'unit', app_id: ACTIONS_APP_ID }] },
        rules: 404,
        runs: [{ id: 1, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA, app: actions }],
        statuses: [],
      });
      const status = await client.combinedStatus(SHA, 'main');
      expect(status.required).toEqual([{ name: 'unit', state: 'success', source: 'check-run', appId: ACTIONS_APP_ID }]);
      expect(status.state).toBe('success');
    });

    it('both: a ruleset pinning a check classic protection lets any source report keeps the pin; two different pins need both apps', async () => {
      const rule = (checks: unknown[]) => ({ type: 'required_status_checks', parameters: { required_status_checks: checks }, ruleset_source_type: 'Repository', ruleset_source: REPO, ruleset_id: 9 });
      serve({
        protection: { contexts: ['unit', 'e2e'], checks: [{ context: 'unit', app_id: null }, { context: 'e2e', app_id: other.id }] },
        rules: [rule([{ context: 'unit', integration_id: ACTIONS_APP_ID }, { context: 'e2e', integration_id: ACTIONS_APP_ID }])],
        runs: [
          { id: 1, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA, app: other },
          { id: 2, name: 'e2e', status: 'completed', conclusion: 'success', head_sha: SHA, app: other },
        ],
        statuses: [{ context: 'unit', state: 'success' }],
      });
      const first = await client.combinedStatus(SHA, 'main');
      // `unit` from another app or as a status does not count: the ruleset pins it to Actions.
      // `e2e` is pinned to two apps; only one has reported.
      expect(first.required).toEqual([
        { name: 'unit', state: 'pending', source: null, appId: ACTIONS_APP_ID },
        { name: 'e2e', state: 'success', source: 'check-run', appId: other.id },
        { name: 'e2e', state: 'pending', source: null, appId: ACTIONS_APP_ID },
      ]);
      expect(first.state).toBe('pending');

      server.resetHandlers();
      serve({
        protection: { contexts: ['unit', 'e2e'], checks: [{ context: 'unit', app_id: null }, { context: 'e2e', app_id: other.id }] },
        rules: [rule([{ context: 'unit', integration_id: ACTIONS_APP_ID }, { context: 'e2e', integration_id: ACTIONS_APP_ID }])],
        runs: [
          { id: 1, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA, app: actions },
          { id: 2, name: 'e2e', status: 'completed', conclusion: 'success', head_sha: SHA, app: other },
          { id: 3, name: 'e2e', status: 'completed', conclusion: 'success', head_sha: SHA, app: actions },
        ],
        statuses: [],
      });
      expect((await client.combinedStatus(SHA, 'main')).state).toBe('success');
    });

    it('a check branch protection lets any source report matches by name, from a check run or a status, as GitHub does', async () => {
      serve({
        protection: { contexts: ['lint', 'e2e'], checks: [{ context: 'lint', app_id: null }, { context: 'e2e' }] },
        runs: [{ id: 1, name: 'lint', status: 'completed', conclusion: 'success', head_sha: SHA, app: other }],
        statuses: [{ context: 'e2e', state: 'success' }],
      });
      const status = await client.combinedStatus(SHA, 'main');
      expect(status.required).toEqual([
        { name: 'lint', state: 'success', source: 'check-run' },
        { name: 'e2e', state: 'success', source: 'status' },
      ]);
    });
  });

  it('is failure when a required check failed, and a rerun supersedes the earlier failure', async () => {
    serve({
      protection: { contexts: [], checks: [{ context: 'unit' }] },
      runs: [
        { id: 1, name: 'unit', status: 'completed', conclusion: 'failure', head_sha: SHA },
        { id: 7, name: 'unit', status: 'completed', conclusion: 'success', head_sha: SHA },
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
