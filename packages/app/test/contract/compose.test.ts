// The composition root (#159; main 14.1, main 14.3, B 7.1, B 9) booted for real: `snapwing serve` with
// the real `compose`, the example config, the demo workspace map, fake secrets in an env file, MSW
// standing in for Slack, Jira, and GitHub, and a fake harness. Runs on the dialect `SNAPWING_DB`
// selects (pg-boss on Postgres). The last test runs the level 0 demo recording through the composed
// routes, jobs, and projectors and counts the status messages Slack receives; the world it runs in
// (fixtures/e2e/world.ts) is shared with the levels 1 and 2 end to end test (e2e-levels.test.ts).

import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer as createNetServer, type AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { buildImplementationRequest } from '@snapwing/pipeline/prompts/implementation-request.ts';
import { runReviewJob } from '@snapwing/pipeline/review/job.ts';
import { GITHUB_API, DEMO_GITHUB_TOKEN, GitHubWorld, githubHandlers } from '@snapwing/pipeline/demo/msw/github.ts';
import { DEMO_JIRA_EMAIL, DEMO_JIRA_TOKEN, JIRA_BASE, JiraWorld, jiraHandlers } from '@snapwing/pipeline/demo/msw/jira.ts';
import { parseScenario, RecordedModel } from '@snapwing/pipeline/demo/run.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import type { WorkflowPort } from '@snapwing/pipeline/ports/workflow.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { PgBossWorkflow } from '@snapwing/pipeline/workflow/pgboss/index.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createBareRepo, git } from '../../../pipeline/test/helpers/git.ts';
import { verifyModelToken } from '../../src/model-proxy/token.ts';
import type { SocketLike } from '../../src/adapters/slack/transport.ts';
import { repoFullName, sameRepo } from '../../src/github/repo.ts';
import { compose, mergePrometheus, MissingSecretsError, type Composed, type ComposeFn, type ComposeOverrides } from '../../src/server/compose.ts';
import { createApiServer } from '../../src/server/http.ts';
import { createWorkflow, LOCAL_RUNNER_WARNING, runServe } from '../../src/server/serve.ts';
import {
  blockIds,
  bootComposed,
  BOT_USER,
  DEMO_MAP as MAP,
  envFile,
  EXAMPLE_CONFIG,
  fakeSecrets,
  SLACK_API as SLACK,
  slackSigned,
  slackWorld,
} from '../fixtures/e2e/world.ts';

/** A harness that must never run in these tests: boot only builds it. */
const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the fake harness was not expected to run')) };

// World ------------------------------------------------------------------------------------------

const server = setupServer();
const unhandled: string[] = [];
const calls: string[] = [];
beforeAll(() => {
  server.listen();
  server.events.on('request:start', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') calls.push(`${request.method} ${url.host}${url.pathname}`);
  });
  server.events.on('request:unhandled', ({ request }) => {
    const url = new URL(request.url);
    if (url.hostname !== '127.0.0.1') unhandled.push(`${request.method} ${request.url}`);
  });
});
afterAll(() => server.close());

let tdb: TestDatabase;
let dir: string;

beforeEach(async () => {
  tdb = await createTestDatabase();
  dir = await mkdtemp(join(tmpdir(), 'snapwing-compose-'));
  unhandled.length = 0;
  calls.length = 0;
  server.use(
    http.post(`${SLACK}/auth.test`, ({ request }) =>
      HttpResponse.json(request.headers.get('authorization') === 'Bearer xoxb-test' ? { ok: true, user_id: BOT_USER, url: 'https://acme-test.slack.com/' } : { ok: false, error: 'invalid_auth' }),
    ),
    // The channel members refresh on an install from before `channels:read`: skipped, not an error.
    http.get(`${SLACK}/conversations.members`, () => HttpResponse.json({ ok: false, error: 'missing_scope' })),
  );
});

afterEach(async () => {
  server.resetHandlers();
  await tdb.drop();
  await rm(dir, { recursive: true, force: true });
});

function dbEnv(): Record<string, string> {
  return tdb.dialect === 'postgres'
    ? { SNAPWING_DB: 'postgres', DATABASE_URL: tdb.options.url ?? '' }
    : { SNAPWING_DB: 'sqlite', SNAPWING_SQLITE_PATH: tdb.options.url ?? '' };
}

interface Run {
  code: Promise<number>;
  out: string[];
  err: string[];
  signals: EventEmitter;
  ready: Promise<{ url?: string }>;
}

