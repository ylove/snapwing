// Jira projector (#140; B 7.1, B 11): drains `target='jira'` outbox rows against an in-memory Jira
// behind MSW, on the dialect `SNAPWING_DB` selects. The clock is shared by the store and the
// projector, so holds, pauses, and backoff move only when a test moves it.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createJiraClient } from '../../src/jira/client/index.ts';
import { COMMENT_WINDOW_MS, createJiraProjector, type JiraProjector, type JiraProjectorOptions } from '../../src/jira/projector/drain.ts';
import { incidentLabel } from '../../src/jira/projector/ops.ts';

const BASE = 'https://example.atlassian.net';
const SHOTS = 'https://files.example.com';
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const WS = '01K0000000000000000000WS01';

// An in-memory Jira ----------------------------------------------------------------------------

interface FakeIssue {
  key: string;
  fields: Record<string, unknown>;
  labels: string[];
  status: string;
  comments: unknown[];
  attachments: string[];
  resolution?: string;
}

class FakeJira {
  issues = new Map<string, FakeIssue>();
  requests: string[] = [];
  /** Answers queued for the next matching calls, by `METHOD path-suffix`. */
  failures: { match: string; status: number; headers?: Record<string, string> }[] = [];
  next = 1;
  /** Bodies posted to the transitions endpoint, in order. */
  transitionBodies: { id: string; fields?: { resolution?: { name: string } } }[] = [];
  /** A site whose transition screen has no Resolution field. */
  noResolutionField = false;

  fail(match: string, status: number, headers?: Record<string, string>): void {
    this.failures.push({ match, status, ...(headers === undefined ? {} : { headers }) });
  }

  take(method: string, path: string): Response | undefined {
    const i = this.failures.findIndex((f) => `${method} ${path}`.endsWith(f.match));
    if (i === -1) return undefined;
    const [f] = this.failures.splice(i, 1);
    return HttpResponse.json({ errorMessages: [`injected ${f!.status}`] }, { status: f!.status, ...(f!.headers === undefined ? {} : { headers: f!.headers }) });
  }

  issue(key: string): FakeIssue {
    const issue = this.issues.get(key);
    if (issue === undefined) throw new Error(`no issue ${key}`);
    return issue;
  }

