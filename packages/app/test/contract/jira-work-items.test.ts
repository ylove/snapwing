// Work item issues (B 6.4, #317): a `create-issue` row with a `parentKey` is joined to its parent by an
// issue link (the work item on the inward side) or filed as a sub-task, against an in-memory Jira behind
// MSW, on the dialect `SNAPWING_DB` selects. Also the two client methods onboarding lists link types with.

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createJiraClient } from '../../src/jira/client/index.ts';
import { createJiraProjector, type JiraProjectorOptions } from '../../src/jira/projector/drain.ts';
import { OutboxValidationError, parseJiraRow } from '../../src/jira/projector/ops.ts';

const BASE = 'https://example.atlassian.net';
const T0 = Date.parse('2026-10-12T12:00:00.000Z');
const WS = '01K0000000000000000000WS01';
const PARENT = 'WEB-1';

interface FakeIssue {
  key: string;
  fields: Record<string, unknown>;
  labels: string[];
  comments: string[];
  links: { type: string; inward: string; outward: string }[];
}

class FakeJira {
  issues = new Map<string, FakeIssue>();
  next = 2;
  linkTypes: { id: string; name: string; inward: string; outward: string }[] = [
    { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
    { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' },
  ];
  /** Issue types the project lists; a vanilla company-managed project has a Sub-task. */
  issueTypes: { id: string; name: string; subtask: boolean }[] = [
    { id: '1', name: 'Bug', subtask: false },
    { id: '2', name: 'Sub-task', subtask: true },
  ];
  linkBodies: unknown[] = [];
  requests: string[] = [];
  /** Statuses for the next `POST /issueLink`, in order. */
  linkFailures: number[] = [];

  constructor() {
    this.issues.set(PARENT, { key: PARENT, fields: {}, labels: [], comments: [], links: [] });
  }

  issue(key: string): FakeIssue {
    const issue = this.issues.get(key);
    if (issue === undefined) throw new Error(`no issue ${key}`);
    return issue;
  }

  handlers() {
    const seen = (request: Request): void => {
      this.requests.push(`${request.method} ${new URL(request.url).pathname}`);
    };
    const missing = (key: string) => HttpResponse.json({ errorMessages: [`Issue ${key} does not exist`] }, { status: 404 });
    return [
      http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
        seen(request);
        const body = (await request.json()) as { jql: string };
        const label = /labels = "([^"]+)"/.exec(body.jql)?.[1];
        const issues = [...this.issues.values()]
          .filter((i) => label !== undefined && i.labels.includes(label))
          .map((i) => ({ id: i.key, key: i.key, self: `${BASE}/issue/${i.key}`, fields: { attachment: [] } }));
        return HttpResponse.json({ issues, isLast: true });
      }),
      http.post(`${BASE}/rest/api/3/issue`, async ({ request }) => {
        seen(request);
        const { fields } = (await request.json()) as { fields: Record<string, unknown> };
        const parent = fields['parent'] as { key: string } | undefined;
        if (parent !== undefined && !this.issues.has(parent.key)) return HttpResponse.json({ errorMessages: [], errors: { parent: 'unknown parent' } }, { status: 400 });
        const key = `${(fields['project'] as { key: string }).key}-${this.next++}`;
        this.issues.set(key, { key, fields, labels: [...(fields['labels'] as string[])], comments: [], links: [] });
        return HttpResponse.json({ id: key, key, self: `${BASE}/issue/${key}` }, { status: 201 });
      }),
      http.put(`${BASE}/rest/api/3/issue/:key`, async ({ request, params }) => {
        seen(request);
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const body = (await request.json()) as { fields?: Record<string, unknown> };
        Object.assign(issue.fields, body.fields ?? {});
        return new HttpResponse(null, { status: 204 });
      }),
      http.get(`${BASE}/rest/api/3/issue/:key`, ({ request, params }) => {
        seen(request);
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const issuelinks = issue.links.map((l) =>
          l.inward === issue.key
            ? { type: { name: l.type }, outwardIssue: { key: l.outward } }
            : { type: { name: l.type }, inwardIssue: { key: l.inward } },
        );
        const parent = issue.fields['parent'];
        return HttpResponse.json({ id: issue.key, key: issue.key, self: `${BASE}/issue/${issue.key}`, fields: { issuelinks, ...(parent === undefined ? {} : { parent }) } });
      }),
      http.post(`${BASE}/rest/api/3/issue/:key/comment`, async ({ request, params }) => {
        seen(request);
        const issue = this.issues.get(String(params['key']));
        if (issue === undefined) return missing(String(params['key']));
        const { body } = (await request.json()) as { body: { content: { content: { text: string }[] }[] } };
        issue.comments.push(body.content.map((p) => p.content[0]?.text ?? '').join('\n'));
        return HttpResponse.json({ id: String(issue.comments.length) }, { status: 201 });
      }),
      http.get(`${BASE}/rest/api/3/project/:key`, ({ request, params }) => {
        seen(request);
        return HttpResponse.json({ id: '10', key: String(params['key']), style: 'classic', issueTypes: this.issueTypes });
      }),
      http.get(`${BASE}/rest/api/3/issueLinkType`, ({ request }) => {
        seen(request);
        return HttpResponse.json({ issueLinkTypes: this.linkTypes });
      }),
      http.post(`${BASE}/rest/api/3/issueLink`, async ({ request }) => {
        seen(request);
        const body = (await request.json()) as { type: { name: string }; inwardIssue: { key: string }; outwardIssue: { key: string } };
        this.linkBodies.push(body);
        const failure = this.linkFailures.shift();
        if (failure !== undefined) return HttpResponse.json({ errorMessages: [`injected ${failure}`] }, { status: failure });
        if (!this.linkTypes.some((t) => t.name === body.type.name)) {
          return HttpResponse.json({ errorMessages: [`No issue link type with name '${body.type.name}' found.`] }, { status: 404 });
        }
        const link = { type: body.type.name, inward: body.inwardIssue.key, outward: body.outwardIssue.key };
        this.issue(link.inward).links.push(link);
        this.issue(link.outward).links.push(link);
        return new HttpResponse(null, { status: 201 });
      }),
    ];
  }
}

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
  time = T0 + 365 * 24 * 3600 * 1000;
  for (let rows = await state.drainOutbox('jira', 1000); rows.length > 0; rows = await state.drainOutbox('jira', 1000)) {
    await state.ackOutbox(rows.map((r) => r.id));
  }
  time = T0;
  jira = new FakeJira();
  server.use(...jira.handlers());
  continued = [];
});
afterEach(() => server.resetHandlers());

