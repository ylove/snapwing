// Jira inbound sync and the fixer trigger (#143; B 7.3, B 8, B 11, main 10.1, main 10.4). Recorded-shape
// Jira Cloud webhook payloads (test/fixtures/jira-webhooks) go through the route handler against the
// state store on the dialect `SNAPWING_DB` selects, the in-process workflow, a fake RunnerPort, and the
// real Jira client whose `myself` is served by MSW (test/fixtures/jira/myself.json: the agent's account).

import { createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { EventPayloads, EventType, IncidentEvent, NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import { registerFixerJobs, type FixerDeps, type FixerGitHub } from '@snapwing/pipeline/fixer/job.ts';
import type { FixerJob, RunnerPort } from '@snapwing/pipeline/ports/runner.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { jiraFieldBatchKey } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import { InProcessWorkflow } from '@snapwing/pipeline/workflow/inprocess/index.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createJiraClient } from '../../src/jira/client/index.ts';
import { createJiraWebhookRoute, JIRA_WEBHOOK_PATH, type JiraWebhookDeps } from '../../src/webhooks/jira.ts';

const BASE = 'https://example.atlassian.net';
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const WS = '01K6WORKSPACE0000000000000';
const INC = '01K6JIRAHOOKINC00000000000';
const KEY = 'WEB-1042';
const PROMPT_FIELD = 'customfield_10050';
const HUMAN = '5b10ac8d82e05b22cc7d4ef5';
const SECRET = 'jira-webhook-secret-test';

type Fixture = Record<string, unknown> & { issue: { key: string; fields: Record<string, unknown> }; user: { accountId: string } };

function fixture(name: string): Fixture {
  return JSON.parse(readFileSync(new URL(`../fixtures/jira-webhooks/${name}.json`, import.meta.url), 'utf8')) as Fixture;
}

const AGENT = (JSON.parse(readFileSync(new URL('../fixtures/jira/myself.json', import.meta.url), 'utf8')) as { accountId: string }).accountId;

// World ------------------------------------------------------------------------------------------

class FakeRunner implements RunnerPort {
  readonly started: FixerJob[] = [];
  readonly cancelled: string[] = [];
  runFixer(job: FixerJob): Promise<{ runId: string }> {
    this.started.push(job);
    return Promise.resolve({ runId: job.runId });
  }
  cancel(runId: string): Promise<void> {
    this.cancelled.push(runId);
    return Promise.resolve();
  }
}

const github: FixerGitHub = { markIncomplete: () => Promise.resolve(), closePr: () => Promise.resolve() };

const server = setupServer();
let myselfCalls = 0;
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
let wf: InProcessWorkflow;
let runner: FakeRunner;
let fixer: FixerDeps;
let now: number;
let errors: unknown[];

beforeEach(async () => {
  myselfCalls = 0;
  server.use(
    http.get(`${BASE}/rest/api/3/myself`, () => {
      myselfCalls++;
      return HttpResponse.json(JSON.parse(readFileSync(new URL('../fixtures/jira/myself.json', import.meta.url), 'utf8')));
    }),
  );
  tdb = await createTestDatabase();
  now = T0;
  errors = [];
  state = await tdb.open({ now: () => new Date(now) });
  wf = new InProcessWorkflow(state, { onError: (e) => errors.push(e) });
  runner = new FakeRunner();
  fixer = { workspaceId: WS, state, workflow: wf, runner, github, config: { harness: { adapter: 'claude-code' } }, clock: () => new Date(now) };
  registerFixerJobs(fixer);
});

afterEach(async () => {
  server.resetHandlers();
  await wf.stop();
  await tdb.drop();
  expect(errors).toEqual([]);
});

const jira = createJiraClient({ baseUrl: BASE, email: 'bot@example.com', apiToken: 'jira-token-test' });

function route(overrides: Partial<JiraWebhookDeps> = {}): (req: Request) => Promise<Response> {
  return createJiraWebhookRoute({ fixer, jira, implementationPromptFieldId: PROMPT_FIELD, ...overrides });
}

function request(body: unknown, opts: { signature?: string; query?: string } = {}): Request {
  const text = JSON.stringify(body);
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.signature !== undefined) headers['x-hub-signature'] = opts.signature;
  return new Request(`https://snapwing.example.com${JIRA_WEBHOOK_PATH}${opts.query ?? ''}`, { method: 'POST', headers, body: text });
}

