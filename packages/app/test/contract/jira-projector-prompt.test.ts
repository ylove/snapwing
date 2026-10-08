// Jira projector, placeholder key rewrite and field id mapping (main 9.1, B 7.2). The Jira side
// is MSW answering with the shapes of the recorded payloads (test/fixtures/jira/create-issue.json for
// the create answer; the edit answers 204), and every request body is kept so the test reads back what
// was sent: first the create with the placeholder key, then the update-fields with the real one.

import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import type { NewEvent } from '@snapwing/pipeline/contracts/events.ts';
import type { OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import type { OpenedState } from '@snapwing/pipeline/ports/state.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import { createTestDatabase, type TestDatabase } from '../../../pipeline/test/helpers/db.ts';
import { createJiraClient } from '../../src/jira/client/index.ts';
import { createJiraProjector } from '../../src/jira/projector/drain.ts';
import { JiraFieldConfigError, customFieldIdsFromEnv } from '../../src/jira/projector/fields.ts';
import { rewriteIssueKey } from '../../src/jira/projector/prompt.ts';

/** The XML inside the Implementation Prompt's ADF code block (REST v3 takes the multi-line field as ADF). */
function adfXml(value: unknown): string {
  const doc = value as { type: string; content: { type: string; content: { text: string }[] }[] };
  expect(doc.type).toBe('doc');
  expect(doc.content[0]?.type).toBe('codeBlock');
  return doc.content[0]?.content[0]?.text ?? '';
}

const BASE = 'https://example.atlassian.net';
const WS = '01K0000000000000000000WS01';
const T0 = Date.parse('2026-10-02T12:00:00.000Z');
const IDS = {
  'Implementation Prompt': 'customfield_10040',
  'Conversation Link': 'customfield_10041',
  'Autonomy Level': 'customfield_10042',
  'Agent Status': 'customfield_10043',
};
const REQUEST = readFileSync(new URL('../../../../examples/implementation-request.example.xml', import.meta.url), 'utf8')
  .replace('issue="WEB-1042"', 'issue="WEB-0"')
  .replace('attachment:WEB-1042/', 'attachment:WEB-0/');

interface Recorded {
  method: string;
  path: string;
  body: Record<string, unknown> | undefined;
}

let requests: Recorded[];
const server = setupServer(
  http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
    requests.push({ method: 'POST', path: '/search/jql', body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({ issues: [], isLast: true });
  }),
  http.post(`${BASE}/rest/api/3/issue`, async ({ request }) => {
    requests.push({ method: 'POST', path: '/issue', body: (await request.json()) as Record<string, unknown> });
    return HttpResponse.json({ id: '10005', key: 'WEB-5', self: `${BASE}/rest/api/3/issue/10005` }, { status: 201 });
  }),
  http.put(`${BASE}/rest/api/3/issue/:key`, async ({ request, params }) => {
    requests.push({ method: 'PUT', path: `/issue/${String(params['key'])}`, body: (await request.json()) as Record<string, unknown> });
    return new HttpResponse(null, { status: 204 });
  }),
);
beforeAll(() => server.listen());
afterAll(() => server.close());

let tdb: TestDatabase;
let state: OpenedState;
beforeAll(async () => {
  tdb = await createTestDatabase();
  state = await tdb.open({ now: () => new Date(T0) });
});
afterAll(async () => {
  await tdb.drop();
});
beforeEach(() => {
  requests = [];
});
afterEach(() => server.resetHandlers());

const client = createJiraClient({ baseUrl: BASE, email: 'bot@example.com', apiToken: 'jira-token-test' });

function event<T extends NewEvent['type']>(incidentId: string, type: T, payload: Extract<NewEvent, { type: T }>['payload']): NewEvent {
  return { workspaceId: WS, incidentId, type, v: 1, source: 'agent', occurredAt: new Date(T0).toISOString(), payload } as NewEvent;
}

/** An incident with a stored implementation request (version 1 holds the placeholder key). */
async function planned(body: string): Promise<{ incidentId: string; artifactId: string }> {
  const incidentId = ulid(T0 + Math.floor(Math.random() * 1e6));
  const { id } = await state.putArtifact({ workspaceId: WS, incidentId, kind: 'implementation-request', contentType: 'application/xml', body, createdBy: 'test' });
  await state.append(
    incidentId,
    [
      event(incidentId, 'planned', {
        action: 'create_issue',
        projectKey: 'WEB',
        issueType: 'Bug',
        summary: 'Cart total is blank',
        priority: 'High',
        labels: [],
        autonomyLevel: 2,
        implementationRequest: { artifactId: id, version: 1 },
      }),
    ],
    0,
  );
  return { incidentId, artifactId: id };
}

async function enqueueCreate(incidentId: string): Promise<void> {
  const at = new Date(T0).toISOString();
  const row: OutboxItem = {
    id: `${ulid(T0).slice(0, 10)}${incidentId.slice(10)}`,
    workspaceId: WS,
    target: 'jira',
    op: 'create-issue',
    incidentId,
    attempts: 0,
    nextAttempt: at,
    createdAt: at,
    payload: {
      fields: {
        project: { key: 'WEB' },
        issuetype: { name: 'Bug' },
        summary: 'Cart total is blank',
        description: { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Reported.' }] }] },
        priority: { name: 'High' },
        labels: ['snapwing'],
      },
      customFields: { 'Implementation Prompt': REQUEST, 'Conversation Link': 'https://slack.example.com/archives/C1/p1', 'Autonomy Level': 2 },
    },
  };
  await state.enqueueOutbox(row);
}

function projector(onContinue: (id: string) => Promise<unknown> = async () => undefined) {
  return createJiraProjector({ state, client, workspaceId: WS, continueIncident: onContinue, customFieldIds: IDS, now: () => new Date(T0) });
}

describe('projector startup', () => {
  it('fails loudly, naming each custom field with no id', () => {
    const { 'Autonomy Level': _a, 'Agent Status': _s, ...partial } = IDS;
    let thrown: unknown;
    try {
      createJiraProjector({ state, client, workspaceId: WS, continueIncident: async () => undefined, customFieldIds: partial });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(JiraFieldConfigError);
    expect((thrown as JiraFieldConfigError).missing).toEqual(['Autonomy Level', 'Agent Status']);
  });

  it('reads the ids the bootstrap writes into .env.live', () => {
    const env = { JIRA_FIELD_IMPL_PROMPT: 'customfield_10040', JIRA_FIELD_CONVERSATION: 'customfield_10041', JIRA_FIELD_AUTONOMY: 'customfield_10042', JIRA_FIELD_AGENT_STATUS: 'customfield_10043' };
    expect(customFieldIdsFromEnv(env)).toEqual(IDS);
    expect(() => customFieldIdsFromEnv({ ...env, JIRA_FIELD_AUTONOMY: '' })).toThrow(/Autonomy Level/);
    expect(() => customFieldIdsFromEnv({ ...env, JIRA_FIELD_AUTONOMY: '10042' })).toThrow(JiraFieldConfigError);
  });
});

describe('rewriteIssueKey', () => {
  it('rewrites the root issue and screenshot refs, and leaves other keys alone', () => {
    const xml = '<implementation-request xmlns="urn:x" issue="WEB-0"><evidence><screenshot ref="attachment:WEB-0/a.png"/></evidence><note issue="WEB-0"/></implementation-request>';
    expect(rewriteIssueKey(xml, 'WEB-0', 'WEB-5')).toBe(
      '<implementation-request xmlns="urn:x" issue="WEB-5"><evidence><screenshot ref="attachment:WEB-5/a.png"/></evidence><note issue="WEB-0"/></implementation-request>',
    );
    expect(rewriteIssueKey(xml, 'WEB-0', 'WEB-5')).toBe(rewriteIssueKey(rewriteIssueKey(xml, 'WEB-0', 'WEB-5'), 'WEB-0', 'WEB-5'));
  });
});

describe('create-issue then update-fields', () => {
  it('writes the real key into a new artifact version and the Implementation Prompt field before continuing', async () => {
    const { incidentId, artifactId } = await planned(REQUEST);
    await enqueueCreate(incidentId);
    let atContinue: string | undefined;

    const report = await projector(async () => {
      atContinue = (await state.getArtifact(artifactId)).body;
    }).drainOnce();

    expect(report.sent).toHaveLength(1);
    expect(report.parked).toEqual([]);
    // The create carried the mapped ids and the placeholder prompt.
    const create = requests.find((r) => r.path === '/issue')!;
    const createFields = create.body!['fields'] as Record<string, unknown>;
    expect(createFields['customfield_10041']).toBe('https://slack.example.com/archives/C1/p1');
    expect(createFields['customfield_10042']).toBe(2);
    expect(adfXml(createFields['customfield_10040'])).toContain('issue="WEB-0"');
    // Then the update-fields: the real key, in the field named by the bootstrap's id.
    const update = requests.find((r) => r.method === 'PUT')!;
    expect(update.path).toBe('/issue/WEB-5');
    const prompt = adfXml((update.body!['fields'] as Record<string, unknown>)['customfield_10040']);
    expect(prompt).toContain('issue="WEB-5"');
    expect(prompt).toContain('attachment:WEB-5/cart-blank.png');
    expect(prompt).not.toContain('WEB-0');
    // The artifact has a new version with the same body; version 1 is untouched.
    const v2 = await state.getArtifact(artifactId, 2);
    expect(v2.body).toBe(prompt);
    expect((await state.getArtifact(artifactId, 1)).body).toBe(REQUEST);
    expect(atContinue).toBe(prompt);
    expect((await state.read(incidentId)).filter((e) => e.type === 'filed').map((e) => e.payload)).toEqual([{ jiraKey: 'WEB-5' }]);
  });

  it('does not store a third version when the row is repeated after a crash', async () => {
    const { incidentId, artifactId } = await planned(REQUEST);
    await enqueueCreate(incidentId);
    const crash: Error = new Error('crash before ack');
    const dying = createJiraProjector({
      state: new Proxy(state, {
        get(target, prop, receiver) {
          if (prop === 'ackOutbox') return () => Promise.reject(crash);
          const value: unknown = Reflect.get(target, prop, receiver);
          return typeof value === 'function' ? value.bind(target) : value;
        },
      }),
      client,
      workspaceId: WS,
      continueIncident: async () => undefined,
      customFieldIds: IDS,
      now: () => new Date(T0),
    });
    await dying.drainOnce();
    expect((await state.getArtifact(artifactId)).version).toBe(2);

    // The label search finds nothing in this fake, so a second issue is not what is asserted here:
    // only that the artifact is not versioned again and the field write repeats the same value.
    requests = [];
    const { finalizePrompt } = await import('../../src/jira/projector/prompt.ts');
    const again = await finalizePrompt({ state, client, incidentId, issueKey: 'WEB-5', projectKey: 'WEB', fieldId: IDS['Implementation Prompt'], createdBy: 'test' });
    expect(again).toEqual({ status: 'written', version: 2, rewritten: false });
    expect((await state.getArtifact(artifactId)).version).toBe(2);
    expect(requests.filter((r) => r.method === 'PUT')).toHaveLength(1);
  });

  it('applies prompt-failed and clears the field when the rewritten request no longer validates', async () => {
    const broken = REQUEST.replace('<intent>', '<unexpected/><intent>');
    const { incidentId, artifactId } = await planned(broken);
    await enqueueCreate(incidentId);

    const report = await projector().drainOnce();

    expect(report.sent).toHaveLength(1);
    expect((await state.getArtifact(artifactId)).version).toBe(1);
    const puts = requests.filter((r) => r.method === 'PUT');
    expect(puts.map((p) => p.body)).toEqual([
      { update: { labels: [{ add: 'prompt-failed' }] } },
      { fields: { customfield_10040: null } },
    ]);
  });

  it('leaves the field and artifacts alone when no implementation request was stored', async () => {
    const incidentId = ulid(T0 + 7);
    await state.append(incidentId, [event(incidentId, 'waiting-changed', {})], 0);
    await enqueueCreate(incidentId);

    const report = await projector().drainOnce();

    expect(report.sent).toHaveLength(1);
    expect(requests.filter((r) => r.method === 'PUT')).toEqual([]);
  });
});
