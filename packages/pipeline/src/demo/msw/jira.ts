// DEMO ONLY (`pnpm demo`, main 14.3 reviewer demo mode). A fake Jira Cloud behind MSW, the JiraSearch
// the dedupe stage reads it through, and a demo outbox drainer. The real Jira projector and inbound
// sync are phase 3 (B 7); nothing outside src/demo/ may import this file.
//
// Mock side (`JiraWorld`, `jiraHandlers`): issues in memory, served on the REST v3 paths the
// projector will call: `POST /search/jql`, `GET /field`, `POST /issue`, `PUT /issue/{key}`, `GET|POST
// /issue/{key}/transitions`, `POST /issue/{key}/comment`. Basic auth with a fake email and token.
//
// Client side: `DemoJiraSearch` (dedupe's JiraSearch) and `DemoOutboxDrainer`. The drainer stands in
// for the projector: it sends each `create-issue`, `update-fields`, `add-labels`, `transition`, and
// `add-comment` row to the mock,
// acks it, and for a created issue appends `filed { jiraKey }` in the same transaction as the ack
// (with `expectedSeq`), then calls `continueIncident`. Rule 2 holds: no stage calls Jira; only this
// drainer does, from the outbox. Not done here (projector work): rewriting the implementation
// request's placeholder key, retries with backoff, and comment batching.

import { http, HttpResponse, type HttpHandler } from 'msw';
import type { NewEvent } from '../../contracts/events.ts';
import { isExpectedSeqConflict, type OutboxItem } from '../../contracts/state.ts';
import type { JiraSearch, JiraSearchHit } from '../../dedupe/index.ts';
import type { StatePort } from '../../ports/state.ts';
import type { TraceSink } from './slack.ts';

export const JIRA_BASE = 'https://acme-demo.atlassian.net';
const API = `${JIRA_BASE}/rest/api/3`;
/** Obvious fakes; the mock refuses anything else. */
export const DEMO_JIRA_EMAIL = 'demo-bot@example.com';
export const DEMO_JIRA_TOKEN = 'not-a-real-token';
const AUTH = `Basic ${Buffer.from(`${DEMO_JIRA_EMAIL}:${DEMO_JIRA_TOKEN}`).toString('base64')}`;

export interface DemoIssue {
  key: string;
  summary: string;
  status: string;
  assignee?: string;
  labels: string[];
  /** Custom field values by field name. */
  custom: Record<string, unknown>;
  comments: string[];
}

/** A seeded issue in a recording. */
export interface SeedIssue {
  key: string;
  summary: string;
  assignee?: string;
  status?: string;
}

const CUSTOM_FIELDS: readonly { id: string; name: string }[] = [
  { id: 'customfield_10050', name: 'Implementation Prompt' },
  { id: 'customfield_10051', name: 'Conversation Link' },
  { id: 'customfield_10052', name: 'Autonomy Level' },
  { id: 'customfield_10053', name: 'Agent Status' },
];

const TRANSITIONS: readonly { id: string; name: string }[] = [
  { id: '11', name: 'To Do' },
  { id: '21', name: 'In Progress' },
  { id: '31', name: 'Done' },
];

export class JiraWorld {
  readonly issues = new Map<string, DemoIssue>();

  constructor(private readonly trace: TraceSink) {}

  seed(issues: readonly SeedIssue[]): void {
    for (const s of issues) {
      this.issues.set(s.key, {
        key: s.key,
        summary: s.summary,
        status: s.status ?? 'To Do',
        ...(s.assignee === undefined ? {} : { assignee: s.assignee }),
        labels: [],
        custom: {},
        comments: [],
      });
    }
  }

  /** The next key in `project`: one past the highest number already there. */
  nextKey(project: string): string {
    let max = 0;
    for (const key of this.issues.keys()) {
      const [p, n] = key.split('-');
      if (p === project) max = Math.max(max, Number(n));
    }
    return `${project}-${max + 1}`;
  }