async function deliver(handler: (req: Request) => Promise<Response>, body: unknown, opts: { signature?: string; query?: string } = {}): Promise<{ status: number; outcome?: string }> {
  const res = await handler(request(body, opts));
  const json = (await res.json()) as { outcome?: string };
  await wf.drain();
  return { status: res.status, ...(json.outcome === undefined ? {} : { outcome: json.outcome }) };
}

/** `base` with another actor, `updated`, or prompt; a new `updated` is a new delivery (B 8). */
function variant(base: Fixture, opts: { by?: string; updated?: string; prompt?: unknown }): Fixture {
  const copy = structuredClone(base);
  if (opts.by !== undefined) copy.user.accountId = opts.by;
  if (opts.updated !== undefined) copy.issue.fields['updated'] = opts.updated;
  if ('prompt' in opts) copy.issue.fields[PROMPT_FIELD] = opts.prompt;
  return copy;
}

function ev<T extends EventType>(type: T, payload: EventPayloads[T]): NewEvent<T> {
  return { workspaceId: WS, incidentId: INC, type, v: 1, source: 'agent', occurredAt: new Date(now).toISOString(), payload } as unknown as NewEvent<T>;
}

async function append(...events: NewEvent[]): Promise<void> {
  const last = (await state.read(INC)).at(-1)?.seq ?? 0;
  await state.append(INC, events, last);
}

/** An incident filed as `KEY` at `level`, with an implementation request. */
async function filed(level: 0 | 1 | 2 | 3 = 3): Promise<void> {
  const put = await state.putArtifact({
    workspaceId: WS,
    incidentId: INC,
    kind: 'implementation-request',
    contentType: 'application/xml',
    body: '<implementation-request/>',
    createdBy: 'orchestrator',
  });
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
    ev('resolved', { surfaceId: 'web', componentId: 'checkout', repo: 'fake-org/web', resolvedBy: 'channel-explicit', confidence: 0.9 }),
    ev('dedupe-checked', { candidates: [], decision: 'none' }),
    ev('planned', {
      action: 'create_issue',
      projectKey: 'WEB',
      issueType: 'Bug',
      summary: 'Checkout returns 500 on submit',
      priority: 'Medium',
      labels: ['snapwing'],
      autonomyLevel: level,
      implementationRequest: { artifactId: put.id, version: put.version },
    }),
    ev('filed', { jiraKey: KEY }),
  );
}

async function log(): Promise<IncidentEvent[]> {
  return state.read(INC);
}

async function jiraEvents(): Promise<IncidentEvent[]> {
  return (await log()).filter((e) => e.type.startsWith('jira-'));
}

/** An agent write to `field` waiting in the outbox, as the lifecycle module or the engine leaves one. */
async function pendingWrite(field: 'priority' | 'assignee' | 'status', op: 'update-fields' | 'transition', payload: Record<string, unknown>): Promise<string> {
  const id = `01K6PENDING${field.toUpperCase().padEnd(15, '0')}`.slice(0, 26);
  const at = new Date(now).toISOString();
  await state.enqueueOutbox({ id, workspaceId: WS, target: 'jira', incidentId: INC, op, payload, batchKey: jiraFieldBatchKey(INC, field), attempts: 0, nextAttempt: at, createdAt: at });
  return id;
}

async function pendingIds(): Promise<string[]> {
  return (await state.drainOutbox('jira', 100)).map((r) => r.id);
}

// Tests ------------------------------------------------------------------------------------------