  handlers() {
    const seen = (request: Request): Response | undefined => {
      const url = new URL(request.url);
      this.requests.push(`${request.method} ${url.pathname}`);
      return this.take(request.method, url.pathname);
    };
    const missing = (key: string) => HttpResponse.json({ errorMessages: [`Issue ${key} does not exist`] }, { status: 404 });
    return [
      http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
        const injected = seen(request);
        if (injected) return injected;
        const body = (await request.json()) as { jql: string };
        const label = /labels = "([^"]+)"/.exec(body.jql)?.[1];
        const issues = [...this.issues.values()]
          .filter((i) => label !== undefined && i.labels.includes(label))
          .map((i) => ({ id: i.key, key: i.key, self: `${BASE}/issue/${i.key}`, fields: { attachment: i.attachments.map((filename) => ({ filename })) } }));
        return HttpResponse.json({ issues, isLast: true });
      }),
      http.post(`${BASE}/rest/api/3/issue`, async ({ request }) => {
        const injected = seen(request);
        if (injected) return injected;
        const { fields } = (await request.json()) as { fields: Record<string, unknown> };
        const project = (fields['project'] as { key: string }).key;
        const key = `${project}-${this.next++}`;
        this.issues.set(key, { key, fields, labels: [...(fields['labels'] as string[])], status: 'Backlog', comments: [], attachments: [] });
        return HttpResponse.json({ id: key, key, self: `${BASE}/issue/${key}` }, { status: 201 });
      }),
      http.put(`${BASE}/rest/api/3/issue/:key`, async ({ request, params }) => {
        const injected = seen(request);
        if (injected) return injected;
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const body = (await request.json()) as { fields?: Record<string, unknown>; update?: { labels?: { add: string }[] } };
        Object.assign(issue.fields, body.fields ?? {});
        for (const { add } of body.update?.labels ?? []) if (!issue.labels.includes(add)) issue.labels.push(add);
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${BASE}/rest/api/3/issue/:key/transitions`, ({ request }) => {
        const injected = seen(request);
        if (injected) return injected;
        const transitions = ['Backlog', 'In Progress', 'In Review', 'Done'].map((name, i) => ({ id: String(11 + i), name, to: { id: String(i + 1), name } }));
        return HttpResponse.json({ transitions });
      }),
      http.post(`${BASE}/rest/api/3/issue/:key/transitions`, async ({ request, params }) => {
        const injected = seen(request);
        if (injected) return injected;
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const { transition, fields } = (await request.json()) as { transition: { id: string }; fields?: { resolution?: { name: string } } };
        this.transitionBodies.push({ id: transition.id, ...(fields === undefined ? {} : { fields }) });
        if (fields?.resolution !== undefined && this.noResolutionField) {
          return HttpResponse.json({ errorMessages: [], errors: { resolution: "Field 'resolution' cannot be set. It is not on the appropriate screen, or unknown." } }, { status: 400 });
        }
        if (fields?.resolution !== undefined) issue.resolution = fields.resolution.name;
        issue.status = ['Backlog', 'In Progress', 'In Review', 'Done'][Number(transition.id) - 11] ?? '?';
        return new HttpResponse(null, { status: 204 });
      }),
      http.post(`${BASE}/rest/api/3/issue/:key/comment`, async ({ request, params }) => {
        const injected = seen(request);
        if (injected) return injected;
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const { body } = (await request.json()) as { body: unknown };
        issue.comments.push(body);
        return HttpResponse.json({ id: String(issue.comments.length) }, { status: 201 });
      }),
      http.post(`${BASE}/rest/api/3/issue/:key/attachments`, async ({ request, params }) => {
        const injected = seen(request);
        if (injected) return injected;
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const file = (await request.formData()).get('file') as File;
        issue.attachments.push(file.name);
        return HttpResponse.json([{ id: String(issue.attachments.length), filename: file.name, size: file.size }]);
      }),
      http.get(`${SHOTS}/shots/:name`, () => new HttpResponse(new Uint8Array([137, 80, 78, 71]), { headers: { 'content-type': 'image/png' } })),
    ];
  }
}

// Fixture ---------------------------------------------------------------------------------------

const server = setupServer();
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
let time = T0;
let jira: FakeJira;
let continued: string[];

beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(time) });
});
afterAll(async () => {
  await tdb.drop();
});

beforeEach(async () => {
  // Clear what earlier tests left: move far ahead, ack everything due, come back.
  time = T0 + 365 * 24 * 3600 * 1000;
  for (let rows = await state.drainOutbox('jira', 1000); rows.length > 0; rows = await state.drainOutbox('jira', 1000)) {
    await state.ackOutbox(rows.map((r) => r.id));
  }
  time = T0;
  jira = new FakeJira();
  server.use(...jira.handlers());
  continued = [];
  clientLog = [];
});
afterEach(() => server.resetHandlers());

let clientLog: string[] = [];
const client = createJiraClient({ baseUrl: BASE, email: 'bot@example.com', apiToken: 'jira-token-test', log: (m) => clientLog.push(m) });

function projector(overrides: Partial<JiraProjectorOptions> = {}): JiraProjector {
  return createJiraProjector({
    state,
    client,
    workspaceId: WS,
    continueIncident: async (id) => {
      continued.push(id);
      return { jobId: `job-${id}` };
    },
    customFieldIds: {
      'Implementation Prompt': 'customfield_10040',
      'Conversation Link': 'customfield_10041',
      'Autonomy Level': 'customfield_10042',
      'Agent Status': 'customfield_10043',
    },
    now: () => new Date(time),
    ...overrides,
  });
}

let serial = 0;
/** A row created now; ids increase, so rows enqueued at the same instant drain in creation order. */
function row(op: string, payload: Record<string, unknown>, extra: Partial<OutboxItem> = {}): OutboxItem {
  const at = new Date(time).toISOString();
  const id = `${ulid(time).slice(0, 10)}${String(++serial).padStart(16, '0')}`;
  return { id, workspaceId: WS, target: 'jira', op, payload, attempts: 0, nextAttempt: at, createdAt: at, ...extra };
}

function createIssuePayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fields: {
      project: { key: 'WEB' },
      issuetype: { name: 'Bug' },
      summary: 'Cart total is blank after applying a promo code',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reported in #market-bugs.' }] }] },
      priority: { name: 'High' },
      labels: ['snapwing', 'slack', 'web'],
      ...overrides,
    },
    customFields: { 'Implementation Prompt': '<implementation-request/>', 'Conversation Link': 'https://slack.example.com/archives/C1/p1', 'Autonomy Level': 2 },
    screenshots: [{ url: `${SHOTS}/shots/cart-blank.png` }],
  };
}

async function enqueue(...rows: OutboxItem[]): Promise<void> {
  for (const r of rows) await state.enqueueOutbox(r);
}

async function filedEvents(incidentId: string) {
  return (await state.read(incidentId)).filter((e) => e.type === 'filed');
}

function waitingChanged(incidentId: string): NewEvent<'waiting-changed'> {
  return { workspaceId: WS, incidentId, type: 'waiting-changed', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: {} };
}

function commentTexts(issue: FakeIssue): string[][] {
  return issue.comments.map((c) => (c as { content: { content: { text: string }[] }[] }).content.map((p) => p.content[0]!.text));
}

// Tests -----------------------------------------------------------------------------------------

describe('create-issue', () => {
  it('creates the issue with its incident label and mapped custom fields, appends filed, continues the incident, attaches screenshots', async () => {
    const incidentId = ulid(time);
    await state.append(incidentId, [waitingChanged(incidentId)], 0);
    const create = row('create-issue', createIssuePayload(), { incidentId });
    await enqueue(create);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([create.id]);
    const issue = jira.issue('WEB-1');
    expect(issue.labels).toEqual(['snapwing', 'slack', 'web', incidentLabel(incidentId)]);
    expect(issue.fields['customfield_10040']).toBe('<implementation-request/>');
    expect(issue.fields['customfield_10042']).toBe(2);
    expect(issue.fields['customfield_10041']).toBe('https://slack.example.com/archives/C1/p1');
    expect(issue.attachments).toEqual(['cart-blank.png']);
    const filed = await filedEvents(incidentId);
    expect(filed.map((e) => [e.seq, e.source, e.payload])).toEqual([[2, 'jira', { jiraKey: 'WEB-1' }]]);
    expect(continued).toEqual([incidentId]);
    expect(await state.drainOutbox('jira', 10, WS)).toEqual([]);
    // Order of calls: search first, create, then the upload after the issue exists.
    expect(jira.requests).toEqual(['POST /rest/api/3/search/jql', 'POST /rest/api/3/issue', 'POST /rest/api/3/issue/WEB-1/attachments']);
  });

  it('retries filed on an expectedSeq conflict from a fresh read', async () => {
    const incidentId = ulid(time);
    await state.append(incidentId, [waitingChanged(incidentId)], 0);
    let raced = false;
    const racing: StatePort = new Proxy(state, {
      get(target, prop, receiver) {
        if (prop === 'append') {
          return async (id: string, events: NewEvent[], expectedSeq: number) => {
            if (!raced) {
              raced = true;
              await target.append(id, [waitingChanged(id)], expectedSeq); // another writer gets there first
            }
            return target.append(id, events, expectedSeq);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await enqueue(row('create-issue', createIssuePayload(), { incidentId }));

    await projector({ state: racing }).drainOnce();

    expect((await filedEvents(incidentId)).map((e) => e.seq)).toEqual([3]);
    expect(continued).toEqual([incidentId]);
  });

  it('creates one issue across a crash between the Jira answer and the ack', async () => {
    const incidentId = ulid(time);
    await state.append(incidentId, [waitingChanged(incidentId)], 0);
    const create = row('create-issue', createIssuePayload(), { incidentId });
    await enqueue(create);

    // The first worker dies inside the ack: Jira has the issue, the screenshot, and the log has filed.
    let reachedAck = false;
    const dying: StatePort = new Proxy(state, {
      get(target, prop, receiver) {
        if (prop === 'ackOutbox') {
          return () => {
            reachedAck = true;
            return new Promise<never>(() => undefined);
          };
        }
        const value: unknown = Reflect.get(target, prop, receiver);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    void projector({ state: dying }).drainOnce();
    await expect.poll(() => reachedAck).toBe(true);
    expect(jira.issues.size).toBe(1);

    // A fresh worker drains the same row.
    const report = await projector().drainOnce();

    expect(report.sent).toEqual([create.id]);
    expect(jira.issues.size).toBe(1);
    expect(jira.requests.filter((r) => r === 'POST /rest/api/3/issue')).toHaveLength(1);
    expect(jira.issue('WEB-1').attachments).toEqual(['cart-blank.png']);
    expect(await filedEvents(incidentId)).toHaveLength(1);
    expect(continued).toEqual([incidentId, incidentId]);
    expect(await state.drainOutbox('jira', 10, WS)).toEqual([]);
  });
});

describe('batching (B 7.1)', () => {
  it('merges comments sharing a batch_key within 60 s into one comment', async () => {
    const incidentId = ulid(time);
    jira.issues.set('WEB-7', { key: 'WEB-7', fields: {}, labels: [], status: 'Backlog', comments: [], attachments: [] });
    const key = `comment:${incidentId}`;
    const p = projector();
    await enqueue(row('add-comment', { issueKey: 'WEB-7', text: 'Stopped by @pat.' }, { incidentId, batchKey: key }));
    time = T0 + 5000;
    expect((await p.drainOnce()).held).toHaveLength(1);
    expect(jira.issue('WEB-7').comments).toHaveLength(0);

    time = T0 + 10_000;
    await enqueue(row('add-comment', { issueKey: 'WEB-7', text: 'Claimed by @sam.' }, { incidentId, batchKey: key }));
    time = T0 + 30_000;
    await enqueue(row('add-comment', { issueKey: 'WEB-7', text: 'Escalated to P1.' }, { incidentId, batchKey: key }));
    expect((await p.drainOnce()).sent).toEqual([]);

    time = T0 + COMMENT_WINDOW_MS;
    const report = await p.drainOnce();
    expect(report.sent).toHaveLength(3);
    expect(commentTexts(jira.issue('WEB-7'))).toEqual([['Stopped by @pat.', 'Claimed by @sam.', 'Escalated to P1.']]);

    // A row after the window starts a new batch.
    time = T0 + 70_000;
    await enqueue(row('add-comment', { issueKey: 'WEB-7', text: 'Fixer failed.' }, { incidentId, batchKey: key }));
    expect((await p.drainOnce()).held).toHaveLength(1);
    time = T0 + 70_000 + COMMENT_WINDOW_MS;
    await p.drainOnce();
    expect(commentTexts(jira.issue('WEB-7'))).toEqual([['Stopped by @pat.', 'Claimed by @sam.', 'Escalated to P1.'], ['Fixer failed.']]);
  });
});

describe('backpressure (B 11)', () => {
  it('pauses the drain for Retry-After: 30 on a 429 and does not mark the row failed', async () => {
    const incidentId = ulid(time);
    const create = row('create-issue', createIssuePayload({}), { incidentId });
    await enqueue(create);
    jira.fail('POST /rest/api/3/issue', 429, { 'Retry-After': '30' });
    const p = projector();

    const first = await p.drainOnce();
    expect(first.pausedUntil).toBe(new Date(T0 + 30_000).toISOString());
    expect(first.deferred).toEqual([]);
    expect(first.parked).toEqual([]);
    expect(await state.drainOutbox('jira', 10, WS)).toEqual([create]); // untouched: no attempt, no error
    expect(await p.metrics()).toContain(`snapwing_jira_drain_paused_seconds{workspace="${WS}"} 30`);

    time = T0 + 29_999;
    const requests = jira.requests.length;
    expect((await p.drainOnce()).drained).toBe(0);
    expect(jira.requests).toHaveLength(requests);

    time = T0 + 30_000;
    expect((await p.drainOnce()).sent).toEqual([create.id]);
    expect(jira.issues.size).toBe(1);
    expect(await state.listParkedOutbox('jira', 10)).toEqual([]);
  });

  it('backs off other failures, keeps the incident in order, and parks after the attempt limit with the error in metrics', async () => {
    const incidentId = ulid(time);
    jira.issues.set('WEB-9', { key: 'WEB-9', fields: {}, labels: [], status: 'Backlog', comments: [], attachments: [] });
    const labels = row('add-labels', { issueKey: 'WEB-9', labels: ['fixer-failed'] }, { incidentId });
    const transition = row('transition', { issueKey: 'WEB-9', to: 'Done' }, { incidentId });
    const other = row('transition', { issueKey: 'WEB-9', to: 'In Review' });
    await enqueue(labels, transition, other);
    for (let i = 0; i < 3; i++) jira.fail('PUT /rest/api/3/issue/WEB-9', 503);
    const p = projector({ maxAttempts: 3 });

    let report = await p.drainOnce();
    expect(report.deferred).toEqual([labels.id]);
    expect(report.sent).toEqual([other.id]); // another lane is not held up
    expect(jira.issue('WEB-9').status).toBe('In Review');

    time = T0 + 999;
    expect((await p.drainOnce()).drained).toBe(0); // the transition waits behind the deferred row
    time = T0 + 1000;
    expect((await p.drainOnce()).deferred).toEqual([labels.id]);
    time = T0 + 3000;
    report = await p.drainOnce();
    expect(report.parked).toEqual([labels.id]);
    expect(report.sent).toEqual([transition.id]); // a parked row stops holding its incident back
    expect(jira.issue('WEB-9').status).toBe('Done');

    const [parked] = await state.listParkedOutbox('jira', 10);
    expect(parked?.id).toBe(labels.id);
    expect(parked?.attempts).toBe(3);
    expect(parked?.lastError).toBe('gave up after 3 attempts: jira answered 503 for PUT /rest/api/3/issue/WEB-9');
    const metrics = await p.metrics();
    expect(metrics).toContain(`snapwing_outbox_parked_rows{target="jira",workspace="${WS}"} 1`);
    expect(metrics).toContain(`id="${labels.id}",op="add-labels",incident="${incidentId}",error="gave up after 3 attempts: jira answered 503 for PUT /rest/api/3/issue/WEB-9"} 3`);
  });
});

describe('validation', () => {
  it('parks a row that fails validation without calling Jira, and shows why in metrics', async () => {
    const incidentId = ulid(time);
    const bad = row('create-issue', createIssuePayload({ summary: '' }), { incidentId });
    const badKey = row('add-comment', { issueKey: 'not a key', text: 'hi' });
    await enqueue(bad, badKey);
    const p = projector();

    const report = await p.drainOnce();

    expect(report.parked).toEqual([bad.id, badKey.id]);
    expect(jira.requests).toEqual([]);
    expect(await filedEvents(incidentId)).toEqual([]);
    expect(continued).toEqual([]);
    const parked = await state.listParkedOutbox('jira', 10);
    expect(parked.find((r) => r.id === bad.id)?.lastError).toBe(`outbox row ${bad.id} (create-issue): fields.summary must be a non-empty string`);
    expect(await p.metrics()).toContain('error="outbox row');
  });

  it('parks a row Jira rejects with 400 at once', async () => {
    jira.issues.set('WEB-3', { key: 'WEB-3', fields: {}, labels: [], status: 'Backlog', comments: [], attachments: [] });
    const bad = row('update-fields', { issueKey: 'WEB-3', fields: { priority: { name: 'Nope' } } });
    await enqueue(bad);
    jira.fail('PUT /rest/api/3/issue/WEB-3', 400);
    expect((await projector().drainOnce()).parked).toEqual([bad.id]);
    expect((await state.listParkedOutbox('jira', 10)).find((r) => r.id === bad.id)?.attempts).toBe(1);
  });
});

describe('transition resolution', () => {
  const key = 'WEB-6';
  const seed = (): void => {
    jira.issues.set(key, { key, fields: {}, labels: [], status: 'In Progress', comments: [], attachments: [] });
  };

  it("posts the transition with the resolution (Not a bug: Done, Won't Do)", async () => {
    seed();
    const r = row('transition', { issueKey: key, to: 'Done', resolution: "Won't Do" });
    await enqueue(r);

    expect((await projector().drainOnce()).sent).toEqual([r.id]);

    expect(jira.transitionBodies).toEqual([{ id: '14', fields: { resolution: { name: "Won't Do" } } }]);
    expect(jira.issue(key).status).toBe('Done');
    expect(jira.issue(key).resolution).toBe("Won't Do");
    expect(jira.issue(key).comments).toEqual([]);
  });

  it('sends no fields when the row has no resolution', async () => {
    seed();
    await enqueue(row('transition', { issueKey: key, to: 'Done' }));
    await projector().drainOnce();
    expect(jira.transitionBodies).toEqual([{ id: '14' }]);
  });

  it('falls back to the plain transition, logs it, and comments when the screen lacks the field', async () => {
    seed();
    jira.noResolutionField = true;
    const r = row('transition', { issueKey: key, to: 'Done', resolution: "Won't Do" });
    await enqueue(r);

    expect((await projector().drainOnce()).sent).toEqual([r.id]);

    expect(jira.transitionBodies).toEqual([{ id: '14', fields: { resolution: { name: "Won't Do" } } }, { id: '14' }]);
    expect(jira.issue(key).status).toBe('Done');
    expect(jira.issue(key).resolution).toBeUndefined();
    expect(clientLog).toHaveLength(1);
    expect(clientLog[0]).toContain("Won't Do");
    expect(commentTexts(jira.issue(key))[0]?.[0]).toContain('could not set the resolution "Won\'t Do"');
  });

  it('does not send a row whose resolution is not a non-empty string', async () => {
    seed();
    const r = row('transition', { issueKey: key, to: 'Done', resolution: '  ' });
    await enqueue(r);
    const report = await projector().drainOnce();
    expect(report.sent).toEqual([]);
    expect(jira.transitionBodies).toEqual([]);
  });
});

describe('other ops', () => {
  it('transitions, adds labels, updates mapped fields, and drops a name with no id', async () => {
    jira.issues.set('WEB-5', { key: 'WEB-5', fields: {}, labels: ['snapwing'], status: 'Backlog', comments: [], attachments: [] });
    const rows = [
      row('transition', { issueKey: 'WEB-5', to: 'in progress' }),
      row('add-labels', { issueKey: 'WEB-5', labels: ['human-claimed'] }),
      row('update-fields', { issueKey: 'WEB-5', customFields: { 'Autonomy Level': 1 } }),
      row('update-fields', { issueKey: 'WEB-5', customFields: { 'Agent Status': 'fixing · PR #418' } }),
      row('update-fields', { issueKey: 'WEB-5', customFields: { 'Unmapped Field': 'x' } }),
      row('add-comment', { issueKey: 'WEB-5', text: 'Linked from a duplicate report.' }),
    ];
    await enqueue(...rows);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual(rows.map((r) => r.id));
    const issue = jira.issue('WEB-5');
    expect(issue.status).toBe('In Progress');
    expect(issue.labels).toEqual(['snapwing', 'human-claimed']);
    expect(issue.fields).toEqual({ customfield_10042: 1, customfield_10043: 'fixing · PR #418' });
    expect(commentTexts(issue)).toEqual([['Linked from a duplicate report.']]);
    expect(jira.requests.filter((r) => r === 'PUT /rest/api/3/issue/WEB-5')).toHaveLength(3);
  });

  it('drains only its own workspace', async () => {
    const theirs = row('transition', { issueKey: 'OPS-1', to: 'Done' }, { workspaceId: '01K0000000000000000000WS02' });
    await enqueue(theirs);
    expect((await projector().drainOnce()).drained).toBe(0);
    expect(jira.requests).toEqual([]);
  });
});

describe('loop', () => {
  it('start polls and stop waits for the pass in flight', async () => {
    jira.issues.set('WEB-2', { key: 'WEB-2', fields: {}, labels: [], status: 'Backlog', comments: [], attachments: [] });
    await enqueue(row('transition', { issueKey: 'WEB-2', to: 'Done' }));
    const p = projector({ pollIntervalMs: 5 });
    p.start();
    await expect.poll(() => jira.issue('WEB-2').status).toBe('Done');
    await p.stop();
  });
});
