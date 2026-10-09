// GitHub webhooks to incident events (B 8, B 11, main 11, main 12). Payloads shaped from GitHub's
// webhook documentation (test/fixtures/github-webhooks, trimmed, ids and shas fake) go through the
// route handler against the state store on the dialect `SNAPWING_DB` selects and the in-process
// workflow. The GitHub REST calls the handler makes (the pull request, the base branch's required
// checks, the head's check runs and statuses) are the real client's, served by MSW.

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { mergeEvaluateKey } from '@snapwing/pipeline/merge/job.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import type { GitHubAuth } from '../../src/github/auth.ts';
import { createGitHubClient } from '../../src/github/client.ts';
import { createGitHubWebhookRoute, GITHUB_WEBHOOK_PATH, issueKeys, type GitHubWebhookDeps } from '../../src/webhooks/github.ts';

const API = 'https://api.github.com';
const REPO = 'fake-org/web';
const R = `${API}/repos/${REPO}`;
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6GITHOOKINC000000000000';
const KEY = 'WEB-1042';
const PR = 418;
const HEAD = '1111111111111111111111111111111111111111';
const MERGE_SHA = '2222222222222222222222222222222222222222';
const SECRET = 'github-webhook-secret-test';

type Json = Record<string, unknown>;

function fixture(name: string): Json {
  return JSON.parse(readFileSync(new URL(`../fixtures/github-webhooks/${name}.json`, import.meta.url), 'utf8')) as Json;
}

// World ------------------------------------------------------------------------------------------

const auth: GitHubAuth = { installationToken: () => Promise.resolve({ token: 'test-installation-token', expiresAt: '2026-10-02T13:00:00Z' }) };

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let now: number;
let errors: unknown[];
let evaluated: unknown[];
let fixerRuns: unknown[];
let githubCalls: string[];

beforeEach(async () => {
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  evaluated = [];
  fixerRuns = [];
  githubCalls = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
  wf.work('merge.evaluate', (job) => {
    evaluated.push(job.data);
    return Promise.resolve();
  });
  wf.work('fixer.run', (job) => {
    fixerRuns.push(job.data);
    return Promise.resolve();
  });
  server.events.on('request:start', ({ request }) => {
    githubCalls.push(`${request.method} ${new URL(request.url).pathname}`);
  });
});

afterEach(async () => {
  server.resetHandlers();
  server.events.removeAllListeners();
  vi.restoreAllMocks();
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

function deps(overrides: Partial<GitHubWebhookDeps> = {}): GitHubWebhookDeps {
  return {
    workspaceId: WS,
    state,
    workflow: wf,
    clock: () => new Date(now),
    secret: SECRET,
    github: (repo) => createGitHubClient(auth, { repo, now: () => new Date(now) }),
    ...overrides,
  };
}

function route(overrides: Partial<GitHubWebhookDeps> = {}): (req: Request) => Promise<Response> {
  return createGitHubWebhookRoute(deps(overrides));
}

function sign(text: string, secret = SECRET): string {
  return `sha256=${createHmac('sha256', secret).update(text).digest('hex')}`;
}

let deliveries = 0;

interface DeliverOptions {
  delivery?: string;
  signature?: string | null;
  raw?: string;
}

async function deliver(handler: (req: Request) => Promise<Response>, event: string, body: unknown, opts: DeliverOptions = {}): Promise<{ status: number; outcome?: string }> {
  const text = opts.raw ?? JSON.stringify(body);
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-github-event': event,
    'x-github-delivery': opts.delivery ?? `72d3162e-cc78-11e3-81ab-${String(++deliveries).padStart(12, '0')}`,
    'user-agent': 'GitHub-Hookshot/fake',
  };
  const signature = opts.signature === undefined ? sign(text) : opts.signature;
  if (signature !== null) headers['x-hub-signature-256'] = signature;
  const res = await handler(new Request(`https://snapwing.example.com${GITHUB_WEBHOOK_PATH}`, { method: 'POST', headers, body: text }));
  const json = (await res.json()) as { outcome?: string };
  await wf.drain();
  return { status: res.status, ...(json.outcome === undefined ? {} : { outcome: json.outcome }) };
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

/** An incident filed as `KEY` in `repo` at `level`. */
async function filed(level: 0 | 1 | 2 | 3 = 2, repo = REPO): Promise<void> {
  await append(
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 2, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'Medium',
      labels: ['snapwing'],
      autonomyLevel: level,
    }),
    ev('filed', { jiraKey: KEY }),
  );
}