describe('inbound sync (B 7.3)', () => {
  it('a human priority change appends jira-priority-changed as a human and projects the value', async () => {
    await filed();
    const res = await deliver(route(), fixture('issue-updated-priority'));
    expect(res).toEqual({ status: 200, outcome: 'processed' });
    const [event] = await jiraEvents();
    expect(event).toMatchObject({
      type: 'jira-priority-changed',
      source: 'jira',
      actor: { id: HUMAN, role: 'human' },
      occurredAt: '2026-10-02T12:00:00.000Z',
      payload: { jiraKey: KEY, from: 'Medium', to: 'Lowest' },
    });
    expect((await state.getIncident(INC))?.priority).toBe('Lowest');
  });

  it('human priority wins over a pending escalated write (B 11): the agent write is dropped', async () => {
    await filed();
    await append(ev('escalated', { intent: 'escalate', step: 1, action: 'page', score: 0.9 }));
    const escalatedWrite = await pendingWrite('priority', 'update-fields', { issueKey: KEY, fields: { priority: { name: 'Highest' } } });
    const statusWrite = await pendingWrite('status', 'transition', { issueKey: KEY, to: 'done' });
    expect(await pendingIds()).toEqual(expect.arrayContaining([escalatedWrite, statusWrite]));

    await deliver(route(), fixture('issue-updated-priority'));

    const pending = await pendingIds();
    expect(pending).not.toContain(escalatedWrite);
    expect(pending).toContain(statusWrite);
    expect(await state.listParkedOutbox('jira', 10)).toEqual([]);
    expect((await state.getIncident(INC))?.priority).toBe('Lowest');
  });

  it('a human assignee change appends jira-assignee-changed and drops the pending assignee write', async () => {
    await filed();
    const write = await pendingWrite('assignee', 'update-fields', { issueKey: KEY, fields: { assignee: { accountId: 'agent-pick' } } });
    expect(await deliver(route(), fixture('issue-updated-assignee'))).toEqual({ status: 200, outcome: 'processed' });
    expect((await jiraEvents()).map((e) => [e.type, e.actor, e.payload])).toEqual([
      ['jira-assignee-changed', { id: HUMAN, role: 'human' }, { jiraKey: KEY, to: HUMAN }],
    ]);
    expect((await state.getIncident(INC))?.assigneeId).toBe(HUMAN);
    expect(await pendingIds()).not.toContain(write);
  });

  it('a human transition appends jira-transitioned and drops the pending status write', async () => {
    await filed(0);
    const write = await pendingWrite('status', 'transition', { issueKey: KEY, to: 'in-review' });
    const human = variant(fixture('issue-updated-in-progress'), { by: HUMAN });
    expect(await deliver(route(), human)).toEqual({ status: 200, outcome: 'processed' });
    expect((await jiraEvents()).map((e) => [e.type, e.actor?.role, e.payload])).toEqual([
      ['jira-transitioned', 'human', { jiraKey: KEY, from: 'Backlog', to: 'In Progress' }],
    ]);
    expect(await pendingIds()).not.toContain(write);
  });

  it('ignores a change made by the agent’s own account: no event, no write dropped', async () => {
    await filed();
    const write = await pendingWrite('priority', 'update-fields', { issueKey: KEY, fields: { priority: { name: 'Highest' } } });
    const echo = variant(fixture('issue-updated-priority'), { by: AGENT });
    expect(await deliver(route(), echo)).toEqual({ status: 200, outcome: 'echo' });
    expect(await jiraEvents()).toEqual([]);
    expect(await pendingIds()).toContain(write);
    expect((await state.getIncident(INC))?.priority).toBe('Medium');
  });

  it('a duplicate delivery is a no-op', async () => {
    await filed();
    const handler = route();
    expect(await deliver(handler, fixture('issue-updated-priority'))).toEqual({ status: 200, outcome: 'processed' });
    const seq = (await log()).at(-1)?.seq;
    expect(await deliver(handler, fixture('issue-updated-priority'))).toEqual({ status: 200, outcome: 'duplicate' });
    expect((await log()).at(-1)?.seq).toBe(seq);
    expect(await jiraEvents()).toHaveLength(1);
    // The agent's account is read once per route, not per delivery.
    expect(myselfCalls).toBe(1);
  });

  it('ignores an issue no incident filed, and comments (phase 4)', async () => {
    await filed();
    const other = structuredClone(fixture('issue-updated-priority'));
    other.issue.key = 'WEB-9999';
    expect(await deliver(route(), other)).toEqual({ status: 200, outcome: 'ignored' });
    expect(await deliver(route(), fixture('comment-created'))).toEqual({ status: 200, outcome: 'ignored' });
    expect(await jiraEvents()).toEqual([]);
  });
});

