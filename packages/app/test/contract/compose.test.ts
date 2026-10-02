// The composition root (#159; main 14.1, main 14.3, B 7.1, B 9) booted for real: `snapwing serve` with
// the real `compose`, the example config, the demo workspace map, fake secrets in an env file, MSW
// standing in for Slack, Jira, and GitHub, and a fake harness. Runs on the dialect `SNAPWING_DB`
// selects (pg-boss on Postgres). The last test runs the level 0 demo recording through the composed
// routes, jobs, and projectors and counts the status messages Slack receives; the world it runs in
// (fixtures/e2e/world.ts) is shared with the levels 1 and 2 end to end test (e2e-levels.test.ts).

import { generateKeyPairSync } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '@snapwing/pipeline/config/app-config.ts';
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
import type { SocketLike } from '../../src/adapters/slack/transport.ts';
import { repoFullName, sameRepo } from '../../src/github/repo.ts';
import { compose, mergePrometheus, MissingSecretsError, type Composed, type ComposeFn, type ComposeOverrides } from '../../src/server/compose.ts';
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
      HttpResponse.json(request.headers.get('authorization') === 'Bearer xoxb-test' ? { ok: true, user_id: BOT_USER } : { ok: false, error: 'invalid_auth' }),
    ),
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
    expect(log).toContain('worker polling (7 job types)');
    for (const service of ['reconcile schedule', 'jira projector', 'slack status projector', 'slack http transport']) expect(log).toContain(`${service} started`);

    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.text()).toBe('ok');

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
    expect(calls).toEqual([`POST slack.com/api/auth.test`]);
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