const client = createJiraClient({ baseUrl: BASE, email: 'bot@example.com', apiToken: 'jira-token-test', log: () => undefined });

function projector(overrides: Partial<JiraProjectorOptions> = {}) {
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
function row(op: string, payload: Record<string, unknown>, extra: Partial<OutboxItem> = {}): OutboxItem {
  const at = new Date(time).toISOString();
  const id = `${ulid(time).slice(0, 10)}${String(++serial).padStart(16, '0')}`;
  return { id, workspaceId: WS, target: 'jira', op, payload, attempts: 0, nextAttempt: at, createdAt: at, ...extra };
}

function workItemPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    fields: {
      project: { key: 'WEB' },
      issuetype: { name: 'Bug' },
      summary: 'Promo code field rejects lowercase',
      description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'A work item.' }] }] },
      labels: ['snapwing'],
    },
    customFields: { 'Implementation Prompt': '<implementation-request/>' },
    parentKey: PARENT,
    ...overrides,
  };
}

function waitingChanged(incidentId: string): NewEvent<'waiting-changed'> {
  return { workspaceId: WS, incidentId, type: 'waiting-changed', v: 1, source: 'agent', occurredAt: new Date(time).toISOString(), payload: {} };
}

async function fileWorkItem(options: Partial<JiraProjectorOptions> = {}, payload: Record<string, unknown> = workItemPayload()) {
  const incidentId = ulid(time);
  await state.append(incidentId, [waitingChanged(incidentId)], 0);
  const create = row('create-issue', payload, { incidentId });
  await state.enqueueOutbox(create);
  const report = await projector(options).drainOnce();
  return { incidentId, create, report };
}

