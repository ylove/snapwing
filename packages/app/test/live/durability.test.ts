// Live tier: durable park and reconciliation (B 11 live rows, B 5, B 8).
//
//   1. "Kill the worker mid-awaitInteractive, restart, tap the button: the job resumes and files the ticket."
//      The composed app runs over a real state database with the real Slack Web API (test channel), the real
//      Jira site and the real GitHub App. A message shortcut starts an incident, the scope card is posted for
//      real and the job parks on `{ kind: 'tap' }`. The whole process is then taken down (every service
//      stopped, the worker drained, the database handle closed) so only the database survives, and a second
//      composition is booted over the same database. The tap is delivered to that second process, and the job
//      resumes and files a Jira issue. Slack user tokens cannot press buttons, so the tap is a `block_actions`
//      payload signed with SLACK_SIGNING_SECRET and sent to the server's interactivity handler, exactly what
//      Slack would send; the card it taps is the one Slack really holds.
//   2. "Suppress the CI webhook; the reconciler emits ci-green within one cron cycle."
//      A real pull request and a successful `snapwing/review` check run exist on the fixture repository, and the
//      incident's log (seeded) says it has waited on CI for 40 minutes. No GitHub webhook is ever delivered (the
//      suppression), and no tunnel is used. The test shortens the schedule to every minute.
//
// The model is a fixed fake (live model calls belong to the e2e tier); Slack, Jira, GitHub and the database are real.
//
// Needs the Slack, Jira and GitHub App secrets of build/CONTEXT.md 6b plus SLACK_TEST_CHANNEL, SLACK_TEST_REPORTER_ID
// and SLACK_TEST_ENGINEER_ID, from the environment or `.env.live` (SNAPWING_ENV_LIVE). Without them the whole file
// skips. SNAPWING_DB / DATABASE_URL pick the dialect as everywhere else (default SQLite, a temp file).
//
// Safety: posts go to SLACK_TEST_CHANNEL only, the anchor message and every Jira summary start with
// `[snapwing-test]`, the only repository touched is `ylove/snapwing-fixture-web` (one `test/live-*` branch and one
// pull request, closed and deleted), and `afterAll` always runs: it stops both compositions, unpins and deletes every
// Slack message the app posted (recorded from the Web API responses), moves every Jira issue the run created to Done
// (the account cannot delete issues yet), closes the pull request, deletes the branch, and drops the database. No
// secret is logged or put in an assertion message.

import { randomBytes, createHmac } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { loadAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import type { EventPayloads, EventType, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionResult } from '@snapwing/pipeline/ports/model.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { RECONCILE_JOB } from '@snapwing/pipeline/reconcile/job.ts';
import { readStoreMetrics } from '@snapwing/pipeline/state/metrics.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { PgBossWorkflow } from '@snapwing/pipeline/workflow/pgboss/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createGitHubAuth } from '../../src/github/auth.ts';
import { REVIEW_CHECK_NAME, createGitHubClient, createGitHubTransport } from '../../src/github/client.ts';
import { createJiraClient } from '../../src/jira/client/index.ts';
import { createSlackWeb } from '../../src/adapters/slack/web.ts';
import { compose, type Composed } from '../../src/server/compose.ts';
import { createApiServer, type ApiServer } from '../../src/server/http.ts';
import { createWorker, type Worker } from '../../src/server/worker.ts';
import { findEnvFile, readLiveEnv } from './helpers/env.ts';

const PREFIX = '[snapwing-test]';
const REPO = 'ylove/snapwing-fixture-web';
const R = `/repos/${REPO}`;
const BASE = 'main';
const NAMES = [
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'SLACK_TEST_CHANNEL',
  'SLACK_TEST_REPORTER_ID',
  'SLACK_TEST_ENGINEER_ID',
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'JIRA_FIELD_IMPL_PROMPT',
  'JIRA_FIELD_CONVERSATION',
  'JIRA_FIELD_AUTONOMY',
  'JIRA_FIELD_AGENT_STATUS',
  'GITHUB_APP_ID',
  'GITHUB_APP_PRIVATE_KEY',
  'GITHUB_INSTALLATION_ID',
  'GITHUB_APP_SLUG',
  'GITHUB_APP_CLIENT_ID',
  'GITHUB_APP_CLIENT_SECRET',
  'GITHUB_WEBHOOK_SECRET',
] as const;
const env = await readLiveEnv(NAMES);
const hasSecrets = NAMES.every((n) => env[n] !== '');