  note(text: string): void {
    this.trace('jira', text);
  }
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function unauthorized(request: Request): Response | undefined {
  return request.headers.get('authorization') === AUTH ? undefined : HttpResponse.json({ errorMessages: ['unauthorized'] }, { status: 401 });
}

/** The plain text of an ADF document (paragraphs of text nodes), for the trace. */
function adfText(doc: unknown): string {
  const out: string[] = [];
  const walk = (node: unknown): void => {
    const n = asRecord(node);
    if (n['type'] === 'text') out.push(str(n['text']));
    const content = n['content'];
    if (Array.isArray(content)) for (const c of content) walk(c);
  };
  walk(doc);
  return out.join(' ').replace(/\s+/g, ' ').trim();
}

export function jiraHandlers(world: JiraWorld): HttpHandler[] {
  return [
    http.post(`${API}/search/jql`, async ({ request }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      const body = asRecord(await request.json());
      const jql = str(body['jql']);
      const max = typeof body['maxResults'] === 'number' ? body['maxResults'] : 50;
      // Enough JQL for dedupe's two queries: the project clause and `statusCategory != Done`.
      const project = /project\s*=\s*"([^"]+)"/.exec(jql)?.[1];
      const issues = [...world.issues.values()]
        .filter((i) => (project === undefined || i.key.startsWith(`${project}-`)) && i.status !== 'Done')
        .slice(0, max)
        .map((i) => ({ key: i.key, fields: { summary: i.summary, assignee: i.assignee === undefined ? null : { displayName: i.assignee } } }));
      world.note(`search ${jql.includes('text ~') ? 'full text' : 'recent'} in ${project ?? 'all projects'}: ${issues.length} open`);
      return HttpResponse.json({ issues, isLast: true });
    }),
    http.get(`${API}/field`, ({ request }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      return HttpResponse.json(CUSTOM_FIELDS.map((f) => ({ ...f, custom: true })));
    }),
    http.post(`${API}/issue`, async ({ request }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      const fields = asRecord(asRecord(await request.json())['fields']);
      const project = str(asRecord(fields['project'])['key']);
      const summary = str(fields['summary']);
      if (project === '' || summary === '') return HttpResponse.json({ errors: { project: 'project and summary are required' } }, { status: 400 });
      const custom: Record<string, unknown> = {};
      for (const f of CUSTOM_FIELDS) if (fields[f.id] !== undefined) custom[f.name] = fields[f.id];
      const key = world.nextKey(project);
      const labels = Array.isArray(fields['labels']) ? fields['labels'].filter((l): l is string => typeof l === 'string') : [];
      world.issues.set(key, { key, summary, status: 'To Do', labels, custom, comments: [] });
      world.note(`POST /issue created ${key} "${summary}" (autonomy ${String(custom['Autonomy Level'])}, labels ${labels.join(', ')})`);
      return HttpResponse.json({ id: String(10000 + world.issues.size), key, self: `${API}/issue/${key}` }, { status: 201 });
    }),
    http.put(`${API}/issue/:key`, async ({ request, params }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      const issue = world.issues.get(str(params['key']));
      if (issue === undefined) return HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 });
      const body = asRecord(await request.json());
      const fields = asRecord(body['fields']);
      const changes: string[] = [];
      for (const f of CUSTOM_FIELDS) {
        if (fields[f.id] === undefined) continue;
        issue.custom[f.name] = fields[f.id];
        changes.push(`${f.name} "${String(fields[f.id])}"`);
      }
      const ops = asRecord(body['update'])['labels'];
      for (const op of Array.isArray(ops) ? ops.map(asRecord) : []) {
        const label = str(op['add']);
        if (label === '' || issue.labels.includes(label)) continue;
        issue.labels.push(label);
        changes.push(`label ${label}`);
      }
      world.note(`PUT /issue/${issue.key} ${changes.join(', ')}`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.get(`${API}/issue/:key/transitions`, ({ request, params }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      if (!world.issues.has(str(params['key']))) return HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 });
      return HttpResponse.json({ transitions: TRANSITIONS.map((t) => ({ ...t, to: { name: t.name } })) });
    }),
    http.post(`${API}/issue/:key/transitions`, async ({ request, params }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      const issue = world.issues.get(str(params['key']));
      const id = str(asRecord(asRecord(await request.json())['transition'])['id']);
      const to = TRANSITIONS.find((t) => t.id === id);
      if (issue === undefined || to === undefined) return HttpResponse.json({ errorMessages: ['bad transition'] }, { status: 400 });
      const from = issue.status;
      issue.status = to.name;
      world.note(`POST /issue/${issue.key}/transitions ${from} -> ${to.name} (the fixer webhook would fire here)`);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post(`${API}/issue/:key/comment`, async ({ request, params }) => {
      const denied = unauthorized(request);
      if (denied !== undefined) return denied;
      const issue = world.issues.get(str(params['key']));
      if (issue === undefined) return HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 });
      const text = adfText(asRecord(await request.json())['body']);
      issue.comments.push(text);
      world.note(`POST /issue/${issue.key}/comment "${text}"`);
      return HttpResponse.json({ id: String(issue.comments.length) }, { status: 201 });
    }),
  ];
}