/** Filed, then the fixer's PR `PR` on `snapwing/WEB-1042` (status `in-review`). */
async function inReview(level: 0 | 1 | 2 | 3 = 2): Promise<void> {
  await filed(level);
  await append(
    ev('fixer-started', { runId: '01K6RUN0000000000000000001', harness: 'claude-code', attempt: 1 }),
    ev('fixer-done', { prNumber: PR, branch: `snapwing/${KEY}`, summary: 'Rounded the total', testsAdded: ['checkout.test.ts'] }),
    { ...ev('pr-opened', { prNumber: PR, branch: `snapwing/${KEY}` }), source: 'fixer' } as NewEvent,
  );
}

/** In review, then the review passed (status `ci`). */
async function awaitingCi(level: 0 | 1 | 2 | 3 = 2): Promise<void> {
  await inReview(level);
  await append(ev('review-passed', { prNumber: PR }));
}

/** A report of the same problem, newer than the incident above, linked to `KEY`: its row carries the key without owning it. */
async function linkedDuplicate(): Promise<string> {
  const dup = '01K6LINKEDDUP0000000000000';
  now += 60_000;
  const dev = (type: EventType, payload: unknown): NewEvent => ({ ...ev(type, payload as never), incidentId: dup }) as NewEvent;
  await state.append(
    dup,
    [
      dev('captured', {
        kind: 'incident',
        idempotencyKey: `slack:C-FAKE:${dup}`,
        source: 'slack',
        reporter: { id: 'U-FAKE-REPORTER', name: 'Sam', role: 'reporter' },
        anchorText: 'Checkout says 500 again',
        channelId: 'C-FAKE',
      }),
      dev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000002', version: 1 }, includedCount: 2, excludedCount: 0 }),
      dev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: REPO, resolvedBy: 'channel-explicit', confidence: 0.9 }),
      dev('dedupe-checked', { candidates: [], decision: 'none' }),
      dev('linked-to-existing', { issueKey: KEY }),
    ],
    0,
  );
  expect((await state.findIncidents({ jiraKey: KEY, limit: 1 }))[0]?.id).toBe(dup);
  return dup;
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function ofType(type: EventType): Promise<IncidentEvent[]> {
  return (await log()).filter((e) => e.type === type);
}

async function status(): Promise<string | undefined> {
  return (await state.getIncident(INC))?.status;
}

// GitHub REST (shapes from the REST documentation) -----------------------------------------------

interface Checks {
  required?: string[] | 'unprotected';
  runs?: Array<{ name: string; status: 'queued' | 'in_progress' | 'completed'; conclusion?: string | null }>;
  statuses?: Array<{ context: string; state: 'pending' | 'success' | 'failure' | 'error' }>;
  head?: string;
  prState?: 'open' | 'closed';
}

function github(c: Checks = {}): void {
  const head = c.head ?? HEAD;
  const runs = c.runs ?? [];
  const statuses = c.statuses ?? [];
  server.use(
    http.get(`${R}/pulls/${PR}`, () =>
      HttpResponse.json({
        number: PR,
        node_id: 'PR_kwDOfake0418',
        html_url: `https://github.com/${REPO}/pull/${PR}`,
        state: c.prState ?? 'open',
        draft: false,
        merged: false,
        mergeable: true,
        title: `${KEY}: round the checkout total`,
        body: '',
        user: { login: 'snapwing[bot]', type: 'Bot' },
        head: { ref: `snapwing/${KEY}`, sha: head },
        base: { ref: 'main', sha: '0000000000000000000000000000000000000001' },
        additions: 41,
        deletions: 6,
        changed_files: 2,
        requested_reviewers: [],
        labels: [],
      }),
    ),
    http.get(`${R}/branches/main/protection/required_status_checks`, () =>
      c.required === 'unprotected'
        ? HttpResponse.json({ message: 'Required status checks not enabled', documentation_url: 'https://docs.github.com/rest' }, { status: 404 })
        : HttpResponse.json({
            url: `${R}/branches/main/protection/required_status_checks`,
            strict: true,
            contexts: c.required ?? ['build', 'test'],
            checks: (c.required ?? ['build', 'test']).map((context) => ({ context, app_id: null })),
          }),
    ),
    // No repository ruleset adds required checks for the branch.
    http.get(`${R}/rules/branches/main`, () => HttpResponse.json([])),
    http.get(`${R}/commits/:sha/check-runs`, () =>
      HttpResponse.json({
        total_count: runs.length,
        check_runs: runs.map((r, i) => ({ id: 52000000 + i, name: r.name, head_sha: head, status: r.status, conclusion: r.conclusion ?? null })),
      }),
    ),
    http.get(`${R}/commits/:sha/status`, () =>
      HttpResponse.json({ state: 'success', sha: head, total_count: statuses.length, statuses: statuses.map((s, i) => ({ id: 61000000 + i, ...s })) }),
    ),
  );
}