describe('link mode (the default)', () => {
  it('joins the new issue to its parent with a Relates link, the work item on the inward side', async () => {
    const { create, report } = await fileWorkItem();

    expect(report.sent).toEqual([create.id]);
    expect(jira.linkBodies).toEqual([{ type: { name: 'Relates' }, inwardIssue: { key: 'WEB-2' }, outwardIssue: { key: PARENT } }]);
    expect(jira.issue('WEB-2').fields['parent']).toBeUndefined();
    expect(jira.issue('WEB-2').fields['issuetype']).toEqual({ name: 'Bug' });
    expect(jira.issue('WEB-2').comments).toEqual([]);
  });

  it('uses the configured link type', async () => {
    jira.linkTypes.push({ id: '10009', name: 'Implements', inward: 'is implemented by', outward: 'implements' });
    await fileWorkItem({ workItems: { mode: 'link', linkType: 'implements' } });

    expect(jira.linkBodies).toEqual([{ type: { name: 'Implements' }, inwardIssue: { key: 'WEB-2' }, outwardIssue: { key: PARENT } }]);
  });

  it('adds nothing when the row has no parentKey', async () => {
    const payload = workItemPayload();
    delete payload['parentKey'];
    await fileWorkItem({}, payload);

    expect(jira.linkBodies).toEqual([]);
    expect(jira.requests.some((r) => r.includes('issueLink'))).toBe(false);
  });

  it('finds the existing link on a retry instead of adding a second', async () => {
    const incidentId = ulid(time);
    await state.append(incidentId, [waitingChanged(incidentId)], 0);
    const create = row('create-issue', workItemPayload(), { incidentId });
    await state.enqueueOutbox(create);

    // The first worker dies inside the ack: the issue and its link exist, the row is still pending.
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
    expect(jira.linkBodies).toHaveLength(1);

    const report = await projector().drainOnce();

    expect(report.sent).toEqual([create.id]);
    expect(jira.issues.size).toBe(2);
    expect(jira.linkBodies).toHaveLength(1);
    expect(jira.issue('WEB-2').links).toHaveLength(1);
  });

  it('leaves the issue unlinked, comments once naming the parent, and acks the row when the site lacks the link type', async () => {
    const { create, report } = await fileWorkItem({ workItems: { mode: 'link', linkType: 'Implements' } });

    expect(report.sent).toEqual([create.id]);
    expect(report.parked).toEqual([]);
    expect(jira.linkBodies).toEqual([]);
    expect(jira.issue('WEB-2').links).toEqual([]);
    expect(jira.issue('WEB-2').comments).toEqual([`Snapwing could not link this issue to ${PARENT}: this Jira site has no "Implements" issue link type. Parent: ${PARENT}.`]);
    expect(await state.drainOutbox('jira', 10, WS)).toEqual([]);
  });

  it('degrades to the same comment when Jira refuses the link, and still acks', async () => {
    jira.linkFailures.push(404);
    const { report, create } = await fileWorkItem();

    expect(report.sent).toEqual([create.id]);
    expect(jira.issue('WEB-2').comments).toHaveLength(1);
    expect(jira.issue('WEB-2').comments[0]).toContain(PARENT);
  });

  it('defers the row on a transient link failure, and the retry links without a second issue', async () => {
    jira.linkFailures.push(500);
    const { report, create } = await fileWorkItem();

    expect(report.deferred).toEqual([create.id]);
    expect(jira.issue('WEB-2').links).toEqual([]);

    time += 5_000;
    const retry = await projector().drainOnce();

    expect(retry.sent).toEqual([create.id]);
    expect(jira.issues.size).toBe(2);
    expect(jira.issue('WEB-2').links).toHaveLength(1);
  });
});

