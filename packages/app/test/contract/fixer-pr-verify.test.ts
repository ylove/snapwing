// Verification of the pull request a fixer reports (#267): the head is the run's work branch, the base
// is the requested one, the head repository is the incident's own, and the App opened it.

import { describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { Artifact } from '@snapwing/pipeline/contracts/state.ts';
import { buildImplementationRequest } from '@snapwing/pipeline/prompts/implementation-request.ts';
import { GitHubNotFoundError, type PullRequest } from '../../src/github/client.ts';
import { createPullRequestVerifier, type PullRequestVerifierDeps } from '../../src/fixer-api/verify-pr.ts';

const INC = '01K6FIXERAPI00000000000000';
const BOT = 'snapwing-fake[bot]';
const TARGET = { workItemId: INC, incidentId: INC };

function request(handoff: { branch?: string; base?: string }): string {
  return buildImplementationRequest({
    issue: 'WEB-1042',
    intent: 'fix the cart total',
    evidence: [{ kind: 'report', source: 'slack', text: 'the cart total is wrong' }],
    constraints: { scope: 'cart only', tests: { required: true, text: 'add a test' }, forbidden: [] },
    handoff: { mode: 'auto', autonomy: 3, ...handoff },
  });
}

function event<T extends EventType>(seq: number, type: T, payload: EventPayloads[T]): IncidentEvent {
  return { seq, workspaceId: 'WS', incidentId: INC, type, v: 1, source: 'agent', occurredAt: '2026-10-02T09:00:00.000Z', recordedAt: '2026-10-02T09:00:00.000Z', payload } as unknown as IncidentEvent;
}

function pr(over: Partial<PullRequest> = {}): PullRequest {
  return {
    number: 7,
    nodeId: 'PR_fake',
    title: 't',
    body: '',
    state: 'open',
    draft: false,
    merged: false,
    mergeable: true,
    htmlUrl: 'https://github.com/fake-org/web/pull/7',
    headSha: 'a'.repeat(40),
    headRef: 'fix/WEB-1042',
    baseRef: 'main',
    authorLogin: BOT,
    headRepo: 'fake-org/web',
    baseRepo: 'fake-org/web',
    additions: 1,
    deletions: 1,
    changedFiles: 1,
    requestedReviewers: [],
    labels: [],
    ...over,
  };
}

function verifier(opts: { handoff?: { branch?: string; base?: string }; pulls?: Record<number, PullRequest>; repo?: string } = {}) {
  const log = [
    event(1, 'planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 's',
      priority: 'High',
      labels: [],
      autonomyLevel: 3,
      implementationRequest: { artifactId: 'ART1', version: 1 },
    }),
    event(2, 'filed', { jiraKey: 'WEB-1042' }),
  ];
  const pulls = opts.pulls ?? { 7: pr() };
  const state: PullRequestVerifierDeps['state'] = {
    read: async () => log,
    getIncident: async () => ({ id: INC, repo: opts.repo ?? 'fake-org/web', jiraKey: 'WEB-1042' }) as never,
    getArtifact: async () => ({ id: 'ART1', version: 1, kind: 'implementation-request', body: request(opts.handoff ?? {}) }) as Artifact,
  };
  const github: PullRequestVerifierDeps['github'] = () => ({
    getPullRequest: async (n) => {
      const found = pulls[n];
      if (found === undefined) throw new GitHubNotFoundError('Not Found');
      return found;
    },
    getDefaultBranch: async () => 'main',
  });
  return createPullRequestVerifier({ state, github, botLogin: BOT });
}

const report = { prNumber: 7, branch: 'fix/WEB-1042' };

describe('fixer pull request verification (#267)', () => {
  it("accepts the App's pull request from the work branch into the default base, or the requested base", async () => {
    expect(await verifier()(TARGET, report)).toEqual({ ok: true });
    const onRelease = verifier({ handoff: { base: 'release' }, pulls: { 7: pr({ baseRef: 'release' }) } });
    expect(await onRelease(TARGET, report)).toEqual({ ok: true });
    const named = verifier({ handoff: { branch: 'fix/custom' }, pulls: { 7: pr({ headRef: 'fix/custom' }) } });
    expect(await named(TARGET, { prNumber: 7, branch: 'fix/custom' })).toEqual({ ok: true });
  });

  it('refuses a report naming another pull request', async () => {
    const other = pr({ number: 12, headRef: 'chore/unrelated', authorLogin: 'someone' });
    const v = verifier({ pulls: { 7: pr(), 12: other } });
    expect(await v(TARGET, { prNumber: 12, branch: 'fix/WEB-1042' })).toMatchObject({ ok: false });
    expect(await v(TARGET, { prNumber: 99, branch: 'fix/WEB-1042' })).toMatchObject({ ok: false });
  });

  it('refuses a branch other than the work branch, reported or on the pull request', async () => {
    expect(await verifier()(TARGET, { prNumber: 7, branch: 'fix/other' })).toMatchObject({ ok: false });
    expect(await verifier({ pulls: { 7: pr({ headRef: 'fix/other' }) } })(TARGET, report)).toMatchObject({ ok: false });
  });

  it('refuses another base, a fork, and an author that is not the App', async () => {
    expect(await verifier({ pulls: { 7: pr({ baseRef: 'develop' }) } })(TARGET, report)).toMatchObject({ ok: false });
    expect(await verifier({ handoff: { base: 'release' } })(TARGET, report)).toMatchObject({ ok: false });
    expect(await verifier({ pulls: { 7: pr({ headRepo: 'outsider/web' }) } })(TARGET, report)).toMatchObject({ ok: false });
    expect(await verifier({ pulls: { 7: pr({ headRepo: null }) } })(TARGET, report)).toMatchObject({ ok: false });
    expect(await verifier({ pulls: { 7: pr({ authorLogin: 'dana-dev' }) } })(TARGET, report)).toMatchObject({ ok: false });
    expect(await verifier({ pulls: { 7: pr({ authorLogin: null }) } })(TARGET, report)).toMatchObject({ ok: false });
  });
});