const green: Checks = {
  runs: [
    { name: 'build', status: 'completed', conclusion: 'success' },
    { name: 'test', status: 'completed', conclusion: 'success' },
    { name: 'lint', status: 'in_progress' },
  ],
};

// Tests ------------------------------------------------------------------------------------------

describe('signature and delivery (B 8)', () => {
  it('rejects a missing or wrong X-Hub-Signature-256 with 401 before reading the body, and records nothing', async () => {
    await filed();
    const body = fixture('pull-request-opened');
    expect(await deliver(route(), 'pull_request', body, { signature: null, delivery: 'fake-delivery-1' })).toEqual({ status: 401 });
    expect(await deliver(route(), 'pull_request', body, { signature: sign(JSON.stringify(body), 'some-other-secret'), delivery: 'fake-delivery-1' })).toEqual({ status: 401 });
    expect(await deliver(route(), 'pull_request', body, { signature: 'sha256=00', delivery: 'fake-delivery-1' })).toEqual({ status: 401 });
    expect(await ofType('pr-opened')).toEqual([]);
    // Not marked seen: the same delivery, signed, is processed.
    expect(await deliver(route(), 'pull_request', body, { delivery: 'fake-delivery-1' })).toEqual({ status: 200, outcome: 'processed' });
  });

  it('signs the exact body bytes: a re-serialized body does not verify', async () => {
    const body = fixture('pull-request-opened');
    const res = await deliver(route(), 'pull_request', body, { raw: JSON.stringify(body, null, 2), signature: sign(JSON.stringify(body)) });
    expect(res).toEqual({ status: 401 });
  });

  it('answers 400 for a signed body that is not a JSON object', async () => {
    expect(await deliver(route(), 'pull_request', null, { raw: '[1,2]' })).toEqual({ status: 400 });
    expect(await deliver(route(), 'pull_request', null, { raw: 'not json' })).toEqual({ status: 400 });
  });

  it('refuses to build without a secret', () => {
    expect(() => route({ secret: '' })).toThrow(/GITHUB_WEBHOOK_SECRET/);
  });

  it('the same delivery twice is a no-op (B 11 inbox dedupe)', async () => {
    await filed();
    const body = fixture('pull-request-opened');
    expect(await deliver(route(), 'pull_request', body, { delivery: 'fake-delivery-dup' })).toEqual({ status: 200, outcome: 'processed' });
    expect(await deliver(route(), 'pull_request', body, { delivery: 'fake-delivery-dup' })).toEqual({ status: 200, outcome: 'duplicate' });
    expect(await ofType('pr-opened')).toHaveLength(1);
  });

  it('dedupes an ignored delivery too, and acknowledges events it does not handle', async () => {
    expect(await deliver(route(), 'ping', { zen: 'Keep it logically awesome.', hook_id: 1, repository: { full_name: REPO } }, { delivery: 'fake-ping' })).toEqual({
      status: 200,
      outcome: 'ignored',
    });
    expect(await deliver(route(), 'ping', { zen: 'Keep it logically awesome.', hook_id: 1, repository: { full_name: REPO } }, { delivery: 'fake-ping' })).toEqual({
      status: 200,
      outcome: 'duplicate',
    });
  });
});