async function serve(args: string[], secrets: Record<string, string>, overrides: ComposeOverrides = {}, env: Record<string, string> = {}): Promise<Run> {
  const file = join(dir, 'test.env');
  await writeFile(file, envFile(secrets));
  const out: string[] = [];
  const err: string[] = [];
  const signals = new EventEmitter();
  let markReady!: (info: { url?: string }) => void;
  const ready = new Promise<{ url?: string }>((r) => (markReady = r));
  const withOverrides: ComposeFn = (deps) => compose({ ...deps, overrides: { resolveHarness: () => idleHarness, ...overrides } });
  const code = runServe(
    args,
    { env: { ...dbEnv(), SNAPWING_ENV_FILE: file, SNAPWING_MAP: MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work'), ...env }, stdout: (l) => out.push(l), stderr: (l) => err.push(l) },
    { signals, onReady: markReady, compose: withOverrides },
  );
  void code.then(() => markReady({}));
  return { code, out, err, signals, ready };
}

/** `compose` called directly, with the example config and the secrets written to an env file. */
async function composeDirect(input: {
  secrets: Record<string, string>;
  env?: Record<string, string>;
  overrides?: ComposeOverrides;
  state: OpenedState;
  workflow: WorkflowPort;
  /** Replaces the example's `<runtime provider="local"/>`. */
  provider?: 'local' | 'docker';
}): Promise<Composed> {
  const file = join(dir, 'direct.env');
  await writeFile(file, envFile(input.secrets));
  const xml = (await readFile(EXAMPLE_CONFIG, 'utf8')).replace('<runtime provider="local"/>', `<runtime provider="${input.provider ?? 'local'}"/>`);
  const config = loadAppConfig(xml);
  return compose({
    config,
    secrets: createEnvFileSecrets({ path: file, fallbackEnv: {} }),
    state: input.state,
    workflow: input.workflow,
    env: { SNAPWING_MAP: MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work'), ...input.env },
    overrides: { resolveHarness: () => idleHarness, ...input.overrides },
  });
}

// Tests ------------------------------------------------------------------------------------------

describe('compose under snapwing serve', () => {
  it('boots every phase 3 component, answers /healthz and /metrics, mounts the routes, and shuts down', async () => {
    const run = await serve(['--port', '0', '--host', '127.0.0.1', '--config', EXAMPLE_CONFIG], fakeSecrets());
    const { url } = await run.ready;
    expect(run.err).toEqual([`snapwing serve: ${LOCAL_RUNNER_WARNING}`]);
    expect(url).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/);
    const log = run.out.join('\n');
    expect(log).toContain('composed: slack http, runner local');
    // Seven phase 3 job types plus the phase 4 timers: mid-flight, hold, claim nudge, claim expiry;
    // and the escalation ladder step, the monitor poll, heartbeat, and stall.
    expect(log).toContain('worker polling (15 job types)');
    for (const service of ['fixer scratch sweep', 'reconcile schedule', 'jira projector', 'slack status projector', 'slack http transport', 'phase 4 schedules', 'ux friction scan', 'channel members refresh', 'active monitoring', 'capture images']) {
      expect(log).toContain(`${service} started`);
    }

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toMatchObject({ ok: true });

    const metrics = await (await fetch(`${url}/metrics`)).text();
    expect(metrics).toContain('snapwing_jobs_parked 0');
    expect(metrics).toContain('snapwing_jira_drain_paused_seconds{workspace=');
    expect(metrics).toContain('snapwing_slack_drain_paused_seconds{workspace=');
    expect(metrics).toContain('snapwing_outbox_parked_rows{target="jira"');
    expect(metrics).toContain('snapwing_outbox_parked_rows{target="slack"');
    expect(metrics.match(/^# TYPE snapwing_outbox_parked_rows /gm)).toHaveLength(1);

    // The Slack Events API (HTTP mode): a signed url_verification is answered with its challenge.
    const verification = JSON.stringify({ type: 'url_verification', challenge: 'challenge-test' });
    const slack = await fetch(`${url}/slack/events`, { method: 'POST', headers: slackSigned(verification), body: verification });
    expect(slack.status).toBe(200);
    expect(await slack.json()).toEqual({ challenge: 'challenge-test' });
    // Every other route is mounted and refuses an unauthenticated caller.
    expect((await fetch(`${url}/webhooks/github`, { method: 'POST', body: '{}' })).status).toBe(401);
    expect((await fetch(`${url}/fixer/01K6FAKEWORKITEM0000000000/stop`)).status).toBe(401);
    expect((await fetch(`${url}/webhooks/jira`, { method: 'POST', body: 'not json' })).status).toBe(400);
    expect((await fetch(`${url}/auth/github/start`, { redirect: 'manual' })).status).not.toBe(404);

    run.signals.emit('SIGTERM');
    expect(await run.code).toBe(0);
    expect(run.err).toEqual([`snapwing serve: ${LOCAL_RUNNER_WARNING}`]);
    expect(run.out.join('\n')).toContain('stopped');
    // auth.test, then the worker's channel members refresh, one read per map channel.
    expect(calls[0]).toBe(`POST slack.com/api/auth.test`);
    expect([...new Set(calls.slice(1))]).toEqual([`GET slack.com/api/conversations.members`]);
    expect(unhandled).toEqual([]);
  });

  it('fails startup listing every missing secret by name, never a value', async () => {
    const secrets = fakeSecrets();
    delete secrets['SLACK_SIGNING_SECRET'];
    delete secrets['GITHUB_APP_SLUG'];
    delete secrets['GOOGLE_API_KEY'];
    const run = await serve(['--port', '0', '--host', '127.0.0.1', '--config', EXAMPLE_CONFIG], secrets);
    expect(await run.code).toBe(1);
    const err = run.err.join('\n');
    expect(err).toContain('missing secrets: SLACK_SIGNING_SECRET, GITHUB_APP_SLUG, GOOGLE_API_KEY');
    for (const value of Object.values(secrets)) expect(err).not.toContain(value);
    expect(calls).toEqual([]);
  });
});

describe('compose', () => {
  async function composeWith(secrets: Record<string, string>, env: Record<string, string>, overrides: ComposeOverrides): Promise<Composed> {
    const state = await tdb.open();
    return composeDirect({ secrets, env, overrides, state, workflow: new InProcessWorkflow(state) });
  }

  it('defaults the Slack transport to Socket Mode when SLACK_APP_TOKEN is set', async () => {
    const opened: string[] = [];
    let connectAuth: string | null = null;
    server.use(
      http.post(`${SLACK}/apps.connections.open`, ({ request }) => {
        connectAuth = request.headers.get('authorization');
        return HttpResponse.json({ ok: true, url: 'wss://socket.fake-slack.test/link' });
      }),
    );
    const listeners = new Map<string, ((e: unknown) => void)[]>();
    const socket: SocketLike = {
      send: () => undefined,
      close: () => undefined,
      addEventListener: (type: string, listener: (e: never) => void) => {
        listeners.set(type, [...(listeners.get(type) ?? []), listener as (e: unknown) => void]);
        if (type === 'open') setTimeout(() => listener({} as never), 0);
      },
    };
    const composed = await composeWith({ ...fakeSecrets(), SLACK_APP_TOKEN: 'xapp-test' }, {}, {
      openSocket: (u) => {
        opened.push(u);
        return socket;
      },
    });
    expect(composed.routes.some((r) => r.path.startsWith('/slack/'))).toBe(false);
    const transport = composed.apiServices?.find((s) => s.name.startsWith('slack'));
    expect(transport?.name).toBe('slack socket mode transport');
    await transport?.start();
    expect(opened).toEqual(['wss://socket.fake-slack.test/link']);
    expect(connectAuth).toBe('Bearer xapp-test');
    await transport?.stop();

    const http_ = await composeWith({ ...fakeSecrets(), SLACK_APP_TOKEN: 'xapp-test' }, { SNAPWING_SLACK_TRANSPORT: 'http' }, {});
    expect(http_.routes.map((r) => r.path)).toEqual(expect.arrayContaining(['/slack/events', '/slack/interactivity']));
  });

  it('requires SLACK_APP_TOKEN when Socket Mode is asked for', async () => {
    await expect(composeWith(fakeSecrets(), { SNAPWING_SLACK_TRANSPORT: 'socket' }, {})).rejects.toThrow(MissingSecretsError);
    await expect(composeWith(fakeSecrets(), { SNAPWING_SLACK_TRANSPORT: 'socket' }, {})).rejects.toThrow('missing secrets: SLACK_APP_TOKEN');
  });

  it('hands the review the fixer runner: with docker it runs PR tests in the container, with local it has no runTests', async () => {
    const dockerState = await tdb.open();
    const docker = await composeDirect({
      secrets: fakeSecrets(),
      env: { SNAPWING_FIXER_IMAGE: 'snapwing-fixer-test:1' },
      overrides: { slackBotUserId: BOT_USER },
      state: dockerState,
      workflow: new InProcessWorkflow(dockerState),
      provider: 'docker',
    });
    expect(docker.deps?.review.runner).toBe(docker.deps?.fixer.runner);
    expect(typeof docker.deps?.review.runner?.runTests).toBe('function');

    const local = await composeWith(fakeSecrets(), {}, { slackBotUserId: BOT_USER });
    expect(local.deps?.review.runner).toBe(local.deps?.fixer.runner);
    expect(local.deps?.review.runner?.runTests).toBeUndefined();
  });

  it('merges the projectors metrics into one family per metric', () => {
    const a = '# HELP m_x X.\n# TYPE m_x gauge\nm_x{t="a"} 1\n# HELP m_y Y.\n# TYPE m_y gauge\nm_y 0\n';
    const b = '# HELP m_x X.\n# TYPE m_x gauge\nm_x{t="b"} 2\n# HELP m_z Z.\n# TYPE m_z gauge\nm_z 3\n';
    expect(mergePrometheus([a, b])).toBe(
      ['# HELP m_x X.', '# TYPE m_x gauge', 'm_x{t="a"} 1', 'm_x{t="b"} 2', '# HELP m_y Y.', '# TYPE m_y gauge', 'm_y 0', '# HELP m_z Z.', '# TYPE m_z gauge', 'm_z 3', ''].join('\n'),
    );
  });
});

describe('compose with the docker runtime: the model proxy (ADR 0017 amendment 1, #247)', () => {
  it('mounts the proxy only for docker, and only for providers whose key is set', async () => {
    const localState = await tdb.open();
    const local = await composeDirect({ secrets: fakeSecrets(), overrides: { slackBotUserId: BOT_USER }, state: localState, workflow: new InProcessWorkflow(localState) });
    expect(local.routes.filter((r) => r.path.startsWith('/model/'))).toEqual([]);

    const secrets = fakeSecrets();
    delete secrets['OPENAI_API_KEY'];
    const state = await tdb.open();
    const docker = await composeDirect({
      secrets,
      env: { SNAPWING_FIXER_IMAGE: 'snapwing-fixer-test:1' },
      // The fake model needs no key, so OPENAI_API_KEY is not required here.
      overrides: { slackBotUserId: BOT_USER, model: withValidation(new RecordedModel()) },
      state,
      workflow: new InProcessWorkflow(state),
      provider: 'docker',
    });
    const proxied = docker.routes.filter((r) => r.path.startsWith('/model/')).map((r) => r.path);
    expect(proxied).toEqual(expect.arrayContaining(['/model/:workItemId/anthropic/v1/messages', '/model/:workItemId/google/v1beta/models/:call']));
    expect(proxied.some((p) => p.includes('/openai/'))).toBe(false);

    // Fresh git tokens for containers (#266): docker only.
    const gitToken = (c: Composed): string[] => c.routes.filter((r) => r.path.endsWith('/git-token')).map((r) => `${r.method} ${r.path}`);
    expect(gitToken(docker)).toEqual(['GET /fixer/:workItemId/git-token']);
    expect(gitToken(local)).toEqual([]);
    // The worker's first service sweeps stale scratch directories, on both runners.
    expect(docker.workerServices?.[0]?.name).toBe('fixer scratch sweep');
    expect(local.workerServices?.[0]?.name).toBe('fixer scratch sweep');
  });

  it('a composed review run goes through runReview, and a container reaches the model only with its per-run token', async () => {
    // GitHub: the App token, the PR, its files, the review, the check run, and CI for the approval.
    const repoPath = `${GITHUB_API}/repos/${REPO_FULL}`;
    const origin = await createBareRepo({ files: { 'src/cart/total.txt': 'buggy\n' }, branches: [BRANCH] });
    const headSha = git(origin.url, ['rev-parse', `refs/heads/${BRANCH}`]);
    const github: string[] = [];
    server.use(
      http.post(`${GITHUB_API}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ token: DEMO_GITHUB_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 }),
      ),
      http.get(`${repoPath}/pulls/${PR}`, () =>
        HttpResponse.json({ number: PR, state: 'open', merged: false, head: { sha: headSha, ref: BRANCH }, base: { ref: 'main' }, user: { login: 'snapwing-test[bot]' } }),
      ),
      http.get(`${repoPath}/pulls/${PR}/files`, () => HttpResponse.json([{ filename: 'src/cart/total.txt', status: 'modified', additions: 1, deletions: 1, changes: 2 }])),
      http.post(`${repoPath}/pulls/${PR}/reviews`, async ({ request }) => {
        github.push(`review ${String(((await request.json()) as { event?: string }).event)}`);
        return HttpResponse.json({ id: 31, state: 'APPROVED' });
      }),
      http.post(`${repoPath}/check-runs`, () => HttpResponse.json({ id: 41, name: 'snapwing/review', status: 'in_progress' }, { status: 201 })),
      http.patch(`${repoPath}/check-runs/:id`, async ({ request }) => {
        github.push(`check ${String(((await request.json()) as { conclusion?: string }).conclusion)}`);
        return HttpResponse.json({ id: 41, name: 'snapwing/review', status: 'completed' });
      }),
      http.get(`${repoPath}/branches/main/protection/required_status_checks`, () => HttpResponse.json({ message: 'Branch not protected' }, { status: 404 })),
      http.get(`${repoPath}/commits/:sha/check-runs`, () => HttpResponse.json({ total_count: 0, check_runs: [] })),
      http.get(`${repoPath}/commits/:sha/status`, () => HttpResponse.json({ state: 'success', statuses: [] })),
    );
    // The model provider: it must see the real key and never the token a container presented.
    const upstream: { apiKey: string | null; headers: string }[] = [];
    server.use(
      http.post('https://api.anthropic.com/v1/messages', ({ request }) => {
        upstream.push({ apiKey: request.headers.get('x-api-key'), headers: JSON.stringify([...request.headers]) });
        if (request.headers.get('x-api-key') !== 'test-anthropic-key') return HttpResponse.json({ error: 'bad key' }, { status: 401 });
        return HttpResponse.json({ id: 'msg-test', type: 'message', role: 'assistant', content: [{ type: 'text', text: 'looks fine' }] });
      }),
    );

    // The fake docker CLI: each "container" calls the model proxy as its CLI would, then (review) writes
    // its verdict into the mounted tree.
    const bin = join(dir, 'bin');
    await mkdir(bin);
    await writeFile(join(bin, 'docker'), fakeDocker(), { mode: 0o755 });
    const port = await freePort();
    const containerApi = `http://127.0.0.1:${port}`;
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const secrets: Record<string, string> = { ...fakeSecrets(), GITHUB_APP_PRIVATE_KEY: privateKey };
    const state = await tdb.open();
    const composed = await composeDirect({
      secrets,
      env: {
        SNAPWING_FIXER_IMAGE: 'snapwing-fixer-test:1',
        // The fixer API as containers reach it, and the model proxy where they reach the server directly.
        SNAPWING_FIXER_API_URL: 'http://fixer-api.invalid',
        SNAPWING_CONTAINER_API_URL: containerApi,
      },
      overrides: { slackBotUserId: BOT_USER, gitRemoteUrl: () => origin.url },
      state,
      workflow: new InProcessWorkflow(state),
      provider: 'docker',
    });
    const review = composed.deps?.review;
    if (review === undefined) throw new Error('compose returned no review deps');
    expect(review.runner).toBe(composed.deps?.fixer.runner);
    expect(review.config.harness).toEqual({ adapter: 'generic', templateId: 'aider' });

    // The incident, filed, with a PR the fixer opened.
    const workspaceId = review.workspaceId;
    const put = await state.putArtifact({ workspaceId, incidentId: INC, kind: 'implementation-request', contentType: 'application/xml', body: REQUEST_BODY, createdBy: 'orchestrator' });
    await state.append(INC, incidentToPr(workspaceId, { artifactId: put.id, version: put.version }), 0);

    const api = createApiServer({ routes: composed.routes, port, host: '127.0.0.1' });
    await api.start();
    const savedPath = process.env['PATH'];
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`;
    try {
      // The review job, as `review.run` runs it.
      const outcome = await runReviewJob(review, { incidentId: INC, prNumber: PR, headSha });
      expect(outcome, JSON.stringify(outcome)).toMatchObject({ outcome: 'reviewed', verdict: { verdict: 'approve' } });
      expect((await state.read(INC)).some((e) => e.type === 'review-passed')).toBe(true);
      expect(github).toEqual(['review APPROVE', 'check success']);

      // A fixer run on the same runner.
      await composed.deps?.fixer.runner.runFixer({
        runId: FIXER_RUN,
        workItem: { id: INC, issueKey: 'WEB-1042', repo: REPO },
        implementationRequestArtifactId: put.id,
        harness: { adapter: 'claude-code' },
        budget: { wallClock: 'PT30M', attempts: 1 },
      });
    } finally {
      if (savedPath === undefined) delete process.env['PATH'];
      else process.env['PATH'] = savedPath;
      await api.stop();
      await origin.remove();
    }

    const runs = (await readFile(join(bin, 'runs.jsonl'), 'utf8'))
      .trim()
      .split('\n')
      .map((l) => JSON.parse(l) as ContainerRun);
    const reviewRun = runs.find((r) => r.name.startsWith('snapwing-review-'));
    const fixerRun = runs.find((r) => r.name === `snapwing-fixer-${FIXER_RUN}`);
    if (reviewRun === undefined || fixerRun === undefined) throw new Error(`expected a review and a fixer container, got ${runs.map((r) => r.name).join(', ')}`);

    // The review container: the configured harness, the proxy as its base URL, and a model token.
    expect(reviewRun.env['SNAPWING_ROLE']).toBe('review');
    expect(reviewRun.env['SNAPWING_HARNESS']).toBe('generic');
    expect(reviewRun.env['SNAPWING_HARNESS_TEMPLATE']).toBe('aider');
    expect(reviewRun.env['ANTHROPIC_BASE_URL']).toBe(`${containerApi}/model/${INC}/anthropic`);
    expect(reviewRun.env['SNAPWING_FIXER_TOKEN']).toBeUndefined();
    expect(reviewRun.calls.modelToken).toEqual({ status: 200, body: expect.stringContaining('looks fine') });
    const keys = { secret: secrets['SNAPWING_FIXER_TOKEN_SECRET'] ?? '', clock: () => new Date() };
    const reviewToken = verifyModelToken(reviewRun.env['ANTHROPIC_API_KEY'] ?? '', INC, keys);
    if (!reviewToken.ok) throw new Error(`review model token: ${reviewToken.reason}`);
    expect(reviewToken.claims.runId).toBe(reviewRun.env['SNAPWING_RUN_ID']);
    // The review's wall clock (PT30M) plus the margin.
    expect(reviewToken.claims.expiresAt.getTime() - reviewToken.claims.issuedAt.getTime()).toBe(35 * 60_000);

    // The fixer container: its fixer API URL, and the model proxy where it reaches the server.
    expect(fixerRun.env['SNAPWING_API_URL']).toBe('http://fixer-api.invalid');
    expect(fixerRun.env['ANTHROPIC_BASE_URL']).toBe(`${containerApi}/model/${INC}/anthropic`);
    expect(fixerRun.env['SNAPWING_FIXER_TOKEN']).toMatch(/^swf1\./);
    expect(fixerRun.calls.modelToken).toEqual({ status: 200, body: expect.stringContaining('looks fine') });
    // A fixer token is not a model token: the proxy refuses it and never calls the provider.
    expect(fixerRun.calls.fixerToken?.status).toBe(401);
    expect(upstream).toHaveLength(2);

    // No provider key entered a container, and no container token reached the provider.
    for (const run of [reviewRun, fixerRun]) {
      for (const key of ['test-anthropic-key', 'test-openai-key', 'test-google-key']) expect(JSON.stringify(run.env)).not.toContain(key);
    }
    for (const call of upstream) {
      expect(call.apiKey).toBe('test-anthropic-key');
      expect(call.headers).not.toContain('swm1.');
      expect(call.headers).not.toContain('swf1.');
    }
    expect(unhandled).toEqual([]);
  }, 60_000);
});

const REPO = 'github.com/fake-org/web';
const REPO_FULL = 'fake-org/web';
const INC = '01K6COMPOSEREVIEW000000001';
const FIXER_RUN = '01K6COMPOSEFIXERRUN0000001';
const PR = 418;
const BRANCH = 'fix/WEB-1042';
const REQUEST_BODY = buildImplementationRequest({
  issue: 'WEB-1042',
  intent: 'Checkout total is wrong for an empty cart',
  evidence: [{ kind: 'report', source: 'slack', text: 'Checkout says 500' }],
  constraints: { scope: 'Only src/cart and its tests', tests: { required: false, text: 'No new test needed' }, forbidden: ['Do not touch .github/workflows'] },
  handoff: { mode: 'review', autonomy: 2, branch: BRANCH, base: 'main' },
});

/** What the fake docker CLI recorded of one container. */
interface ContainerRun {
  name: string;
  env: Record<string, string>;
  calls: { modelToken?: { status: number; body: string }; fixerToken?: { status: number; body: string } };
}

/**
 * A fake `docker` CLI (a Node script): `run` builds the container's environment from `-e` exactly as
 * docker would, then acts as the agent inside: one model call through `ANTHROPIC_BASE_URL` with the
 * container's `ANTHROPIC_API_KEY`, one with its fixer token when it has one, and a review writes an
 * approving verdict to `SNAPWING_REVIEW_FILE` in the mounted tree. Each run is appended to `runs.jsonl`.
 */
function fakeDocker(): string {
  const verdict = JSON.stringify({ verdict: 'approve', reasons: [], constraintViolations: [] });
  return `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
async function main() {
  if (args[0] !== 'run') return 0;
  const env = {};
  let mount = '';
  let name = '';
  for (let i = 1; i < args.length; i++) {
    const a = args[i];
    if (a === '-e') {
      const v = args[++i];
      const eq = v.indexOf('=');
      if (eq >= 0) env[v.slice(0, eq)] = v.slice(eq + 1);
      else env[v] = process.env[v] || '';
    } else if (a === '-v') {
      const [src, dst] = args[++i].split(':');
      if (dst === '/work') mount = src;
    } else if (a === '--name') name = args[++i];
  }
  const call = async (key) => {
    const res = await fetch(env.ANTHROPIC_BASE_URL + '/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'anthropic-version': '2023-06-01', 'x-api-key': key },
      body: JSON.stringify({ model: 'claude-test', max_tokens: 16, messages: [{ role: 'user', content: 'review this' }] }),
    });
    return { status: res.status, body: await res.text() };
  };
  const calls = {};
  if (env.ANTHROPIC_BASE_URL) {
    calls.modelToken = await call(env.ANTHROPIC_API_KEY);
    if (env.SNAPWING_FIXER_TOKEN) calls.fixerToken = await call(env.SNAPWING_FIXER_TOKEN);
  }
  if (env.SNAPWING_REVIEW_FILE && mount !== '') fs.writeFileSync(path.join(mount, env.SNAPWING_REVIEW_FILE.slice('/work/'.length)), ${JSON.stringify(verdict)});
  fs.appendFileSync(path.join(__dirname, 'runs.jsonl'), JSON.stringify({ name, env, calls }) + '\\n');
  return 0;
}
main().then((code) => process.exit(code), (e) => { console.error(String(e)); process.exit(1); });
`;
}

async function freePort(): Promise<number> {
  const probe = createNetServer();
  await new Promise<void>((resolve) => probe.listen(0, '127.0.0.1', resolve));
  const port = (probe.address() as AddressInfo).port;
  await new Promise<void>((resolve) => probe.close(() => resolve()));
  return port;
}

/** From capture to a PR the fixer opened: filed, the fixer ran and reported done, the PR is open. */
function incidentToPr(workspaceId: string, request: { artifactId: string; version: number }): NewEvent[] {
  const ev = (type: string, payload: unknown, source: 'agent' | 'fixer' = 'agent'): NewEvent =>
    ({ workspaceId, incidentId: INC, type, v: 1, source, occurredAt: new Date().toISOString(), payload }) as unknown as NewEvent;
  return [
    ev('captured', {
      kind: 'incident',
      idempotencyKey: `slack:C-FAKE:${INC}`,
      source: 'slack',
      reporter: { id: 'U-FAKE-REPORTER', name: 'Pat', role: 'reporter' },
      anchorText: 'Checkout says 500',
      channelId: 'C-FAKE',
    }),
    ev('context-assembled', { bundle: { artifactId: '01K6BUNDLE00000000000000001', version: 1 }, includedCount: 1, excludedCount: 0 }),
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: REPO, resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout total is wrong for an empty cart',
      priority: 'High',
      labels: ['snapwing'],
      autonomyLevel: 2,
      implementationRequest: request,
    }),
    ev('filed', { jiraKey: 'WEB-1042' }),
    ev('fixer-started', { runId: '01K6COMPOSEFIXERRUN0000000', harness: 'claude-code', attempt: 1 }),
    ev('fixer-done', { prNumber: PR, branch: BRANCH, summary: 'Fixed the empty cart total', testsAdded: [] }, 'fixer'),
    ev('pr-opened', { prNumber: PR, branch: BRANCH }, 'fixer'),
  ];
}

describe('the --api and --worker split on Postgres', () => {
  it.runIf(process.env['SNAPWING_DB'] === 'postgres')('an --api only process never queues again a job the worker process is running', async () => {
    const workerState = await tdb.open();
    const apiState = await tdb.open();
    const errors: unknown[] = [];
    const worker = createWorkflow(workerState, { worker: true }, (e) => errors.push(e)) as PgBossWorkflow;
    const api = createWorkflow(apiState, { worker: false }, (e) => errors.push(e)) as PgBossWorkflow;
    let release!: () => void;
    const released = new Promise<void>((r) => (release = r));
    let started!: () => void;
    const running = new Promise<void>((r) => (started = r));
    let deliveries = 0;
    worker.work('reconcile', async () => {
      deliveries += 1;
      started();
      await released;
    });
    try {
      await worker.startPolling();
      await api.start('reconcile', { from: 'api' }, {});
      await running;
      // The API process's recovery leaves the worker's active job alone.
      expect(await api.recover()).toEqual({ requeued: 0, timedOut: 0 });
    } finally {
      release();
      await worker.stop();
      await api.stop();
    }
    expect(deliveries).toBe(1);
    expect(errors).toEqual([]);
  });
});

describe('repository names', () => {
  it('reduces the map form github.com/owner/name to the owner/name GitHub uses', () => {
    for (const form of ['acme/web', 'github.com/acme/web', 'https://github.com/acme/web.git', 'git@github.com:acme/web.git', 'github.com/acme/web/']) {
      expect(repoFullName(form)).toBe('acme/web');
    }
    expect(sameRepo('github.com/acme/web', 'Acme/Web')).toBe(true);
    expect(sameRepo('github.com/acme/web', 'acme/website')).toBe(false);
    expect(sameRepo(undefined, 'acme/web')).toBe(false);
  });
});

// One incident end to end through the composed pieces --------------------------------------------

describe('one incident through the composed routes, jobs, and projectors', () => {
  it('runs the level 0 recording to filed and posts exactly one status message, then edits it', async () => {
    const recording = parseScenario('01-level-0-ticket-only.json', JSON.parse(await readFile(new URL('../../../../demo/levels/01-level-0-ticket-only.json', import.meta.url), 'utf8')));
    const channel = recording.channel.id;
    const slack = slackWorld(server, channel, recording.messages.map((m) => ({ type: 'message', ...m })));
    const jiraWorld = new JiraWorld(() => undefined);
    const githubWorld = new GitHubWorld(() => undefined);
    githubWorld.addRepos(recording.github);
    server.use(
      ...jiraHandlers(jiraWorld),
      ...githubHandlers(githubWorld),
      http.post(`${GITHUB_API}/app/installations/:id/access_tokens`, () =>
        HttpResponse.json({ token: DEMO_GITHUB_TOKEN, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 }),
      ),
    );
    // Generated per run, never committed: the App JWT is signed for real.
    const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048, privateKeyEncoding: { type: 'pkcs8', format: 'pem' }, publicKeyEncoding: { type: 'spki', format: 'pem' } });
    const secrets = { ...fakeSecrets(), JIRA_BASE_URL: JIRA_BASE, JIRA_EMAIL: DEMO_JIRA_EMAIL, JIRA_API_TOKEN: DEMO_JIRA_TOKEN, GITHUB_APP_PRIVATE_KEY: privateKey };

    const model = new RecordedModel();
    model.use(recording.name, recording.model);
    const booted = await bootComposed({
      state: await tdb.open(),
      configXml: await readFile(EXAMPLE_CONFIG, 'utf8'),
      secrets,
      dir,
      env: { SNAPWING_MAP: MAP, SNAPWING_WORKDIR_ROOT: join(dir, 'work') },
      overrides: { model: withValidation(model), resolveHarness: () => idleHarness, slackBotUserId: BOT_USER, projectorPollMs: 25 },
    });
    const { state, logged, errors } = booted;

    try {
      // "Fix it from here" on the anchor message.
      const anchor = recording.messages.find((m) => m.ts === recording.anchor);
      const action = {
        type: 'message_action',
        callback_id: 'fix_it_from_here',
        team: { domain: 'acme-test' },
        channel: { id: channel, name: recording.channel.name },
        user: { id: recording.reporter.id, name: recording.reporter.name },
        message_ts: recording.anchor,
        message: anchor,
      };
      expect((await booted.interact(action)).status).toBe(200);

      // The scope preview card; tap Looks right on it as the reporter.
      const card = await vi.waitFor(
        () => {
          const found = slack.calls.find((c) => c.method === 'chat.postMessage' && blockIds(c.body).includes('scope_actions'));
          if (found === undefined) throw new Error(`no scope card yet (${logged.join('; ')})`);
          return found;
        },
        { timeout: 20_000, interval: 25 },
      );
      const incidentId = String((card.body['blocks'] as { elements?: { value?: string }[] }[]).flatMap((b) => b.elements ?? [])[0]?.value);
      const tap = {
        type: 'block_actions',
        user: { id: recording.reporter.id },
        channel: { id: channel },
        container: { type: 'message', channel_id: channel, message_ts: card.ts },
        message: { ts: card.ts, thread_ts: recording.anchor, blocks: card.body['blocks'] },
        actions: [{ action_id: 'looks-right', block_id: 'scope_actions', value: incidentId, text: { type: 'plain_text', text: 'Looks right' } }],
      };
      expect((await booted.interact(tap)).status).toBe(200);

      // Filed by the Jira projector, then the status message by the Slack status projector, edited to the latest copy.
      await vi.waitFor(
        async () => {
          const view = await state.getIncident(incidentId);
          expect(view?.status).toBe('filed');
          expect(view?.statusMsgId).toBeDefined();
          // The after-filed step ran (level 0 waits on the owner) and its rows were sent.
          expect(jiraWorld.issues.get('HELP-1')?.custom['Agent Status']).toBe('filed · waiting on human');
          expect(await state.drainOutbox('slack', 10)).toEqual([]);
          expect(await state.drainOutbox('jira', 10)).toEqual([]);
        },
        { timeout: 30_000, interval: 50 },
      );
      const log = await state.read(incidentId);
      expect(log.filter((e) => e.type === 'status-message-posted')).toHaveLength(1);
      const statusPosts = slack.calls.filter((c) => c.method === 'chat.postMessage' && !blockIds(c.body).some((id) => id !== 'status_actions' && id.endsWith('_actions')));
      expect(statusPosts).toHaveLength(1);
      expect(slack.calls.filter((c) => c.method === 'pins.add')).toHaveLength(1);
      const statusTs = statusPosts[0]?.ts;
      expect((await state.getIncident(incidentId))?.statusMsgId).toBe(statusTs);
      // The scope card got its buttons replaced; every later status copy edited the one message.
      const edits = slack.calls.filter((c) => c.method === 'chat.update');
      expect(edits.some((c) => c.body['ts'] === card.ts)).toBe(true);
      expect(slack.unknown).toEqual([]);
      expect(unhandled).toEqual([]);
      expect(errors).toEqual([]);
      expect(logged).toEqual([]);
    } finally {
      await booted.stop();
    }
  }, 60_000);
});
