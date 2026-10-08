// Live tier: Jira Cloud against the owner's real site (main 14.4, B 7).
// Needs JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN, JIRA_PROJECT_KEY and the four JIRA_FIELD_* ids that
// `pnpm jira:bootstrap` writes, from the environment or from `.env.live` (found at the repository root, or at
// SNAPWING_ENV_LIVE). Without them the whole file skips.
//
// Safety: this file only ever creates issues in JIRA_PROJECT_KEY, every summary starts with `[snapwing-test]`,
// and `afterAll` deletes every issue this run created (tracked by key, plus a search by this run's unique label
// in case a create succeeded but its answer was lost) and every webhook this run registered, even when an
// assertion failed. It never touches an issue it did not create, and never changes project settings, fields,
// screens or workflows. No credential is logged or put in an assertion message.
//
// Capture mode (opt in with SNAPWING_CAPTURE_JIRA=1): every response the client reads is saved sanitized (account
// ids, emails, names, site host, ids and custom field ids replaced by obvious fakes) to SNAPWING_CAPTURE_DIR
// (default packages/app/test/fixtures/jira/captured). Diff them against test/fixtures/jira/*.json and replace
// the hand-written ones where the shapes differ; the `shape` test below prints which differ.
//
// The webhook delivery test (Jira posts to the tunnel URL when an issue moves to In Progress) is skipped until
// a public tunnel exists: it needs `pnpm jira:bootstrap webhook` run against it. The bootstrap's registration
// itself (admin API, ?secret=) is exercised here with a placeholder URL.

import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { resolveJiraStatuses } from '@snapwing/pipeline/jira/statuses.ts';
import { runBootstrap, FIELD_SPECS, WEBHOOK_API } from '../../../../scripts/jira-bootstrap.ts';
import {
  createJiraClient,
  JiraNotFoundError,
  JiraValidationError,
  type JiraClient,
} from '../../src/jira/client/index.ts';
import { createAssigneeResolver, findOrCreateIssue, mapCustomFields, sendOp, textToAdf, type CreateIssueOp } from '../../src/jira/projector/ops.ts';
import { customFieldIdsFromEnv } from '../../src/jira/projector/fields.ts';
import { createStatusResolver } from '../../src/jira/projector/statuses.ts';
import { findEnvFile, readLiveEnv } from './helpers/env.ts';
import { createJiraSanitizer, shapeOf } from './helpers/jira-sanitize.ts';

const PREFIX = '[snapwing-test]';
const NAMES = [
  'JIRA_BASE_URL',
  'JIRA_EMAIL',
  'JIRA_API_TOKEN',
  'JIRA_PROJECT_KEY',
  'JIRA_FIELD_IMPL_PROMPT',
  'JIRA_FIELD_CONVERSATION',
  'JIRA_FIELD_AUTONOMY',
  'JIRA_FIELD_AGENT_STATUS',
] as const;
const env = await readLiveEnv(NAMES);
const hasSecrets = NAMES.every((n) => env[n] !== '');

const here = dirname(fileURLToPath(import.meta.url));
const capture = process.env.SNAPWING_CAPTURE_JIRA === '1';
const captureDir = resolve(process.env.SNAPWING_CAPTURE_DIR ?? join(here, '../fixtures/jira/captured'));
const fixtureDir = join(here, '../fixtures/jira');