const EXAMPLE_CONFIG = new URL('../../../../examples/snapwing.config.example.xml', import.meta.url);
const MINUTE = 60_000;

/** A harness that must never run: neither test reaches the fixer. */
const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the harness was not expected to run')) };

interface Posted {
  ts: string;
  channel: string;
  body: Record<string, unknown>;
}

interface Instance {
  composed: Composed;
  state: OpenedState;
  workflow: InProcessWorkflow | PgBossWorkflow;
  api: ApiServer;
  /** Errors the workflow reported (a job that threw). */
  errors: unknown[];
  /** Lines compose logged as errors. */
  logged: string[];
  prCards: string[];
  worker: Worker;
  stop(): Promise<void>;
  stopped: boolean;
}

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!hasSecrets)('Durability live tier: park across a restart, and the reconciler', () => {
  const channel = env.SLACK_TEST_CHANNEL;
  const projectKey = env.JIRA_PROJECT_KEY;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runLabel = `snapwing-live-${runId}`;
  const baseUrl = env.JIRA_BASE_URL.replace(/\/+$/, '');

  const web = createSlackWeb({ token: env.SLACK_BOT_TOKEN });
  const jira = createJiraClient({ baseUrl, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN, log: () => undefined });
  const fileSecrets = createEnvFileSecrets({ path: findEnvFile() });
  const githubAuth = createGitHubAuth({ secrets: fileSecrets });
  const githubClient = createGitHubClient(githubAuth, { repo: REPO });
  const githubCall = createGitHubTransport(githubAuth, { repo: REPO });

  // What teardown must undo.
  const instances: Instance[] = [];
  const databases: TestDatabase[] = [];
  const dirs: string[] = [];
  const issues = new Set<string>();
  const posts: Posted[] = [];
  const pins = new Set<string>();
  let prNumber: number | undefined;
  let branch: string | undefined;

  // Every chat.postMessage and pins.add the app makes goes through this wrapper, which records what it posted so
  // the test can find the cards by their blocks and teardown can delete them. Restored in afterAll.
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const res = await realFetch(input, init);
    try {
      const url = new URL(input instanceof Request ? input.url : String(input));
      if (url.hostname === 'slack.com' && (url.pathname === '/api/chat.postMessage' || url.pathname === '/api/pins.add')) {
        const raw = input instanceof Request ? await input.clone().text() : typeof init?.body === 'string' ? init.body : '';
        const body = (raw === '' ? {} : JSON.parse(raw)) as Record<string, unknown>;
        const answer = (await res.clone().json()) as { ok?: boolean; ts?: string; channel?: string };
        if (answer.ok === true && url.pathname === '/api/chat.postMessage' && typeof answer.ts === 'string') {
          posts.push({ ts: answer.ts, channel: String(answer.channel ?? body['channel']), body });
        } else if (answer.ok === true && url.pathname === '/api/pins.add') {
          pins.add(String(body['timestamp']));
        }
      }
    } catch {
      // Recording is best effort; the test's own assertions catch a missing card.
    }
    return res;
  }) as typeof fetch;

  /** Fakes for the three secrets the live env file does not hold; they never leave this process. */
  const fakes: Record<string, string> = {
    SNAPWING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SNAPWING_PUBLIC_URL: 'https://snapwing-live-test.example.invalid',
    SNAPWING_FIXER_TOKEN_SECRET: `live-fixer-${randomBytes(12).toString('hex')}`,
  };
  const secrets: SecretsPort = {
    get: async (name) => {
      const fake = fakes[name];
      if (fake !== undefined) return fake;
      if (name === 'GOOGLE_API_KEY') throw new SecretNotFoundError(name, 'the live test');
      return fileSecrets.get(name);
    },
  };

  // The workspace map: one surface on the fixture repository and the OAJ project, one channel (the test channel),
  // the test reporter and engineer. Level 1 so nothing is ever merged by the agent.
  const mapXml = (level: 0 | 1): string => `<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="snapwing-live" updated="2026-10-01T00:00:00Z">
  <surfaces>
    <surface id="fixture" label="Fixture Web">
      <repo>github.com/${REPO}</repo>
      <jira project="${projectKey}" defaultIssueType="Task" />
    </surface>
  </surfaces>
  <channels>
    <channel id="${channel}" name="snapwing-test" surface="fixture" confidence="explicit" />
  </channels>
  <triggers>
    <messageAction label="Fix it from here" />
    <emoji slack="bug" teams="bug" />
  </triggers>
  <vocabulary>
    <term surface="fixture">the fixture</term>
  </vocabulary>
  <people>
    <person slackId="${env.SLACK_TEST_ENGINEER_ID}" handle="liveEngineer" email="engineer@example.com" role="engineer">
      <owns surface="fixture" />
    </person>
    <person slackId="${env.SLACK_TEST_REPORTER_ID}" handle="liveReporter" email="reporter@example.com" role="reporter" />
  </people>
  <policies>
    <askBack maxQuestionsPerIncident="1" suppressWhenReportersAtLeast="3" />
    <autonomy default="${level}">
      <level id="0" name="ticket-only" fixer="never" merge="none" />
      <level id="1" name="fix-on-tap" fixer="on-tap" merge="human" />
      <level id="2" name="fix-now" fixer="immediate" merge="human" />
      <level id="3" name="autopilot" fixer="immediate" merge="agent" requires="review-agent ci-green risk-gate" />
    </autonomy>
    <riskGate maxFilesTouched="6" maxDiffLines="300" />
  </policies>
</workspace>
`;

  /** The fixed model: the one anchor message is the incident, the scout names a real file, triage files a Task. */
  let anchorTs = '';
  const backend: ModelBackend = {
    complete: (): Promise<CompletionResult> => Promise.reject(new Error('the live durability test records no free-text completions')),
    vision: (): Promise<VisionResult> => Promise.reject(new Error('the live durability test records no image readings')),
    classify: (request: ClassifyRequest<unknown>): Promise<RawClassifyResult> => {
      const answers: Record<string, unknown> = {
        segmentation: { included: [anchorTs], excluded: [], resolutionMessageId: '' },
        scout: { confidence: 'high', files: [{ path: 'src/cart.ts', note: 'The cart total is computed here.' }] },
        triage: {
          action: 'create_issue',
          issueType: 'Task',
          summary: `${PREFIX} cart total is wrong when the cart is empty ${runId}`,
          description: 'Created by the Snapwing durability live test. Safe to close.',
          priority: 'Medium',
          labels: [runLabel],
        },
      };
      if (!(request.task in answers)) return Promise.reject(new Error(`the live durability test has no model answer for ${request.task}`));
      return Promise.resolve({ value: answers[request.task], model: 'live/fixed' });
    },
  };

  async function boot(input: { state: OpenedState; dir: string; level: 0 | 1; reconcileCron?: string }): Promise<Instance> {
    const { state, dir } = input;
    if (!(state instanceof StateStore)) throw new Error('expected the StateStore');
    const errors: unknown[] = [];
    const logged: string[] = [];
    const prCards: string[] = [];
    const workflow =
      state.dialect === 'postgres'
        ? new PgBossWorkflow(state, { schema: 'pgboss', pollingIntervalSeconds: 0.5, cronIntervalSeconds: 5, onError: (e) => errors.push(e) })
        : new InProcessWorkflow(state, { pollIntervalMs: 100, onError: (e) => errors.push(e) });
    const mapFile = join(dir, 'map.xml');
    await writeFile(mapFile, mapXml(input.level));
    const config = loadAppConfig(await readFile(EXAMPLE_CONFIG, 'utf8'));
    const composed = await compose({
      config,
      secrets,
      state,
      workflow,
      // Taps arrive over HTTP (signed), so no Socket Mode connection is opened.
      env: { SNAPWING_SLACK_TRANSPORT: 'http', SNAPWING_MAP: mapFile, SNAPWING_WORKDIR_ROOT: join(dir, 'work') },
      log: { info: () => undefined, error: (l) => logged.push(l) },
      overrides: {
        model: withValidation(backend),
        resolveHarness: () => idleHarness,
        projectorPollMs: 500,
        // The PR card is not posted in the reconciler test: only that the follow-up reached the human path matters.
        prReadyChat: {
          postPrReady: (_target, incidentId) => {
            prCards.push(incidentId);
            return Promise.resolve();
          },
          postLinkPrompt: () => Promise.resolve(),
        },
      },
    });
    const worker = await createWorker({ workflow, jobs: composed.jobs });
    for (const s of composed.workerServices ?? []) {
      // The schedule is the one thing the test sets itself: the default is every 15 minutes.
      if (s.name === 'reconcile schedule' && input.reconcileCron !== undefined) await workflow.cron(RECONCILE_JOB, input.reconcileCron);
      else await s.start();
    }
    const api = createApiServer({ routes: composed.routes, port: 0 });
    const instance: Instance = {
      composed,
      state,
      workflow,
      api,
      errors,
      logged,
      prCards,
      worker,
      stopped: false,
      stop: async () => {
        if (instance.stopped) return;
        instance.stopped = true;
        for (const s of [...(composed.workerServices ?? [])].reverse()) await s.stop();
        await worker.stop();
        await state.close();
      },
    };
    instances.push(instance);
    return instance;
  }

  /** Slack's request signature (`v0` HMAC over the timestamp and body) under the real signing secret. */
  function signed(body: string): Headers {
    const timestamp = String(Math.floor(Date.now() / 1000));
    const signature = `v0=${createHmac('sha256', env.SLACK_SIGNING_SECRET).update(`v0:${timestamp}:${body}`).digest('hex')}`;
    return new Headers({ 'content-type': 'application/x-www-form-urlencoded', 'x-slack-request-timestamp': timestamp, 'x-slack-signature': signature });
  }
  async function interact(instance: Instance, payload: Record<string, unknown>): Promise<Response> {
    const body = new URLSearchParams({ payload: JSON.stringify(payload) }).toString();
    return instance.api.fetch(new Request('http://snapwing.test/slack/interactivity', { method: 'POST', headers: signed(body), body }));
  }

  function blockIds(body: Record<string, unknown>): string[] {
    const blocks = Array.isArray(body['blocks']) ? (body['blocks'] as Record<string, unknown>[]) : [];
    return blocks.flatMap((b) => (typeof b['block_id'] === 'string' ? [b['block_id']] : []));
  }
  function buttons(post: Posted, blockId: string): { action_id: string; value: string; text: { text: string } }[] {
    const blocks = post.body['blocks'] as { block_id?: string; elements?: { action_id: string; value: string; text: { text: string } }[] }[];
    return blocks.find((b) => b.block_id === blockId)?.elements ?? [];
  }
  const WAIT = { timeout: 90_000, interval: 500 };
  async function card(blockId: string, since: number): Promise<Posted> {
    return vi.waitFor(() => {
      const found = posts.slice(since).filter((p) => blockIds(p.body).includes(blockId)).at(-1);
      if (found === undefined) throw new Error(`no ${blockId} card yet`);
      return found;
    }, WAIT);
  }

  async function closeJiraIssue(key: string): Promise<void> {
    const res = await fetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=true`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`, Accept: 'application/json' },
    });
    if (res.ok || res.status === 404) return;
    // The account cannot delete issues yet (403): the best teardown is to move the issue to Done.
    await jira.transitionIssue(key, 'Done');
  }

  async function slackApi(method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
    const res = await realFetch(`https://slack.com/api/${method}`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.SLACK_BOT_TOKEN}`, 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify(body),
    });
    return (await res.json()) as Record<string, unknown>;
  }

  afterAll(async () => {
    const problems: string[] = [];
    const attempt = async (what: string, fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        problems.push(`${what}: ${err instanceof Error ? err.message : String(err)}`);
      }
    };
    // Compositions first, so nothing posts or files while teardown runs.
    for (const instance of instances) await attempt('stop composition', () => instance.stop());
    // An issue whose answer was lost still carries this run's label.
    await attempt('search Jira by label', async () => {
      const page = await jira.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 50 });
      for (const issue of page.issues) issues.add(issue.key);
    });
    for (const key of issues) await attempt(`close ${key}`, () => closeJiraIssue(key));
    for (const ts of pins) {
      await attempt(`unpin ${ts}`, async () => {
        const r = await slackApi('pins.remove', { channel, timestamp: ts });
        if (r['ok'] !== true && r['error'] !== 'no_pin' && r['error'] !== 'message_not_found') throw new Error(String(r['error']));
      });
    }
    // Newest first, so replies go before their parents; the anchor message was posted by this test.
    for (const p of [...posts].reverse()) {
      await attempt(`delete ${p.ts}`, async () => {
        const r = await slackApi('chat.delete', { channel: p.channel, ts: p.ts });
        if (r['ok'] !== true && r['error'] !== 'message_not_found') throw new Error(String(r['error']));
      });
    }
    if (prNumber !== undefined) {
      const n = prNumber;
      await attempt(`close PR ${String(n)}`, () => githubClient.closePullRequest(n, 'Live durability test finished; closing.').then(() => undefined));
    }
    if (branch !== undefined) {
      const b = branch;
      await attempt(`delete ${b}`, async () => {
        try {
          await githubClient.deleteBranch(b);
        } catch (err) {
          if (!(err instanceof Error && /\b(404|422)\b/.test(err.message))) throw err;
        }
      });
    }
    for (const tdb of databases) await attempt('drop database', () => tdb.drop());
    for (const dir of dirs) await attempt('remove temp dir', () => rm(dir, { recursive: true, force: true }));
    globalThis.fetch = realFetch;
    if (problems.length > 0) throw new Error(`teardown problems: ${problems.join('; ')}`);
  }, 180_000);

  it('survives a restart while parked on a tap: the tap after the restart resumes the job and files the ticket', async () => {
    await web.conversationsJoin(channel);
    const dir = await mkdtemp(join(tmpdir(), 'snapwing-live-durability-'));
    dirs.push(dir);
    const tdb = await createTestDatabase();
    databases.push(tdb);

    // The incident's anchor: a message this test posts, under the safety prefix.
    const anchor = await web.postMessage({ channel, text: `${PREFIX} cart total is wrong when the cart is empty ${runId}` });
    posts.push({ ts: anchor.ts, channel, body: {} });
    anchorTs = anchor.ts;

    // First process: the shortcut starts the incident and the scope card parks the job.
    const first = await boot({ state: await tdb.open(), dir, level: 0 });
    const shortcut = await interact(first, {
      type: 'message_action',
      callback_id: 'fix_it_from_here',
      channel: { id: channel, name: 'snapwing-test' },
      user: { id: env.SLACK_TEST_REPORTER_ID, name: 'liveReporter' },
      message_ts: anchorTs,
      message: { type: 'message', ts: anchorTs, text: `${PREFIX} cart total is wrong when the cart is empty ${runId}` },
    });
    expect(shortcut.status).toBe(200);
    const scope = await card('scope_actions', 0);
    const incidentId = buttons(scope, 'scope_actions')[0]?.value ?? '';
    expect(incidentId).not.toBe('');

    // Parked: the incident waits on a human, a wait row exists, and nothing was filed.
    await vi.waitFor(async () => {
      expect((await first.state.getIncident(incidentId))?.waitingOn?.kind).toBe('human');
      expect((await readStoreMetrics(first.state)).parkedJobs).toBe(1);
    }, WAIT);
    const before = (await first.state.read(incidentId)).map((e) => e.type);
    expect(before).not.toContain('filed');
    expect((await jira.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 5 })).issues).toEqual([]);

    // Kill the worker: every service stopped, the worker drained, the database handle closed. Only the database survives.
    await first.stop();

    // Second process over the same database. Still parked, still unfiled.
    const second = await boot({ state: await tdb.open(), dir, level: 0 });
    expect((await second.state.getIncident(incidentId))?.waitingOn?.kind).toBe('human');
    expect((await readStoreMetrics(second.state)).parkedJobs).toBe(1);
    expect((await second.state.read(incidentId)).map((e) => e.type)).toEqual(before);

    // The tap, as Slack would send it (a user token cannot press a button, so it is the signed payload), on the
    // very card Slack holds.
    const button = buttons(scope, 'scope_actions').find((b) => b.action_id === 'looks-right');
    expect(button).toBeDefined();
    const tapped = await interact(second, {
      type: 'block_actions',
      user: { id: env.SLACK_TEST_REPORTER_ID },
      channel: { id: scope.channel },
      container: { type: 'message', channel_id: scope.channel, message_ts: scope.ts },
      message: { ts: scope.ts, thread_ts: anchorTs, blocks: scope.body['blocks'] },
      actions: [{ action_id: 'looks-right', block_id: 'scope_actions', value: button?.value ?? '', text: { type: 'plain_text', text: button?.text.text ?? '' } }],
    });
    expect(tapped.status).toBe(200);

    // The job resumed in the second process and filed the ticket.
    const key = await vi.waitFor(async () => {
      const incident = await second.state.getIncident(incidentId);
      if (incident?.jiraKey === undefined) throw new Error(`not filed yet (${second.logged.join('; ')}; ${second.errors.map(String).join('; ')})`);
      return incident.jiraKey;
    }, { timeout: 120_000, interval: 500 });
    issues.add(key);
    const issue = await jira.getIssue(key, { fields: ['summary', 'labels'] });
    expect(String(issue.fields['summary']).startsWith(PREFIX)).toBe(true);
    expect(issue.fields['labels']).toEqual(expect.arrayContaining([runLabel]));
    const after = (await second.state.read(incidentId)).map((e) => e.type);
    expect(after).toEqual(expect.arrayContaining<EventType>(['captured', 'planned', 'filed']));
    expect(after.filter((t) => t === 'filed')).toHaveLength(1);
    expect((await readStoreMetrics(second.state)).parkedJobs).toBe(0);
    // The status message is posted by the second process, once.
    await vi.waitFor(async () => expect((await second.state.getIncident(incidentId))?.statusMsgId).toBeDefined(), WAIT);
    expect(second.errors).toEqual([]);
    expect(second.logged).toEqual([]);
  }, 300_000);

  it('emits ci-green from the reconciler within one cron cycle when the CI webhook never arrives', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'snapwing-live-reconcile-'));
    dirs.push(dir);
    const tdb = await createTestDatabase();
    databases.push(tdb);

    // A real pull request on the fixture repository whose required check is green on GitHub.
    const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    branch = `test/live-reconcile-${id}`;
    const json = async (method: string, apiPath: string, permissions: Record<string, 'read' | 'write'>, body?: unknown): Promise<Record<string, unknown>> => {
      const res = await githubCall({ method, path: apiPath, permissions, ...(body === undefined ? {} : { body }) });
      return res.text === '' ? {} : (JSON.parse(res.text) as Record<string, unknown>);
    };
    const ref = await json('GET', `${R}/git/ref/heads/${BASE}`, { contents: 'read' });
    await json('POST', `${R}/git/refs`, { contents: 'write' }, { ref: `refs/heads/${branch}`, sha: (ref['object'] as { sha: string }).sha });
    const put = await json('PUT', `${R}/contents/src/live-reconcile-${id}.ts`, { contents: 'write' }, {
      message: `test: live reconcile probe ${id}`,
      content: Buffer.from(`// Created by the Snapwing live tier; safe to delete.\nexport const liveProbe = '${id}';\n`).toString('base64'),
      branch,
    });
    const headSha = (put['commit'] as { sha: string }).sha;
    const pr = await json('POST', `${R}/pulls`, { pull_requests: 'write', contents: 'read' }, {
      title: `${PREFIX} reconcile probe ${id}`,
      head: branch,
      base: BASE,
      body: 'Opened and closed by the Snapwing live tier. Safe to ignore.',
    });
    const number = pr['number'] as number;
    prNumber = number;
    const check = await githubClient.createCheckRun({ headSha, status: 'in_progress', output: { title: 'Snapwing review', summary: 'Live reconcile probe.' } });
    await githubClient.updateCheckRun(check.id, { status: 'completed', conclusion: 'success', output: { title: 'Snapwing review', summary: 'Live reconcile probe passed.' } });
    expect((await githubClient.combinedStatus(headSha, BASE)).required).toEqual([{ name: REVIEW_CHECK_NAME, state: 'success', source: 'check-run' }]);

    // An incident that opened its PR, passed review, and has waited on CI for 40 minutes: its webhook "never arrived".
    const state = await tdb.open();
    const workspaceId = await ensureInstallWorkspace(state);
    const incidentId = ulid();
    const at = new Date(Date.now() - 40 * MINUTE).toISOString();
    const ev = <T extends EventType>(type: T, payload: EventPayloads[T], source: 'agent' | 'github' | 'jira' | 'fixer' = 'agent'): NewEvent<T> =>
      ({ workspaceId, incidentId, type, v: 1, source, occurredAt: at, payload }) as unknown as NewEvent<T>;
    await state.append(
      incidentId,
      [
        ev('captured', {
          kind: 'incident',
          idempotencyKey: `slack:${channel}:${incidentId}`,
          source: 'slack',
          reporter: { id: env.SLACK_TEST_REPORTER_ID, name: 'liveReporter', role: 'reporter' },
          anchorText: `${PREFIX} reconcile ${runId}`,
          channelId: channel,
        }),
        ev('context-assembled', { bundle: { artifactId: ulid(), version: 1 }, includedCount: 1, excludedCount: 0 }),
        ev('resolved', { surfaceId: 'fixture', repo: `github.com/${REPO}`, resolvedBy: 'channel-explicit', confidence: 0.9 }),
        ev('dedupe-checked', { candidates: [], decision: 'none' }),
        ev('planned', {
          action: 'create_issue',
          projectKey,
          issueType: 'Task',
          summary: `${PREFIX} reconcile probe ${runId}`,
          priority: 'Medium',
          labels: [runLabel],
          autonomyLevel: 1,
          implementationRequest: { artifactId: ulid(), version: 1 },
        }),
        // A key that does not exist: the reconciler's Jira read answers "gone" and moves on.
        ev('filed', { jiraKey: `${projectKey}-999999` }),
        ev('fixer-started', { runId: `${incidentId}-run`, harness: 'claude-code', attempt: 1 }),
        ev('pr-opened', { prNumber: number, branch: branch ?? '' }, 'fixer'),
        ev('review-passed', { prNumber: number }),
        ev('waiting-changed', { waitingOn: { kind: 'ci', who: 'required checks' } }),
      ],
      0,
    );
    expect((await state.getIncident(incidentId))?.waitingOn?.kind).toBe('ci');

    // The app runs with its schedule shortened to every minute. No webhook is ever delivered to /webhooks/github.
    const instance = await boot({ state, dir, level: 1, reconcileCron: '* * * * *' });
    const started = Date.now();
    const green = await vi.waitFor(async () => {
      const found = (await state.read(incidentId)).filter((e) => e.type === 'ci-green');
      if (found.length === 0) throw new Error(`no ci-green yet (${instance.logged.join('; ')}; ${instance.errors.map(String).join('; ')})`);
      return found;
    }, { timeout: 150_000, interval: 1000 });
    const waited = Date.now() - started;

    expect(green).toHaveLength(1);
    expect(green[0]).toMatchObject({ source: 'agent', payload: { prNumber: number, headSha, reconciled: true } });
    // One cycle of the shortened schedule, plus the poll and the GitHub reads.
    expect(waited).toBeLessThan(MINUTE + 45_000);
    expect((await state.getIncident(incidentId))?.status).toBe('mergeable');

    // The follow-up reached the merge step, which at level 1 asks a human and merges nothing.
    await vi.waitFor(() => expect(instance.prCards).toEqual([incidentId]), { timeout: 60_000, interval: 500 });
    expect((await githubClient.getPullRequest(number)).merged).toBe(false);
    // A later cycle emits nothing more.
    await sleep(MINUTE + 10_000);
    expect((await state.read(incidentId)).filter((e) => e.type === 'ci-green')).toHaveLength(1);
    expect(instance.errors).toEqual([]);
    expect(instance.logged).toEqual([]);
  }, 400_000);
});
