// The active monitor's deploy source over the GitHub Deployments API (A 4.5, B 8): what a missed
// `deployment_status` webhook would have said. Compose gives the monitor `createReconcileSources`,
// which until recently had no `deployments`, so a monitored incident sat at `merged` while the fixture had
// real deployments of its merge commit. Payloads are shaped from GitHub's REST documentation, trimmed
// to the fields the source reads.

import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { GitHubAuth, InstallationTokenRequest } from '../../src/github/auth.ts';
import { createReconcileSources } from '../../src/reconcile/sources.ts';

const API = 'https://api.github.com';
const REPO = 'fake-org/web';
const R = `${API}/repos/${REPO}`;
const MERGE = 'a'.repeat(40);
const LATER = 'b'.repeat(40);
const ELSEWHERE = 'c'.repeat(40);

const tokens: InstallationTokenRequest[] = [];
const auth: GitHubAuth = {
  installationToken(request) {
    tokens.push(request);
    return Promise.resolve({ token: 'test-installation-token', expiresAt: '2026-10-03T13:00:00Z' });
  },
};
const sources = createReconcileSources({
  github: auth,
  jira: { myself: () => Promise.resolve({ accountId: 'agent' }) } as never,
  jiraChangelog: { baseUrl: 'https://jira.example.test', email: 'agent@example.test', apiToken: 'test-token' },
});

interface Deployment {
  id: number;
  sha: string;
  environment: string;
  production_environment?: boolean;
  /** Newest first, as GitHub lists them. */
  statuses: { state: string; created_at: string }[];
}

const server = setupServer();
const compared: string[] = [];
const statusReads: number[] = [];
beforeAll(() => server.listen());
afterEach(() => {
  server.resetHandlers();
  tokens.length = 0;
  compared.length = 0;
  statusReads.length = 0;
});
afterAll(() => server.close());

/** GitHub with `deployments` (newest first); `later` contains the merge commit, `elsewhere` does not. */
function github(deployments: Deployment[]): void {
  server.use(
    http.get(`${R}/deployments`, () =>
      HttpResponse.json(deployments.map((d) => ({ id: d.id, sha: d.sha, ref: d.sha, environment: d.environment, production_environment: d.production_environment ?? false }))),
    ),
    http.get(`${R}/deployments/:id/statuses`, ({ params, request }) => {
      const d = deployments.find((x) => String(x.id) === params['id']);
      statusReads.push(Number(params['id']));
      const perPage = Number(new URL(request.url).searchParams.get('per_page') ?? '30');
      return HttpResponse.json((d?.statuses ?? []).slice(0, perPage).map((s, i) => ({ id: i + 1, state: s.state, environment: d?.environment, created_at: s.created_at })));
    }),
    http.get(`${R}/compare/:range`, ({ params }) => {
      const range = String(params['range']);
      compared.push(range);
      const [, head] = range.split('...');
      if (head === LATER) return HttpResponse.json({ status: 'ahead', ahead_by: 2, behind_by: 0 });
      return HttpResponse.json({ status: 'diverged', ahead_by: 1, behind_by: 3 });
    }),
  );
}

const ref = { incidentId: '01K6DEPLOYINC0000000000000', repo: `github.com/${REPO}`, mergeCommitSha: MERGE };

describe('createReconcileSources().deployments (the monitor deploy poll)', () => {
  it('finds the successful staging deployment of the merge commit, as the e2e deploy system makes it', async () => {
    github([{ id: 11, sha: MERGE, environment: 'staging', statuses: [{ state: 'success', created_at: '2026-10-03T12:40:00Z' }] }]);
    expect(await sources.deployments(ref)).toEqual([{ stage: 'staging', commitSha: MERGE, deploymentId: '11', deployedAt: '2026-10-03T12:40:00Z' }]);
    // Read with the deployments permission; no compare for the merge commit itself.
    expect(tokens.some((t) => t.permissions?.['deployments'] === 'read' && t.repo === REPO)).toBe(true);
    expect(compared).toEqual([]);
  });

  it('per stage the newest successful deployment that contains the merge; production by name or by the flag', async () => {
    github([
      { id: 25, sha: ELSEWHERE, environment: 'production', statuses: [{ state: 'success', created_at: '2026-10-03T12:59:00Z' }] },
      { id: 24, sha: LATER, environment: 'Production', statuses: [{ state: 'in_progress', created_at: '2026-10-03T12:58:00Z' }] },
      { id: 23, sha: LATER, environment: 'prod-eu', production_environment: true, statuses: [{ state: 'success', created_at: '2026-10-03T12:57:00Z' }] },
      { id: 22, sha: LATER, environment: 'staging', statuses: [{ state: 'success', created_at: '2026-10-03T12:50:00Z' }] },
      { id: 21, sha: MERGE, environment: 'staging', statuses: [{ state: 'success', created_at: '2026-10-03T12:40:00Z' }] },
      { id: 20, sha: LATER, environment: 'preview', statuses: [{ state: 'success', created_at: '2026-10-03T12:30:00Z' }] },
    ]);
    expect(await sources.deployments(ref)).toEqual([
      { stage: 'staging', commitSha: LATER, deploymentId: '22', deployedAt: '2026-10-03T12:50:00Z' },
      { stage: 'production', commitSha: LATER, deploymentId: '23', deployedAt: '2026-10-03T12:57:00Z' },
    ]);
    // One compare per distinct sha; the preview environment is no stage, so its status is never read.
    expect(compared.sort()).toEqual([`${MERGE}...${LATER}`, `${MERGE}...${ELSEWHERE}`]);
    expect(statusReads).not.toContain(20);
  });

  it('nothing deployed yet, a failed or pending deploy, or no repo: no stage', async () => {
    github([
      { id: 31, sha: MERGE, environment: 'staging', statuses: [{ state: 'failure', created_at: '2026-10-03T12:40:00Z' }] },
      { id: 30, sha: MERGE, environment: 'production', statuses: [] },
    ]);
    expect(await sources.deployments(ref)).toEqual([]);
    expect(await sources.deployments({ incidentId: ref.incidentId, mergeCommitSha: MERGE })).toEqual([]);
  });
});
