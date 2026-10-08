// Live tier: capture lookup-first, the Raycast scenario (main 15.3, 15.4, 11).
//
// The composed app runs in process over a real state database, the real Jira site and the real GitHub App on the
// fixture repository `ylove/snapwing-fixture-web`, and is driven through capture-client the way Raycast and the CLI
// drive it (the capture API is served through `fetch`, with no socket):
//
//   1. A stack trace naming a fixture file path answers `new`: the fixture surface, with the path as the evidence.
//      The same person sending it again is the same capture.
//   2. File it files a `[snapwing-test]` issue on the real Jira site.
//   3. The same trace from a second person (a second capture token) finds that issue in Jira's search and links to
//      it at once: `not-filed` ("Added this report to KEY."), and the second person becomes a watcher of the
//      incident that owns the issue. Nothing new is filed.
//
// The model is a fixed fake (live model calls belong to the e2e tier); Jira, GitHub and the database are real. A
// capture talks to no chat platform: compose still needs one configured, so Slack gets fake values here, and any
// request to slack.com fails the test instead of leaving the machine.
//
// Needs JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY, the four JIRA_FIELD_* ids, GITHUB_APP_ID,
// GITHUB_APP_PRIVATE_KEY and GITHUB_INSTALLATION_ID, from the environment or `.env.live` (SNAPWING_ENV_LIVE).
// Without them the whole file skips. GITHUB_APP_SLUG, GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET and
// GITHUB_WEBHOOK_SECRET are used when set and faked otherwise (a capture never uses them).
//
// Safety: the only issue created carries the `[snapwing-test]` prefix and this run's unique label, and the only
// repository touched is the fixture, read only. `afterAll` always runs: it stops the composition, deletes the issue
// (moving it to Done when the account cannot delete), and drops the database. No secret is logged or put in an
// assertion message.

import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it, vi } from 'vitest';
import { createCaptureClient, type CaptureClient } from '@snapwing/capture-client/client.ts';
import { loadAppConfig } from '@snapwing/pipeline/config/app-config.ts';
import { withValidation } from '@snapwing/pipeline/models/router.ts';
import type { HarnessPort } from '@snapwing/pipeline/ports/harness.ts';
import type { ClassifyRequest, CompletionResult, ModelBackend, RawClassifyResult, VisionResult } from '@snapwing/pipeline/ports/model.ts';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { StateStore } from '@snapwing/pipeline/state/store.ts';
import { ensureInstallWorkspace } from '@snapwing/pipeline/state/workspace.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { PgBossWorkflow } from '@snapwing/pipeline/workflow/pgboss/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createGitHubAuth } from '../../src/github/auth.ts';
import { createGitHubTransport } from '../../src/github/client.ts';
import { createJiraClient } from '../../src/jira/client/index.ts';
import { compose, type Composed } from '../../src/server/compose.ts';
import { createApiServer } from '../../src/server/http.ts';
import { createWorker, type Worker } from '../../src/server/worker.ts';
import { findEnvFile, readLiveEnv } from './helpers/env.ts';

const PREFIX = '[snapwing-test]';
const REPO = 'ylove/snapwing-fixture-web';
/** A file on the fixture repository's default branch (the durability test's scout names it too). */
const FIXTURE_FILE = 'src/cart.ts';
const ENDPOINT = 'http://snapwing.test';
const NAMES = [
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
] as const;
const env = await readLiveEnv(NAMES);
const hasSecrets = NAMES.every((n) => env[n] !== '');

const EXAMPLE_CONFIG = new URL('../../../../examples/snapwing.config.example.xml', import.meta.url);

/** A harness that must never run: the surface is level 0, so filing never starts a fixer. */
const idleHarness: HarnessPort = { run: () => Promise.reject(new Error('the harness was not expected to run')) };