describe('sub-task mode', () => {
  it('creates the issue as the sub-task type with the parent set, and adds no link', async () => {
    const { create, report } = await fileWorkItem({ workItems: { mode: 'subtask', linkType: 'Relates' } });

    expect(report.sent).toEqual([create.id]);
    const issue = jira.issue('WEB-2');
    expect(issue.fields['issuetype']).toEqual({ name: 'Sub-task' });
    expect(issue.fields['parent']).toEqual({ key: PARENT });
    expect(jira.linkBodies).toEqual([]);
    expect(jira.issue(PARENT).comments).toEqual([]);
  });

  it('does not link a sub-task a previous attempt created', async () => {
    const incidentId = ulid(time);
    await state.append(incidentId, [waitingChanged(incidentId)], 0);
    const create = row('create-issue', workItemPayload(), { incidentId });
    await state.enqueueOutbox(create);
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
    const options = { workItems: { mode: 'subtask', linkType: 'Relates' } } as const;
    void projector({ ...options, state: dying }).drainOnce();
    await expect.poll(() => reachedAck).toBe(true);

    const report = await projector(options).drainOnce();

    expect(report.sent).toEqual([create.id]);
    expect(jira.issues.size).toBe(2);
    expect(jira.linkBodies).toEqual([]);
  });

  it('falls back to a link when the project has no sub-task type, and says so once on the parent', async () => {
    jira.issueTypes = [{ id: '1', name: 'Bug', subtask: false }];
    const { create, report } = await fileWorkItem({ workItems: { mode: 'subtask', linkType: 'Relates' } });

    expect(report.sent).toEqual([create.id]);
    const issue = jira.issue('WEB-2');
    expect(issue.fields['issuetype']).toEqual({ name: 'Bug' });
    expect(issue.fields['parent']).toBeUndefined();
    expect(jira.linkBodies).toEqual([{ type: { name: 'Relates' }, inwardIssue: { key: 'WEB-2' }, outwardIssue: { key: PARENT } }]);
    expect(jira.issue(PARENT).comments).toEqual(['Snapwing linked WEB-2 to this issue instead of filing it as a sub-task: project WEB has no sub-task issue type.']);
  });
});

describe('the create-issue payload', () => {
  it('rejects a parentKey that is not an issue key, before anything is sent', () => {
    const bad = row('create-issue', workItemPayload({ parentKey: 'not a key' }), { incidentId: ulid(time) });
    expect(() => parseJiraRow(bad)).toThrow(OutboxValidationError);
    expect(() => parseJiraRow(bad)).toThrow(/parentKey/);
  });

  it('keeps a row without a parentKey exactly as before', () => {
    const payload = workItemPayload();
    delete payload['parentKey'];
    const op = parseJiraRow(row('create-issue', payload, { incidentId: ulid(time) }));
    expect(op).not.toHaveProperty('parentKey');
  });
});

describe('client: link types and links (#317, #321)', () => {
  it('listIssueLinkTypes reads the site link types', async () => {
    server.use(...jira.handlers());
    expect(await client.listIssueLinkTypes()).toEqual([
      { id: '10000', name: 'Blocks', inward: 'is blocked by', outward: 'blocks' },
      { id: '10003', name: 'Relates', inward: 'relates to', outward: 'relates to' },
    ]);
  });

  it('createIssueLink posts the type name with the inward and outward keys', async () => {
    jira.issues.set('WEB-9', { key: 'WEB-9', fields: {}, labels: [], comments: [], links: [] });
    await client.createIssueLink({ typeName: 'Relates', inwardKey: 'WEB-9', outwardKey: PARENT });
    expect(jira.linkBodies).toEqual([{ type: { name: 'Relates' }, inwardIssue: { key: 'WEB-9' }, outwardIssue: { key: PARENT } }]);
  });

  it('createIssueLink throws a not-found error for a link type the site lacks', async () => {
    await expect(client.createIssueLink({ typeName: 'Implements', inwardKey: 'WEB-9', outwardKey: PARENT })).rejects.toThrow(/issueLink/);
  });

  it('getProject lists the issue types with their sub-task flag', async () => {
    expect((await client.getProject('WEB')).issueTypes).toEqual([
      { id: '1', name: 'Bug', subtask: false },
      { id: '2', name: 'Sub-task', subtask: true },
    ]);
  });
});