describe('mapping', () => {
  it('reads the issue key out of branch names', () => {
    expect(issueKeys('fix/web-1042-checkout-total')).toEqual(['WEB-1042']);
    expect(issueKeys('snapwing/WEB-1042')).toEqual(['WEB-1042']);
    expect(issueKeys('WEB-1042')).toEqual(['WEB-1042']);
    expect(issueKeys('feature/new-thing')).toEqual([]);
    expect(issueKeys('ops/WEB-0')).toEqual([]);
  });

  it('acknowledges and ignores an unknown repository', async () => {
    await filed();
    const body = fixture('pull-request-opened');
    (body['repository'] as Json)['full_name'] = 'fake-org/elsewhere';
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('pr-opened')).toEqual([]);
  });

  it('acknowledges and ignores a pull request no incident knows', async () => {
    await filed();
    const body = fixture('pull-request-opened');
    ((body['pull_request'] as Json)['head'] as Json)['ref'] = 'fix/WEB-9999-other';
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'ignored' });
    const merged = fixture('pull-request-closed-merged');
    (merged['pull_request'] as Json)['number'] = 77;
    ((merged['pull_request'] as Json)['head'] as Json)['ref'] = 'chore/bump-deps';
    expect(await deliver(route(), 'pull_request', merged)).toEqual({ status: 200, outcome: 'ignored' });
    expect((await log()).at(-1)?.type).toBe('filed');
  });
});

describe('pull requests', () => {
  it('a PR opened by a human on a keyed branch appends pr-opened with actor human (main 12)', async () => {
    await filed();
    expect(await deliver(route(), 'pull_request', fixture('pull-request-opened'))).toEqual({ status: 200, outcome: 'processed' });
    const [opened] = await ofType('pr-opened');
    expect(opened).toMatchObject({
      source: 'github',
      actor: { id: 'dana-dev', role: 'human' },
      occurredAt: '2026-10-02T12:05:00.000Z',
      payload: { prNumber: PR, branch: 'fix/web-1042-checkout-total' },
    });
    expect(await status()).toBe('in-review');
    expect(githubCalls).toEqual([]);
  });

  it('ignores a PR from a fork, or from an author without write access, even when the branch names the key (#267)', async () => {
    await filed();
    const fork = fixture('pull-request-opened');
    (((fork['pull_request'] as Json)['head'] as Json)['repo'] as Json)['full_name'] = 'outsider/web';
    expect(await deliver(route(), 'pull_request', fork)).toEqual({ status: 200, outcome: 'ignored' });

    const lines: string[] = [];
    for (const association of ['CONTRIBUTOR', 'NONE', 'FIRST_TIME_CONTRIBUTOR']) {
      const outsider = fixture('pull-request-opened');
      (outsider['pull_request'] as Json)['author_association'] = association;
      expect(await deliver(route({ debug: (l) => lines.push(l) }), 'pull_request', outsider)).toEqual({ status: 200, outcome: 'ignored' });
    }
    expect(lines).toHaveLength(3);
    expect(await ofType('pr-opened')).toEqual([]);
    expect(await status()).not.toBe('in-review');
  });

  it('attaches the PR of a mapped person whose association GitHub does not report as write access', async () => {
    await filed();
    const body = fixture('pull-request-opened');
    (body['pull_request'] as Json)['author_association'] = 'CONTRIBUTOR';
    expect(await deliver(route({ mappedLogins: async () => ['@Dana-Dev'] }), 'pull_request', body)).toEqual({ status: 200, outcome: 'processed' });
    expect(await ofType('pr-opened')).toHaveLength(1);
  });

  it('lands a PR on the incident that owns the key, not a newer report linked to it', async () => {
    await filed();
    const dup = await linkedDuplicate();
    expect(await deliver(route(), 'pull_request', fixture('pull-request-opened'))).toEqual({ status: 200, outcome: 'processed' });
    expect(await ofType('pr-opened')).toHaveLength(1);
    expect(await status()).toBe('in-review');
    expect((await state.read(dup)).map((e) => e.type)).not.toContain('pr-opened');
  });

  it('ignores a PR the App opened: the fixer reports its own through the API (B 9)', async () => {
    await filed();
    const body = fixture('pull-request-opened');
    (body['pull_request'] as Json)['user'] = { login: 'snapwing[bot]', id: 9100001, type: 'Bot' };
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'ignored' });
    const renamed = fixture('pull-request-opened');
    (renamed['pull_request'] as Json)['user'] = { login: 'wingbot', id: 9100002, type: 'User' };
    expect(await deliver(route({ botLogin: 'wingbot' }), 'pull_request', renamed)).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('pr-opened')).toEqual([]);
  });

  it('does not append a human pr-opened where the lifecycle cannot take it, or twice for one PR', async () => {
    await inReview();
    const body = fixture('pull-request-opened');
    (body['pull_request'] as Json)['number'] = 419;
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('pr-opened')).toHaveLength(1);
  });

  it('a merge not done by Snapwing appends merged with the merger as a human', async () => {
    await awaitingCi(2);
    await append(ev('ci-green', { prNumber: PR, headSha: HEAD }));
    expect(await deliver(route(), 'pull_request', fixture('pull-request-closed-merged'))).toEqual({ status: 200, outcome: 'processed' });
    const [merged] = await ofType('merged');
    expect(merged).toMatchObject({
      source: 'github',
      actor: { id: 'dana-dev', role: 'human' },
      occurredAt: '2026-10-02T13:30:00.000Z',
      payload: { prNumber: PR, mergeCommitSha: MERGE_SHA, levelAtMergeTime: 2 },
    });
    expect(await status()).toBe('merged');
    // A second delivery for the same merge (a redelivery under a new id) appends nothing.
    expect(await deliver(route(), 'pull_request', fixture('pull-request-closed-merged'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('merged')).toHaveLength(1);
  });

  it('records a merge by another bot without an actor', async () => {
    await awaitingCi(2);
    const body = fixture('pull-request-closed-merged');
    (body['pull_request'] as Json)['merged_by'] = { login: 'merge-queue[bot]', id: 9300001, type: 'Bot' };
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'processed' });
    const [merged] = await ofType('merged');
    expect(merged?.actor).toBeUndefined();
    expect(merged?.payload).toMatchObject({ prNumber: PR, mergeCommitSha: MERGE_SHA });
  });

  it('leaves a merge by the App to merge.evaluate, which records it with the level at merge time', async () => {
    await awaitingCi(3);
    const body = fixture('pull-request-closed-merged');
    (body['pull_request'] as Json)['merged_by'] = { login: 'snapwing[bot]', id: 9100001, type: 'Bot' };
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('merged')).toEqual([]);
  });

  it('ignores a PR closed without merging', async () => {
    await awaitingCi();
    const body = fixture('pull-request-closed-merged');
    Object.assign(body['pull_request'] as Json, { merged: false, merged_by: null, merge_commit_sha: null, merged_at: null });
    expect(await deliver(route(), 'pull_request', body)).toEqual({ status: 200, outcome: 'ignored' });
  });
});