describe.skipIf(!hasSecrets)('Capture lookup-first live tier: the Raycast scenario', () => {
  const projectKey = env.JIRA_PROJECT_KEY;
  const baseUrl = env.JIRA_BASE_URL.replace(/\/+$/, '');
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runLabel = `snapwing-live-${runId}`;
  /** Unique per run, so the lookup can only find this run's issue among the project's open ones. */
  const traceHead = `TypeError: Cannot read properties of undefined (reading "total-${runId}")`;
  const trace = `${traceHead}\n    at cartTotal (/usr/src/app/${FIXTURE_FILE}:12:9)`;

  const jira = createJiraClient({ baseUrl, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN, log: () => undefined });
  const fileSecrets = createEnvFileSecrets({ path: findEnvFile() });

  // What teardown must undo.
  let tdb: TestDatabase | undefined;
  let dir: string | undefined;
  let stop: (() => Promise<void>) | undefined;
  const issues = new Set<string>();

  // Nothing here talks to Slack. Compose needs a chat platform configured, so Slack has fake values; a request
  // that would reach slack.com is recorded and refused, and the test asserts there were none.
  const realFetch = globalThis.fetch;
  const slackCalls: string[] = [];
  globalThis.fetch = ((input: Parameters<typeof fetch>[0], init?: RequestInit): Promise<Response> => {
    const host = new URL(input instanceof Request ? input.url : String(input)).hostname;
    if (host === 'slack.com' || host.endsWith('.slack.com')) {
      slackCalls.push(host);
      return Promise.reject(new Error('the live capture test must not call Slack'));
    }
    return realFetch(input, init);
  }) as typeof fetch;

  /** Values the live env file does not hold; none is a real credential and none leaves this process. */
  const fakes: Record<string, string> = {
    SLACK_BOT_TOKEN: 'xoxb-live-capture-test',
    SLACK_SIGNING_SECRET: randomBytes(16).toString('hex'),
    SNAPWING_ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    SNAPWING_PUBLIC_URL: 'https://snapwing-live-test.example.invalid',
    SNAPWING_FIXER_TOKEN_SECRET: `live-fixer-${randomBytes(12).toString('hex')}`,
  };
  const optionalFakes: Record<string, string> = {
    GITHUB_APP_SLUG: 'snapwing-live-test',
    GITHUB_APP_CLIENT_ID: 'live-test-client-id',
    GITHUB_APP_CLIENT_SECRET: randomBytes(12).toString('hex'),
    GITHUB_WEBHOOK_SECRET: randomBytes(12).toString('hex'),
  };
  const secrets: SecretsPort = {
    get: async (name) => {
      const fake = fakes[name];
      if (fake !== undefined) return fake;
      if (name === 'GOOGLE_API_KEY') throw new SecretNotFoundError(name, 'the live test');
      const fallback = optionalFakes[name];
      if (fallback === undefined) return fileSecrets.get(name);
      return fileSecrets.get(name).catch(() => fallback);
    },
  };

  // Two people on the one fixture surface (level 0: filing never starts a fixer). Neither needs a chat id.
  const mapXml = `<?xml version="1.0" encoding="UTF-8"?>
<workspace xmlns="urn:snapwing:workspace:v1" org="snapwing-live" updated="2026-10-01T00:00:00Z">
  <surfaces>
    <surface id="fixture" label="Fixture Web">
      <repo>github.com/${REPO}</repo>
      <jira project="${projectKey}" defaultIssueType="Task" />
    </surface>
  </surfaces>
  <channels />
  <triggers>
    <cli enabled="true" />
  </triggers>
  <vocabulary>
    <term surface="fixture">the fixture</term>
  </vocabulary>
  <people>
    <person handle="liveEngineer" email="engineer@example.com" role="engineer">
      <owns surface="fixture" />
    </person>
    <person handle="liveReporter" email="reporter@example.com" role="reporter" />
  </people>
  <policies>
    <askBack maxQuestionsPerIncident="1" suppressWhenReportersAtLeast="3" />
    <autonomy default="0">
      <level id="0" name="ticket-only" fixer="never" merge="none" />
      <level id="1" name="fix-on-tap" fixer="on-tap" merge="human" />
      <level id="2" name="fix-now" fixer="immediate" merge="human" />
      <level id="3" name="autopilot" fixer="immediate" merge="agent" requires="review-agent ci-green risk-gate" />
    </autonomy>
    <riskGate maxFilesTouched="6" maxDiffLines="300" />
  </policies>
</workspace>
`;

  /** The fixed model: nothing resolves by words (the file path does), and triage files a Task under the prefix. */
  const backend: ModelBackend = {
    complete: (): Promise<CompletionResult> => Promise.reject(new Error('the live capture test records no free-text completions')),
    vision: (): Promise<VisionResult> => Promise.reject(new Error('the live capture test records no image readings')),
    classify: (request: ClassifyRequest<unknown>): Promise<RawClassifyResult> => {
      const answers: Record<string, unknown> = {
        'triage:resolution': { surfaceId: 'unknown', confidence: 0 },
        'triage:triage-plan': {
          action: 'create_issue',
          issueType: 'Task',
          summary: `${PREFIX} ${traceHead}`,
          description: 'Created by the Snapwing capture live test. Safe to close.',
          priority: 'Medium',
          labels: [runLabel],
        },
        'scout:scout-diagnosis': { confidence: 'low', files: [] },
      };
      const key = `${request.task}:${request.schemaName}`;
      if (!(key in answers)) return Promise.reject(new Error(`the live capture test has no model answer for ${key}`));
      return Promise.resolve({ value: answers[key], model: 'live/fixed' });
    },
  };

  async function deleteIssue(key: string): Promise<void> {
    const res = await realFetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=true`, {
      method: 'DELETE',
      headers: { Authorization: `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`, Accept: 'application/json' },
    });
    if (res.ok || res.status === 404) return;
    // The account cannot delete issues yet (403): the best teardown is to move the issue to Done.
    await jira.transitionIssue(key, 'Done');
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
    globalThis.fetch = realFetch;
    // The composition first, so nothing files while teardown runs.
    if (stop !== undefined) await attempt('stop composition', stop);
    // An issue whose answer was lost still carries this run's label.
    await attempt('search Jira by label', async () => {
      const page = await jira.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 50 });
      for (const issue of page.issues) issues.add(issue.key);
    });
    for (const key of issues) await attempt(`delete ${key}`, () => deleteIssue(key));
    if (tdb !== undefined) await attempt('drop database', () => tdb!.drop());
    if (dir !== undefined) await attempt('remove temp dir', () => rm(dir!, { recursive: true, force: true }));
    if (problems.length > 0) throw new Error(`teardown problems: ${problems.join('; ')}`);
  }, 120_000);

  it('a trace naming a fixture file is new; File it files; the same trace from another person links to that issue', { timeout: 300_000 }, async () => {
    // The fixture really holds the file the trace names, so a failure below is not a stale constant.
    const call = createGitHubTransport(createGitHubAuth({ secrets: fileSecrets }), { repo: REPO });
    const tree = await call({ method: 'GET', path: `/repos/${REPO}/git/trees/HEAD?recursive=1`, permissions: { contents: 'read' } });
    const paths = ((JSON.parse(tree.text) as { tree?: { path?: string }[] }).tree ?? []).map((t) => t.path);
    expect(paths, `${REPO} must hold ${FIXTURE_FILE}`).toContain(FIXTURE_FILE);

    dir = await mkdtemp(join(tmpdir(), 'snapwing-live-capture-'));
    tdb = await createTestDatabase();
    const state = await tdb.open();
    if (!(state instanceof StateStore)) throw new Error('expected the StateStore');
    const errors: unknown[] = [];
    const logged: string[] = [];
    const workflow =
      state.dialect === 'postgres'
        ? new PgBossWorkflow(state, { schema: 'pgboss', pollingIntervalSeconds: 0.5, onError: (e) => errors.push(e) })
        : new InProcessWorkflow(state, { pollIntervalMs: 100, onError: (e) => errors.push(e) });
    const mapFile = join(dir, 'map.xml');
    await writeFile(mapFile, mapXml);
    const composed: Composed = await compose({
      config: loadAppConfig(await readFile(EXAMPLE_CONFIG, 'utf8')),
      secrets,
      state,
      workflow,
      env: {
        SNAPWING_SLACK_TRANSPORT: 'http',
        SNAPWING_MAP: mapFile,
        SNAPWING_WORKDIR_ROOT: join(dir, 'work'),
        // Absent files: no playbook (the defaults) and no instructions, whatever the working directory holds.
        SNAPWING_PLAYBOOK: join(dir, 'playbook.xml'),
        SNAPWING_INSTRUCTIONS: join(dir, 'INSTRUCTIONS.md'),
      },
      log: { info: () => undefined, error: (l) => logged.push(l) },
      overrides: {
        model: withValidation(backend),
        resolveHarness: () => idleHarness,
        projectorPollMs: 500,
        // Skips the startup `auth.test`: no call reaches Slack.
        slackBotUserId: 'U0LIVECAPTURE',
        slackWorkspaceDomain: 'snapwing-live-test',
      },
    });
    const worker: Worker = await createWorker({ workflow, jobs: composed.jobs });
    for (const s of composed.workerServices ?? []) await s.start();
    const api = createApiServer({ routes: composed.routes, port: 0 });
    stop = async () => {
      for (const s of [...(composed.workerServices ?? [])].reverse()) await s.stop();
      await worker.stop();
      await state.close();
    };

    const workspaceId = await ensureInstallWorkspace(state);
    const clientFor = async (person: string): Promise<CaptureClient> => {
      const { token } = await state.issueCaptureToken({ workspaceId, person, label: 'live test' });
      return createCaptureClient({ endpoint: ENDPOINT, token, timeoutMs: 60_000, fetch: (input, init) => api.fetch(new Request(input, init)) });
    };
    const engineer = await clientFor('liveEngineer');
    const reporter = await clientFor('liveReporter');
    const eventTypes = async (incidentId: string): Promise<string[]> => (await state.read(incidentId)).map((e) => e.type);

    // 1. The trace names a fixture file: new, on the fixture surface, with the path as the evidence.
    const first = await engineer.sendText(trace);
    expect(first).toEqual({
      kind: 'new',
      captureId: first.captureId,
      surface: { id: 'fixture', label: 'Fixture Web' },
      evidence: FIXTURE_FILE,
      choices: [
        { id: 'file-it', label: 'File it' },
        { id: 'not-this-surface', label: 'Not this surface' },
        { id: 'cancel', label: 'Cancel' },
      ],
    });
    // The same person sending it again is the same capture, not a second one.
    expect(await engineer.sendText(trace)).toEqual(first);

    // 2. File it files a `[snapwing-test]` issue.
    const filed = await engineer.answer(first.captureId, 'file-it');
    if (filed.kind !== 'filed') throw new Error(`File it answered ${filed.kind}, not filed`);
    issues.add(filed.issueKey);
    expect(filed.url).toBe(`${baseUrl}/browse/${filed.issueKey}`);
    expect(filed.issueKey.startsWith(`${projectKey}-`)).toBe(true);
    expect(String((await jira.getIssue(filed.issueKey, { fields: ['summary'] })).fields['summary']).startsWith(PREFIX)).toBe(true);
    // Settled: the filed incident has finished remembering the issue before the second report arrives.
    await vi.waitFor(async () => {
      const types = await eventTypes(first.captureId);
      expect(types.slice(types.indexOf('filed'))).toContain('waiting-changed');
    }, { timeout: 60_000, interval: 500 });
    // Jira's search index trails a create by a few seconds; the lookup must be able to see the issue.
    await vi.waitFor(async () => {
      const page = await jira.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 5 });
      expect(page.issues.map((i) => i.key)).toContain(filed.issueKey);
    }, { timeout: 60_000, interval: 2_000 });

    // 3. Another person sends the same trace: the lookup finds the open issue and links to it at once.
    const second = await reporter.sendText(trace);
    expect(second).toEqual({ kind: 'not-filed', captureId: second.captureId, reason: `Added this report to ${filed.issueKey}.` });
    expect(second.captureId).not.toBe(first.captureId);
    expect(await reporter.poll(second.captureId)).toEqual(second);
    expect(await state.getIncident(second.captureId)).toMatchObject({ status: 'linked-to-existing', jiraKey: filed.issueKey });
    expect(await eventTypes(second.captureId)).toEqual(expect.arrayContaining(['dedupe-decided', 'linked-to-existing']));
    // Nothing new was filed, and the first incident gained the second person as a watcher.
    const created = await jira.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 10 });
    expect(created.issues.map((i) => i.key)).toEqual([filed.issueKey]);
    expect((await state.getSubscriptions(first.captureId)).map((s) => s.userId)).toEqual(['liveReporter']);
    const watches = (await state.read(first.captureId)).filter((e) => e.type === 'comment' && e.payload.intent === 'watch');
    expect(watches).toMatchObject([{ actor: { id: 'liveReporter' }, source: 'cli' }]);

    // Quiet: no job threw, compose logged no error, and nothing reached Slack.
    expect(errors).toEqual([]);
    expect(logged).toEqual([]);
    expect(slackCalls).toEqual([]);
  });
});