// Client side -------------------------------------------------------------------------------------

async function jira(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { authorization: AUTH, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!res.ok) throw new Error(`jira ${method} ${path}: HTTP ${res.status} ${await res.text()}`);
  return res.status === 204 ? undefined : res.json();
}

/** Dedupe's JiraSearch over the mocked REST API. */
export class DemoJiraSearch implements JiraSearch {
  async search(jql: string, limit: number): Promise<JiraSearchHit[]> {
    const body = asRecord(await jira('POST', '/search/jql', { jql, maxResults: limit, fields: ['summary', 'assignee'] }));
    const issues = Array.isArray(body['issues']) ? body['issues'] : [];
    return issues.map((raw) => {
      const issue = asRecord(raw);
      const fields = asRecord(issue['fields']);
      const assignee = str(asRecord(fields['assignee'])['displayName']);
      return { key: str(issue['key']), summary: str(fields['summary']), ...(assignee === '' ? {} : { assignee }) };
    });
  }
}

/** What the drainer sent for one outbox row. */
export interface SentRow {
  op: string;
  issueKey: string;
  /** `transition` only. */
  to?: string;
  /** `create-issue` only: the Autonomy Level custom field sent. */
  autonomyLevel?: number;
  /** `update-fields` only: the one custom field written, and its value. */
  field?: string;
  value?: string | number;
  /** `add-labels` only. */
  labels?: string[];
}

export interface DrainerDeps {
  state: StatePort;
  workspaceId: string;
  /** The engine's `continueIncident`, called after `filed` is appended. */
  continueIncident: (incidentId: string) => Promise<unknown>;
  clock: () => Date;
}

const MAX_APPEND_ATTEMPTS = 8;

export class DemoOutboxDrainer {
  /** Every row sent, by incident, in send order. */
  readonly sent = new Map<string, SentRow[]>();
  #fieldIds: Map<string, string> | undefined;

  constructor(private readonly deps: DrainerDeps) {}

  /** Sends every pending Jira row. Resolves to the number sent. */
  async drain(): Promise<number> {
    const rows = await this.deps.state.drainOutbox('jira', 50);
    for (const row of rows) await this.send(row);
    return rows.length;
  }