/** A 1x1 transparent PNG. */
const PNG = Uint8Array.from(Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==', 'base64'));

async function sleep(ms: number): Promise<void> {
  await new Promise((r) => setTimeout(r, ms));
}

describe.skipIf(!hasSecrets)('Jira live tier', () => {
  const projectKey = env.JIRA_PROJECT_KEY;
  const baseUrl = env.JIRA_BASE_URL.replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${env.JIRA_EMAIL}:${env.JIRA_API_TOKEN}`).toString('base64')}`;
  const runId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const runLabel = `snapwing-live-${runId}`;
  const created: string[] = [];
  const webhookName = `${PREFIX} bootstrap ${runId}`;
  const recorded = new Map<string, unknown>();
  const sanitize = createJiraSanitizer({ baseUrl, projectKey, secrets: [env.JIRA_EMAIL, env.JIRA_API_TOKEN] });
  let currentLabel = '';
  let currentCall = '';

  /** The client's `fetch`: records the JSON body of each call under `currentLabel` when capturing. */
  const recordingFetch: typeof fetch = async (input, init) => {
    const res = await fetch(input, init);
    const call = `${init?.method ?? 'GET'} ${new URL(String(input instanceof Request ? input.url : input)).pathname}`;
    if (capture && currentLabel !== '' && (currentCall === '' || currentCall === call) && !recorded.has(currentLabel) && res.headers.get('content-type')?.includes('json') === true) {
      recorded.set(currentLabel, await res.clone().json().catch(() => undefined));
    }
    return res;
  };
  const client: JiraClient = createJiraClient({ baseUrl, email: env.JIRA_EMAIL, apiToken: env.JIRA_API_TOKEN, fetch: recordingFetch, log: () => undefined });
  /** Records the first JSON response of the wrapped calls under `name` (only the one matching `call`, `METHOD /path`, when given). */
  const label = async <T>(name: string, fn: () => Promise<T>, call = ''): Promise<T> => {
    currentLabel = name;
    currentCall = call;
    try {
      return await fn();
    } finally {
      currentLabel = '';
      currentCall = '';
    }
  };

  /** Raw calls for what the client does not cover (delete, webhook admin). Credentials travel in the header only. */
  async function raw(method: string, path: string): Promise<Response> {
    return fetch(`${baseUrl}${path}`, { method, headers: { Authorization: authorization, Accept: 'application/json' } });
  }
  /** Issues this run could not delete (the account lacks Delete Issues in the project); they were closed instead. */
  const leftovers: string[] = [];
  async function deleteIssue(key: string): Promise<void> {
    const res = await raw('DELETE', `/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=true`);
    // 404 means it is already gone.
    if (res.ok || res.status === 404) return;
    if (res.status !== 403) throw new Error(`could not delete ${key}: HTTP ${res.status}`);
    // Without the Delete Issues permission the best teardown is to close the issue and say so, loudly.
    leftovers.push(key);
    await client.transitionIssue(key, 'Done').catch(() => undefined);
  }
  async function deleteTestWebhooks(): Promise<void> {
    const res = await raw('GET', WEBHOOK_API);
    if (!res.ok) return;
    const all = (await res.json()) as { id?: number; name?: string }[];
    for (const w of all) if (w.name === webhookName && typeof w.id === 'number') await raw('DELETE', `${WEBHOOK_API}/${String(w.id)}`);
  }

  const fieldIds = (): Record<string, string> => customFieldIdsFromEnv(env);
  const assignees = createAssigneeResolver(client);
  const createOp = (): CreateIssueOp => ({
    op: 'create-issue',
    incidentId: runId,
    fields: {
      project: { key: projectKey },
      issuetype: { name: 'Task' },
      summary: `${PREFIX} checkout returns 500 ${runId}`,
      description: textToAdf('Created by the Snapwing live tier.\n\nSafe to delete.'),
      labels: ['snapwing', runLabel],
    },
    customFields: {
      'Implementation Prompt': '<implementation-request version="1"><problem>Checkout returns 500</problem></implementation-request>',
      'Conversation Link': 'https://example.com/slack/C0TEST/p1',
      'Autonomy Level': 2,
      'Agent Status': 'triaged',
    },
    screenshots: [],
  });
  let key = '';

  beforeAll(async () => {
    if (capture) await mkdir(captureDir, { recursive: true });
  });

  afterAll(async () => {
    const problems: string[] = [];
    const run = async (fn: () => Promise<void>): Promise<void> => {
      try {
        await fn();
      } catch (err) {
        problems.push(err instanceof Error ? err.message : String(err));
      }
    };
    // An issue whose create answer was lost still carries this run's label.
    await run(async () => {
      const page = await client.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 50 });
      for (const issue of page.issues) if (!created.includes(issue.key)) created.push(issue.key);
    });
    for (const k of created) await run(() => deleteIssue(k));
    await run(deleteTestWebhooks);
    if (capture) {
      for (const [name, body] of recorded) {
        await run(() => writeFile(join(captureDir, `${name}.json`), `${JSON.stringify(sanitize(body), null, 2)}\n`));
      }
    }
    if (leftovers.length > 0) {
      console.warn(`[snapwing-test] could not delete ${leftovers.join(', ')} (HTTP 403: the Jira account lacks Delete Issues in ${projectKey}); closed instead. Grant the permission so teardown can delete them.`);
    }
    if (problems.length > 0) throw new Error(`teardown problems: ${problems.join('; ')}`);
  });

  it('authenticates and the project is company-managed', async () => {
    const me = await label('myself', () => client.myself());
    expect(me.accountId).not.toBe('');
    const project = await label('project', () => client.getProject(projectKey));
    expect(project.key).toBe(projectKey);
    expect(project.style).not.toBe('next-gen');
  });

  it('the field ids the bootstrap wrote match the site, with the types the bootstrap creates', async () => {
    const fields = await label('fields', () => client.listFields());
    for (const spec of FIELD_SPECS) {
      const id = env[spec.envKey as (typeof NAMES)[number]];
      const field = fields.find((f) => f.id === id);
      expect(field, `${spec.name} (${spec.envKey})`).toBeDefined();
      expect(field?.name).toBe(spec.name);
      expect(field?.schema?.custom).toBe(spec.type);
    }
    expect(Object.keys(fieldIds())).toHaveLength(4);
  });

  it('maps the lifecycle targets to the project statuses by category', async () => {
    const statuses = await label('project-statuses', () => client.projectStatuses(projectKey));
    const mapping = resolveJiraStatuses(statuses, {});
    expect(mapping.problems).toEqual([]);
    expect(mapping.resolved['backlog']?.name).toBe('To Do');
    expect(mapping.resolved['in-progress']?.name).toBe('In Progress');
    expect(mapping.resolved['done']?.name).toBe('Done');
  });

  it('creates an issue with all four custom fields, found again by its incident label', async () => {
    const op = createOp();
    const first = await label('create-issue', () => findOrCreateIssue(client, op, fieldIds(), assignees), 'POST /rest/api/3/issue');
    key = first.key;
    created.push(key);
    expect(first.created).toBe(true);
    const ids = fieldIds();
    const issue = await label('get-issue', () => client.getIssue(key, { fields: ['summary', 'status', 'labels', ...Object.values(ids)] }));
    expect(String(issue.fields['summary']).startsWith(PREFIX)).toBe(true);
    expect(issue.fields[ids['Autonomy Level'] ?? '']).toBe(2);
    expect(issue.fields[ids['Conversation Link'] ?? '']).toBe('https://example.com/slack/C0TEST/p1');
    expect(issue.fields[ids['Agent Status'] ?? '']).toBe('triaged');
    expect(JSON.stringify(issue.fields[ids['Implementation Prompt'] ?? ''])).toContain('Checkout returns 500');
    expect(mapCustomFields(op.customFields, ids)).toHaveProperty(ids['Autonomy Level'] ?? '');

    // Idempotence: Jira's search index lags a create, so retry before asserting the second call finds it.
    let again = { created: true, key: '' };
    for (let i = 0; i < 20 && again.created; i++) {
      await sleep(1500);
      again = await findOrCreateIssue(client, op, ids, assignees);
    }
    expect(again).toMatchObject({ created: false, key });
  });

  it('moves the issue through the project statuses: backlog, in-progress, done', async () => {
    const resolver = createStatusResolver(client);
    const statusOf = async (): Promise<string> => {
      const issue = await client.getIssue(key, { fields: ['status'] });
      return String((issue.fields['status'] as { name: string }).name);
    };
    expect(await statusOf()).toBe(await resolver.resolve(key, 'backlog'));
    await label('transitions', () => recordingFetch(`${baseUrl}/rest/api/3/issue/${encodeURIComponent(key)}/transitions`, { headers: { Authorization: authorization, Accept: 'application/json' } }));
    await sendOp(client, { op: 'transition', issueKey: key, to: 'in-progress' }, fieldIds(), resolver, assignees);
    expect(await statusOf()).toBe('In Progress');
    await sendOp(client, { op: 'transition', issueKey: key, to: 'done', resolution: 'Done' }, fieldIds(), resolver, assignees);
    expect(await statusOf()).toBe('Done');
  });

  it('comments, labels, updates fields and attaches a file', async () => {
    const resolver = createStatusResolver(client);
    const comment = await label('add-comment', () => client.addComment(key, textToAdf(`${PREFIX} a comment ${runId}`)));
    expect(comment.id).not.toBe('');
    await sendOp(client, { op: 'add-labels', issueKey: key, labels: ['snapwing-extra'] }, fieldIds(), resolver, assignees);
    await sendOp(client, { op: 'update-fields', issueKey: key, fields: {}, customFields: { 'Agent Status': 'done' } }, fieldIds(), resolver, assignees);
    const attachments = await label('attachments', () => client.uploadAttachment(key, { filename: 'snapwing-test.png', content: PNG, contentType: 'image/png' }));
    expect(attachments[0]?.filename).toBe('snapwing-test.png');
    const issue = await client.getIssue(key, { fields: ['labels', 'attachment', 'comment', fieldIds()['Agent Status'] ?? ''] });
    expect(issue.fields['labels']).toEqual(expect.arrayContaining(['snapwing-extra', runLabel]));
    expect(issue.fields[fieldIds()['Agent Status'] ?? '']).toBe('done');
    expect(JSON.stringify(issue.fields['attachment'])).toContain('snapwing-test.png');
    expect(JSON.stringify(issue.fields['comment'])).toContain(runId);
  });

  it("assigns by account id: the owner's own account, resolved from JIRA_EMAIL, on create and on an update", async () => {
    const me = await client.myself();
    const found = await label('user-search', () => client.findUserByEmail(env.JIRA_EMAIL));
    expect(found?.accountId).toBe(me.accountId);

    const op: CreateIssueOp = { ...createOp(), incidentId: `${runId}-assign`, assigneeEmail: env.JIRA_EMAIL };
    const made = await findOrCreateIssue(client, op, fieldIds(), assignees);
    created.push(made.key);
    const assigned = await client.getIssue(made.key, { fields: ['assignee', 'comment'] });
    expect((assigned.fields['assignee'] as { accountId: string } | null)?.accountId).toBe(me.accountId);

    // An update-fields row writes it too, and an unknown email leaves the assignee and comments instead of failing.
    const resolver = createStatusResolver(client);
    await sendOp(client, { op: 'update-fields', issueKey: key, fields: {}, customFields: {}, assigneeEmail: env.JIRA_EMAIL }, fieldIds(), resolver, assignees);
    const updated = await client.getIssue(key, { fields: ['assignee'] });
    expect((updated.fields['assignee'] as { accountId: string } | null)?.accountId).toBe(me.accountId);
    const nobody = `snapwing-nobody-${runId}@example.invalid`;
    await sendOp(client, { op: 'update-fields', issueKey: key, fields: {}, customFields: {}, assigneeEmail: nobody }, fieldIds(), resolver, assignees);
    const after = await client.getIssue(key, { fields: ['assignee', 'comment'] });
    expect((after.fields['assignee'] as { accountId: string } | null)?.accountId).toBe(me.accountId);
    expect(JSON.stringify(after.fields['comment'])).toContain(nobody);
  });

  it('finds the issue by JQL', async () => {
    let found: string[] = [];
    for (let i = 0; i < 20 && found.length === 0; i++) {
      const page = await label('search-jql', () => client.searchJql(`project = ${projectKey} AND labels = "${runLabel}"`, { maxResults: 5 }));
      found = page.issues.map((x) => x.key);
      if (found.length === 0) await sleep(1500);
    }
    // The run label is on every issue this file creates (the assignee test makes a second one), so the
    // search finds this issue among them rather than alone.
    expect(found).toContain(key);
  });

  it('answers a missing issue and a bad create with typed errors', async () => {
    const missing = await label('error-not-found', () => client.getIssue(`${projectKey}-999999`).catch((e: unknown) => e));
    expect(missing).toBeInstanceOf(JiraNotFoundError);
    const bad = await label('error-validation', () => client.createIssue({ project: { key: projectKey }, issuetype: { name: 'Task' } }).catch((e: unknown) => e));
    expect(bad).toBeInstanceOf(JiraValidationError);
    // A create that unexpectedly succeeded must not leak an issue.
    if (!(bad instanceof Error)) created.push((bad as { key: string }).key);
  });

  it('registers and replaces the webhook through the admin API, with ?secret= and no secret in the output', async () => {
    const fakeSecret = `live-${runId}`;
    const merged = { ...process.env, ...env, SNAPWING_PUBLIC_URL: 'https://snapwing-live-test.example.invalid', JIRA_WEBHOOK_SECRET: fakeSecret };
    const run = (extra: Record<string, string> = {}): ReturnType<typeof runBootstrap> =>
      runBootstrap({ env: { ...merged, ...extra }, mode: 'webhook', webhookName });
    const first = await run();
    expect(first.lines.join('\n')).not.toContain(fakeSecret);
    expect(first.ok, first.lines.join('\n')).toBe(true);
    const list = async (): Promise<{ name: string; url: string; events: string[]; filters: Record<string, string> }[]> => {
      const all = (await (await raw('GET', WEBHOOK_API)).json()) as { name: string; url: string; events: string[]; filters: Record<string, string> }[];
      return all.filter((w) => w.name === webhookName);
    };
    expect(await list()).toEqual([
      expect.objectContaining({
        url: `https://snapwing-live-test.example.invalid/webhooks/jira?secret=${fakeSecret}`,
        events: ['jira:issue_updated', 'comment_created'],
        filters: { 'issue-related-events-section': `project = ${projectKey}` },
      }),
    ]);
    // Same URL again: left alone. New URL: replaced, never duplicated.
    expect((await run()).lines.join('\n')).toContain('already registered');
    const moved = await run({ SNAPWING_PUBLIC_URL: 'https://snapwing-live-test2.example.invalid' });
    expect(moved.ok, moved.lines.join('\n')).toBe(true);
    const after = await list();
    expect(after).toHaveLength(1);
    expect(after[0]?.url).toContain('snapwing-live-test2');
  });

  it('screens and statuses: the bootstrap dry run reads them from the site without changes', async () => {
    const report = await runBootstrap({ env: { ...process.env, ...env }, dryRun: true, envFilePath: findEnvFile() });
    expect(report.ok, report.lines.join('\n')).toBe(true);
    expect(report.lines.some((l) => l.startsWith('plan '))).toBe(false);
  });

  it.runIf(capture)('shape: the recordings differ from the hand-written fixtures at these paths', async () => {
    const pairs: [string, string][] = [
      ['myself', 'myself'],
      ['fields', 'fields'],
      ['project', 'project-company-managed'],
      ['project-statuses', 'project-statuses'],
      ['create-issue', 'create-issue'],
      ['get-issue', 'get-issue'],
      ['add-comment', 'add-comment'],
      ['attachments', 'attachments'],
      ['search-jql', 'search-jql'],
      ['error-not-found', 'error-not-found'],
      ['error-validation', 'error-validation'],
    ];
    const diffs: string[] = [];
    for (const [rec, fix] of pairs) {
      const body = recorded.get(rec);
      if (body === undefined) continue;
      const fixture = JSON.parse(await readFile(join(fixtureDir, `${fix}.json`), 'utf8')) as unknown;
      const a = new Set(shapeOf(sanitize(body)));
      const b = new Set(shapeOf(fixture));
      const only = [...a].filter((p) => !b.has(p)).slice(0, 12);
      if (only.length > 0) diffs.push(`${rec} has ${only.join(', ')}`);
    }
    console.log(diffs.length === 0 ? 'no shape differences' : `shape differences:\n${diffs.join('\n')}`);
  });

  // Jira posts to the tunnel URL when an issue moves to In Progress. Needs a public https URL registered with
  // `pnpm jira:bootstrap webhook` (SNAPWING_PUBLIC_URL), which does not exist yet.
  it.skip('delivers the webhook on the In Progress transition (needs the public tunnel URL)', () => undefined);
});