describe('CI (main 11.3, main 14.1)', () => {
  it('appends ci-green once every required check for the head completed, then starts merge.evaluate with its singleton key', async () => {
    await awaitingCi(3);
    github(green);
    const start = vi.spyOn(wf, 'start');
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'processed' });
    const [result] = await ofType('ci-green');
    expect(result).toMatchObject({ source: 'github', payload: { prNumber: PR, headSha: HEAD } });
    expect(await status()).toBe('mergeable');
    expect(start).toHaveBeenCalledWith('merge.evaluate', { incidentId: INC }, { singletonKey: mergeEvaluateKey(INC) });
    expect(evaluated).toEqual([{ incidentId: INC }]);
    expect(githubCalls).toEqual(
      expect.arrayContaining([
        `GET /repos/${REPO}/pulls/${PR}`,
        `GET /repos/${REPO}/branches/main/protection/required_status_checks`,
        `GET /repos/${REPO}/commits/${HEAD}/check-runs`,
        `GET /repos/${REPO}/commits/${HEAD}/status`,
      ]),
    );
  });

  it('appends one result per head sha however many check deliveries report it', async () => {
    await awaitingCi();
    github(green);
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'processed' });
    const run = fixture('check-run-completed');
    (run['check_run'] as Json)['conclusion'] = 'success';
    expect(await deliver(route(), 'check_run', run)).toEqual({ status: 200, outcome: 'ignored' });
    expect(await deliver(route(), 'status', fixture('status'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('ci-green')).toHaveLength(1);
    expect(evaluated).toHaveLength(1);
  });

  it('appends ci-red with the failing required check names, then starts the fixer retry with them (main 10)', async () => {
    await awaitingCi();
    github({
      runs: [
        { name: 'build', status: 'completed', conclusion: 'success' },
        { name: 'test', status: 'completed', conclusion: 'failure' },
        { name: 'lint', status: 'completed', conclusion: 'failure' },
      ],
    });
    expect(await deliver(route(), 'check_run', fixture('check-run-completed'))).toEqual({ status: 200, outcome: 'processed' });
    const [red] = await ofType('ci-red');
    expect(red).toMatchObject({ source: 'github', payload: { prNumber: PR, headSha: HEAD, failingChecks: ['test'] } });
    expect(await ofType('ci-green')).toEqual([]);
    expect(await status()).toBe('fixing-retry');
    expect(evaluated).toEqual([]);
    expect(fixerRuns).toEqual([{ incidentId: INC, attempt: 2, reviewArtifact: expect.objectContaining({ version: 1 }) as unknown }]);
  });

  it('a redelivered check delivery is a duplicate and records nothing more', async () => {
    await awaitingCi();
    github(green);
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'), { delivery: 'fake-delivery-check' })).toEqual({ status: 200, outcome: 'processed' });
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'), { delivery: 'fake-delivery-check' })).toEqual({ status: 200, outcome: 'duplicate' });
    expect(await ofType('ci-green')).toHaveLength(1);
    expect(evaluated).toHaveLength(1);
  });

  it('counts a commit status as a required check, and maps a status delivery by its branch', async () => {
    await awaitingCi();
    github({ required: ['build', 'ci/legacy'], runs: [{ name: 'build', status: 'completed', conclusion: 'success' }], statuses: [{ context: 'ci/legacy', state: 'error' }] });
    expect(await deliver(route(), 'status', fixture('status'))).toEqual({ status: 200, outcome: 'processed' });
    expect((await ofType('ci-red'))[0]?.payload).toMatchObject({ failingChecks: ['ci/legacy'] });
  });

  it('waits while a required check is still running or has not reported', async () => {
    await awaitingCi();
    github({ runs: [{ name: 'build', status: 'completed', conclusion: 'failure' }, { name: 'test', status: 'in_progress' }] });
    expect(await deliver(route(), 'check_run', fixture('check-run-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    github({ runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    expect((await log()).at(-1)?.type).toBe('review-passed');
    expect(evaluated).toEqual([]);
  });

  it('never calls a branch that requires no checks green', async () => {
    await awaitingCi();
    github({ required: 'unprotected', runs: [{ name: 'build', status: 'completed', conclusion: 'success' }] });
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('ci-green')).toEqual([]);
  });

  it('ignores a check for a sha that is no longer the head, or a PR that closed', async () => {
    await awaitingCi();
    github({ ...green, head: '4444444444444444444444444444444444444444' });
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    github({ ...green, prState: 'closed' });
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('ci-green')).toEqual([]);
  });

  it('records nothing and calls nothing while the review is still running', async () => {
    await inReview();
    github(green);
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(githubCalls).toEqual([]);
    expect(await ofType('ci-green')).toEqual([]);
  });

  it('does not record a head merge.evaluate or the review step already recorded', async () => {
    await awaitingCi(3);
    // Both record CI through recordCiResult (pipeline merge/ci.ts) for an incident still in `ci`.
    await append({ ...ev('ci-green', { prNumber: PR, headSha: HEAD }), source: 'github' } as NewEvent);
    github(green);
    expect(await deliver(route(), 'check_suite', fixture('check-suite-completed'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('ci-green')).toHaveLength(1);
  });

  it('ignores a check suite that has not completed', async () => {
    await awaitingCi();
    const body = fixture('check-suite-completed');
    body['action'] = 'requested';
    expect(await deliver(route(), 'check_suite', body)).toEqual({ status: 200, outcome: 'ignored' });
    expect(githubCalls).toEqual([]);
  });
});

describe('deployments (main 12)', () => {
  async function merged(): Promise<void> {
    await awaitingCi();
    await append(ev('ci-green', { prNumber: PR, headSha: HEAD }), ev('merged', { prNumber: PR, mergeCommitSha: MERGE_SHA, levelAtMergeTime: 2 }));
  }

  function deployment(environment: string, opts: { state?: string; sha?: string; production?: boolean } = {}): Json {
    const body = fixture('deployment-status-success');
    Object.assign(body['deployment_status'] as Json, { environment, state: opts.state ?? 'success' });
    Object.assign(body['deployment'] as Json, { environment, sha: opts.sha ?? MERGE_SHA, production_environment: opts.production ?? false });
    return body;
  }

  it('a successful staging deployment of the merge commit appends deployed:staging, then production appends deployed:production', async () => {
    await merged();
    expect(await deliver(route(), 'deployment_status', fixture('deployment-status-success'))).toEqual({ status: 200, outcome: 'processed' });
    const [staging] = await ofType('deployed:staging');
    expect(staging).toMatchObject({ source: 'deploy', occurredAt: '2026-10-02T14:00:00.000Z', payload: { commitSha: MERGE_SHA, deploymentId: '81000004' } });
    expect(await status()).toBe('deployed:staging');

    expect(await deliver(route(), 'deployment_status', deployment('Production'))).toEqual({ status: 200, outcome: 'processed' });
    expect(await ofType('deployed:production')).toHaveLength(1);
    expect(await status()).toBe('deployed:production');
    expect(githubCalls).toEqual([]);
  });

  it('maps environment names through `environments`, and falls back to GitHub\'s production flag', async () => {
    await merged();
    expect(await deliver(route({ environments: { staging: ['qa'] } }), 'deployment_status', deployment('qa'))).toEqual({ status: 200, outcome: 'processed' });
    expect(await deliver(route(), 'deployment_status', deployment('prod-us-east', { production: true }))).toEqual({ status: 200, outcome: 'processed' });
    expect((await log()).slice(-2).map((e) => e.type)).toEqual(['deployed:staging', 'deployed:production']);
  });

  const LATER_SHA = '4444444444444444444444444444444444444444';
  const OTHER_SHA = '5555555555555555555555555555555555555555';

  function compare(head: string, compareStatus: string): void {
    server.use(http.get(`${R}/compare/${MERGE_SHA}...${head}`, () => HttpResponse.json({ status: compareStatus, ahead_by: compareStatus === 'ahead' ? 3 : 0, behind_by: compareStatus === 'behind' ? 2 : 0 })));
  }

  it('a deployment of a later commit that contains the merge appends deployed:<env> for it, once', async () => {
    await merged();
    compare(LATER_SHA, 'ahead');
    expect(await deliver(route(), 'deployment_status', deployment('staging', { sha: LATER_SHA }))).toEqual({ status: 200, outcome: 'processed' });
    const [staging] = await ofType('deployed:staging');
    expect(staging).toMatchObject({ source: 'deploy', payload: { commitSha: LATER_SHA } });
    expect(githubCalls).toEqual([`GET /repos/${REPO}/compare/${MERGE_SHA}...${LATER_SHA}`]);

    // A redelivery under a new delivery id appends nothing and makes no further call.
    expect(await deliver(route(), 'deployment_status', deployment('staging', { sha: LATER_SHA }))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('deployed:staging')).toHaveLength(1);
    expect(githubCalls).toHaveLength(1);

    compare(LATER_SHA, 'identical');
    expect(await deliver(route(), 'deployment_status', deployment('production', { sha: LATER_SHA }))).toEqual({ status: 200, outcome: 'processed' });
    expect(await ofType('deployed:production')).toHaveLength(1);
    expect(await status()).toBe('deployed:production');
  });

  it('a deployment of a commit that does not contain the merge, or that GitHub does not know, appends nothing', async () => {
    await merged();
    for (const s of ['behind', 'diverged']) {
      compare(OTHER_SHA, s);
      expect(await deliver(route(), 'deployment_status', deployment('staging', { sha: OTHER_SHA }))).toEqual({ status: 200, outcome: 'ignored' });
    }
    server.use(http.get(`${R}/compare/${MERGE_SHA}...${OTHER_SHA}`, () => HttpResponse.json({ message: 'Not Found' }, { status: 404 })));
    expect(await deliver(route(), 'deployment_status', deployment('staging', { sha: OTHER_SHA }))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('deployed:staging')).toHaveLength(0);
  });

  it('ignores an unmapped environment, an unsuccessful deployment, another sha, and a repeat', async () => {
    await merged();
    expect(await deliver(route(), 'deployment_status', deployment('preview'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await deliver(route(), 'deployment_status', deployment('staging', { state: 'failure' }))).toEqual({ status: 200, outcome: 'ignored' });
    compare(OTHER_SHA, 'behind');
    expect(await deliver(route(), 'deployment_status', deployment('staging', { sha: OTHER_SHA }))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await deliver(route(), 'deployment_status', deployment('staging'))).toEqual({ status: 200, outcome: 'processed' });
    expect(await deliver(route(), 'deployment_status', deployment('staging'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await ofType('deployed:staging')).toHaveLength(1);
  });
});