describe('fixer trigger (main 10.1) and Stop (main 10.4)', () => {
  it('In Progress with a non-empty Implementation Prompt starts the fixer once', async () => {
    await filed(3);
    const handler = route();
    // The engine's own transition at level 3: an echo, which still starts the fixer (main 10.1).
    const transition = fixture('issue-updated-in-progress');
    expect(await deliver(handler, transition)).toEqual({ status: 200, outcome: 'echo' });
    expect(runner.started).toHaveLength(1);
    expect(runner.started[0]?.workItem).toMatchObject({ id: INC, issueKey: KEY, repo: 'fake-org/web' });

    // Jira delivers it again; then a human drags the ticket back and forth.
    expect(await deliver(handler, transition)).toEqual({ status: 200, outcome: 'duplicate' });
    await deliver(handler, variant(transition, { by: HUMAN, updated: '2026-10-02T12:09:00.000+0000' }));
    expect(runner.started).toHaveLength(1);
    expect((await log()).filter((e) => e.type === 'fixer-started')).toHaveLength(1);
    expect(await jiraEvents()).toHaveLength(1);
  });

  it('does not start the fixer when the Implementation Prompt is empty', async () => {
    await filed(3);
    await deliver(route(), variant(fixture('issue-updated-in-progress'), { prompt: null }));
    await deliver(route(), variant(fixture('issue-updated-in-progress'), { prompt: '  ', updated: '2026-10-02T12:09:00.000+0000' }));
    expect(runner.started).toEqual([]);
  });

  it('reads an ADF Implementation Prompt', async () => {
    await filed(3);
    const adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: '<implementation-request/>' }] }] };
    await deliver(route(), variant(fixture('issue-updated-in-progress'), { prompt: adf }));
    expect(runner.started).toHaveLength(1);
  });

  it('does not start the fixer on a human’s In Progress while the human has claimed it', async () => {
    await filed(1);
    await append({ ...ev('claimed', { claimerId: HUMAN, expiresAt: '2026-10-02T16:00:00.000Z' }), actor: { id: HUMAN, role: 'engineer' } });
    await deliver(route(), variant(fixture('issue-updated-in-progress'), { by: HUMAN }));
    expect((await state.getIncident(INC))?.status).toBe('human-fixing');
    expect(runner.started).toEqual([]);
  });

  it('the snapwing:stop label stops the incident and cancels the running fixer', async () => {
    await filed(3);
    const handler = route();
    await deliver(handler, fixture('issue-updated-in-progress'));
    const [run] = runner.started;
    expect(await deliver(handler, fixture('issue-updated-stop-label'))).toEqual({ status: 200, outcome: 'processed' });
    const stopped = (await log()).filter((e) => e.type === 'stopped');
    expect(stopped).toHaveLength(1);
    expect(stopped[0]).toMatchObject({ source: 'jira', actor: { id: HUMAN, role: 'human' } });
    expect(runner.cancelled).toEqual([run?.runId]);
  });

  it('ignores the snapwing:stop label when the agent added it', async () => {
    await filed(3);
    await deliver(route(), variant(fixture('issue-updated-stop-label'), { by: AGENT }));
    expect((await log()).some((e) => e.type === 'stopped')).toBe(false);
  });
});

describe('webhook secret', () => {
  const body = (): Fixture => fixture('issue-updated-priority');
  const sign = (b: unknown): string => `sha256=${createHmac('sha256', SECRET).update(JSON.stringify(b)).digest('hex')}`;

  it('accepts a body signed with JIRA_WEBHOOK_SECRET (X-Hub-Signature)', async () => {
    await filed();
    expect(await deliver(route({ secret: SECRET }), body(), { signature: sign(body()) })).toEqual({ status: 200, outcome: 'processed' });
  });

  it('accepts the secret as a query parameter (REST-registered webhooks are unsigned)', async () => {
    await filed();
    expect(await deliver(route({ secret: SECRET }), body(), { query: `?secret=${SECRET}` })).toEqual({ status: 200, outcome: 'processed' });
  });

  it('rejects a missing or wrong signature with 401 and records nothing', async () => {
    await filed();
    const handler = route({ secret: SECRET });
    expect((await deliver(handler, body())).status).toBe(401);
    expect((await deliver(handler, body(), { signature: 'sha256=00' })).status).toBe(401);
    expect((await deliver(handler, body(), { query: '?secret=wrong' })).status).toBe(401);
    const tampered = variant(body(), { by: AGENT });
    expect((await deliver(handler, tampered, { signature: sign(body()) })).status).toBe(401);
    expect(await jiraEvents()).toEqual([]);
    // Nothing was marked seen: the genuine delivery still goes through.
    expect(await deliver(handler, body(), { signature: sign(body()) })).toEqual({ status: 200, outcome: 'processed' });
  });

  it('rejects a body that is not a JSON object with 400', async () => {
    const res = await route()(new Request(`https://snapwing.example.com${JIRA_WEBHOOK_PATH}`, { method: 'POST', body: 'not json' }));
    expect(res.status).toBe(400);
  });
});
