// What the end to end contract test (#160) adds to the demo Jira world (`JiraWorld`, pnpm demo): the
// agent's own account (`GET /myself`, which the inbound sync compares against), a workflow (Backlog, In
// Progress, Done, with the status categories the projector resolves logical targets by, #268), and the
// issue-updated webhook Jira sends on a
// transition. Deliveries are queued, not sent: the test releases them (`deliver`), as a real webhook
// arrives some time after the transition, so each status row is on screen before the next stage runs.

import { http, HttpResponse, type HttpHandler } from 'msw';
import { JIRA_BASE, type JiraWorld } from '@snapwing/pipeline/demo/msw/jira.ts';

const API = `${JIRA_BASE}/rest/api/3`;
/** The account the agent's API token acts as; its own transitions come back as echoes. */
export const AGENT_ACCOUNT = { accountId: 'snapwing-test-account', displayName: 'Snapwing (test)', emailAddress: 'demo-bot@example.com', active: true };
export const WORKFLOW: readonly { id: string; name: string; category: string }[] = [
  { id: '11', name: 'Backlog', category: 'new' },
  { id: '21', name: 'In Progress', category: 'indeterminate' },
  { id: '31', name: 'Done', category: 'done' },
];
const FIELD_IMPL_PROMPT = 'customfield_10050';

export interface JiraDelivery {
  issueKey: string;
  from: string;
  to: string;
  body: string;
}

export class JiraWebhooks {
  /** Deliveries not yet sent, in transition order. */
  readonly queued: JiraDelivery[] = [];
  /** Every status the fake moved an issue through, as `KEY: from -> to`. */
  readonly transitions: string[] = [];
  #updated = Date.parse('2026-10-02T12:00:00.000Z');

  constructor(private readonly world: JiraWorld) {}

  handlers(): HttpHandler[] {
    return [
      http.get(`${API}/myself`, () => HttpResponse.json(AGENT_ACCOUNT)),
      http.get(`${API}/project/:key/statuses`, () =>
        HttpResponse.json([{ id: '10001', name: 'Bug', statuses: WORKFLOW.map((t) => ({ id: t.id, name: t.name, statusCategory: { key: t.category } })) }]),
      ),
      http.get(`${API}/issue/:key/transitions`, ({ params }) => {
        if (!this.world.issues.has(String(params['key']))) return HttpResponse.json({ errorMessages: ['Issue does not exist'] }, { status: 404 });
        return HttpResponse.json({ transitions: WORKFLOW.map((t) => ({ id: t.id, name: t.name, to: { name: t.name } })) });
      }),
      http.post(`${API}/issue/:key/transitions`, async ({ request, params }) => {
        const issue = this.world.issues.get(String(params['key']));
        const body = (await request.json()) as { transition?: { id?: string } };
        const to = WORKFLOW.find((t) => t.id === body.transition?.id);
        if (issue === undefined || to === undefined) return HttpResponse.json({ errorMessages: ['bad transition'] }, { status: 400 });
        const from = issue.status;
        issue.status = to.name;
        this.transitions.push(`${issue.key}: ${from} -> ${to.name}`);
        this.queued.push({ issueKey: issue.key, from, to: to.name, body: this.payload(issue.key, from, to.name) });
        return new HttpResponse(null, { status: 204 });
      }),
    ];
  }

  /** Sends every queued delivery for `issueKey` to `post`; resolves to the responses' statuses. */
  async deliver(issueKey: string, post: (body: string) => Promise<Response>): Promise<number[]> {
    const mine = this.queued.filter((d) => d.issueKey === issueKey);
    this.queued.splice(0, this.queued.length, ...this.queued.filter((d) => d.issueKey !== issueKey));
    const statuses: number[] = [];
    for (const d of mine) statuses.push((await post(d.body)).status);
    return statuses;
  }

  /** `jira:issue_updated` for a status change by the agent's account, shaped like the recorded one. */
  private payload(issueKey: string, from: string, to: string): string {
    const issue = this.world.issues.get(issueKey);
    this.#updated += 1000;
    const updated = new Date(this.#updated).toISOString().replace('Z', '+0000');
    return JSON.stringify({
      timestamp: this.#updated,
      webhookEvent: 'jira:issue_updated',
      issue_event_type_name: 'issue_generic',
      user: AGENT_ACCOUNT,
      issue: {
        id: String(10000 + [...this.world.issues.keys()].indexOf(issueKey) + 1),
        key: issueKey,
        fields: {
          summary: issue?.summary ?? '',
          updated,
          status: { name: to, id: WORKFLOW.find((t) => t.name === to)?.id ?? '0' },
          labels: issue?.labels ?? [],
          assignee: null,
          [FIELD_IMPL_PROMPT]: issue?.custom['Implementation Prompt'] ?? null,
        },
      },
      changelog: { id: String(this.#updated), items: [{ field: 'status', fieldtype: 'jira', fieldId: 'status', fromString: from, toString: to }] },
    });
  }
}