  private async send(row: OutboxItem): Promise<void> {
    const p = row.payload;
    let sent: SentRow;
    let filed: string | undefined;
    switch (row.op) {
      case 'create-issue': {
        const ids = await this.fieldIds();
        const custom = asRecord(p['customFields']);
        const fields: Record<string, unknown> = { ...asRecord(p['fields']) };
        for (const [name, value] of Object.entries(custom)) {
          const id = ids.get(name);
          if (id !== undefined) fields[id] = value;
        }
        const created = asRecord(await jira('POST', '/issue', { fields }));
        filed = str(created['key']);
        const level = custom['Autonomy Level'];
        sent = { op: row.op, issueKey: filed, ...(typeof level === 'number' ? { autonomyLevel: level } : {}) };
        break;
      }
      case 'update-fields': {
        const issueKey = str(p['issueKey']);
        const ids = await this.fieldIds();
        const entries = Object.entries(asRecord(p['customFields']));
        const [entry] = entries;
        if (entries.length !== 1 || entry === undefined) throw new Error(`demo drainer: update-fields for ${issueKey} must write exactly one field`);
        const [field, value] = entry;
        const id = ids.get(field);
        if (id === undefined) throw new Error(`jira: no custom field named ${field}`);
        if (typeof value !== 'string' && typeof value !== 'number') throw new Error(`demo drainer: ${field} must be a string or a number`);
        await jira('PUT', `/issue/${issueKey}`, { fields: { [id]: value } });
        sent = { op: row.op, issueKey, field, value };
        break;
      }
      case 'add-labels': {
        const issueKey = str(p['issueKey']);
        const labels = Array.isArray(p['labels']) ? p['labels'].filter((l): l is string => typeof l === 'string') : [];
        await jira('PUT', `/issue/${issueKey}`, { update: { labels: labels.map((l) => ({ add: l })) } });
        sent = { op: row.op, issueKey, labels };
        break;
      }
      case 'transition': {
        const issueKey = str(p['issueKey']);
        const to = str(p['to']);
        const list = asRecord(await jira('GET', `/issue/${issueKey}/transitions`));
        const transitions = Array.isArray(list['transitions']) ? list['transitions'].map(asRecord) : [];
        const match = transitions.find((t) => t['name'] === to);
        if (match === undefined) throw new Error(`jira: ${issueKey} has no transition named ${to}`);
        await jira('POST', `/issue/${issueKey}/transitions`, { transition: { id: str(match['id']) } });
        sent = { op: row.op, issueKey, to };
        break;
      }
      case 'add-comment': {
        const issueKey = str(p['issueKey']);
        const body = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: str(p['text']) }] }] };
        await jira('POST', `/issue/${issueKey}/comment`, { body });
        sent = { op: row.op, issueKey };
        break;
      }
      default:
        throw new Error(`demo drainer: outbox op ${row.op} is not handled`);
    }
    const incidentId = row.incidentId;
    if (incidentId !== undefined) {
      const list = this.sent.get(incidentId) ?? [];
      list.push(sent);
      this.sent.set(incidentId, list);
    }
    if (filed === undefined || incidentId === undefined) {
      await this.deps.state.ackOutbox([row.id]);
      return;
    }
    await this.appendFiled(row, incidentId, filed);
    await this.deps.continueIncident(incidentId);
  }

  /** `filed { jiraKey }` with expectedSeq, in one transaction with the ack; a conflict re-reads. */
  private async appendFiled(row: OutboxItem, incidentId: string, jiraKey: string): Promise<void> {
    for (let i = 0; i < MAX_APPEND_ATTEMPTS; i++) {
      try {
        await this.deps.state.transaction(async (tx) => {
          const log = await tx.read(incidentId);
          const seq = log[log.length - 1]?.seq ?? 0;
          const event: NewEvent<'filed'> = {
            workspaceId: this.deps.workspaceId,
            incidentId,
            type: 'filed',
            v: 1,
            source: 'jira',
            occurredAt: this.deps.clock().toISOString(),
            payload: { jiraKey },
          };
          await tx.append(incidentId, [event], seq);
          await tx.ackOutbox([row.id]);
        });
        return;
      } catch (err) {
        if (!isExpectedSeqConflict(err)) throw err;
      }
    }
    throw new Error(`demo drainer: could not append filed for ${incidentId}`);
  }

  private async fieldIds(): Promise<Map<string, string>> {
    if (this.#fieldIds === undefined) {
      const fields = await jira('GET', '/field');
      const list = Array.isArray(fields) ? fields.map(asRecord) : [];
      this.#fieldIds = new Map(list.map((f) => [str(f['name']), str(f['id'])]));
    }
    return this.#fieldIds;
  }
}
