// The Jira sandbox the onboarding tests run against: a Jira Cloud site with no Snapwing fields until
// the Jira step creates them. `jiraOnboardHandlers` are what the Jira step and its bootstrap call (the
// login and the admin check, the projects, the fields and screens, the workflow, the webhook), and
// what the products and owners steps read back (a project with its components). The issues the test
// drive files are `JiraWorld` and `JiraWebhooks` (the demo world and ../e2e/jira.ts). Every value here
// is a fake; none looks like a real credential.

import { http, HttpResponse, type HttpHandler } from 'msw';

export interface JiraSiteField {
  id: string;
  name: string;
  custom: boolean;
  schema?: { type: string; custom: string };
}

export interface JiraSite {
  /** The logins the site accepts, by email. */
  logins: Record<string, { token: string; admin: boolean }>;
  projects: { key: string; name: string; style?: string }[];
  /** `GET /project/:key` style, when it differs from the list (the list is a hint). */
  detailStyle: Record<string, string>;
  /** `GET /project/:key` components, by project key. */
  components: Record<string, unknown[]>;
  fields: JiraSiteField[];
  screens: { id: number; name: string }[];
  screenFields: Record<number, string[]>;
  statuses: { name: string; category: string }[];
  /** An error status `GET /project/:key/statuses` answers with, when set. */
  statusesStatus?: number;
  /** An error status `POST /field` answers with, when set. */
  createFieldStatus?: number;
  webhooks: { id: number; name: string; url: string }[];
  /** Every write, as `create-field <name>`, `add-to-screen <id>`, or `register-webhook`. */
  calls: string[];
  nextFieldId: number;
  /** Who `/myself` says an accepted login is. */
  account: Record<string, unknown>;
}

export function jiraSite(seed: Partial<JiraSite> & Pick<JiraSite, 'logins' | 'projects'>): JiraSite {
  return {
    detailStyle: {},
    components: {},
    fields: [{ id: 'summary', name: 'Summary', custom: false }],
    screens: [{ id: 1, name: 'OAJ: Scrum Default Issue Screen' }],
    screenFields: { 1: ['summary'] },
    statuses: [
      { name: 'To Do', category: 'new' },
      { name: 'In Progress', category: 'indeterminate' },
      { name: 'Done', category: 'done' },
    ],
    webhooks: [],
    calls: [],
    nextFieldId: 10042,
    account: { accountId: 'a1', displayName: 'Owner' },
    ...seed,
  };
}

/** The Basic login a request carries. */
export function loginOf(request: Request): { email: string; token: string } | undefined {
  const m = /^Basic (.+)$/.exec(request.headers.get('authorization') ?? '');
  if (m?.[1] === undefined) return undefined;
  const text = Buffer.from(m[1], 'base64').toString('utf8');
  const at = text.indexOf(':');
  return at === -1 ? undefined : { email: text.slice(0, at), token: text.slice(at + 1) };
}

/** What the Jira step, its bootstrap, and the steps after it call on the site at `base`. */
export function jiraOnboardHandlers(base: string, jira: JiraSite): HttpHandler[] {
  const accepted = (request: Request): { email: string; admin: boolean } | undefined => {
    const login = loginOf(request);
    const known = login === undefined ? undefined : jira.logins[login.email];
    return login !== undefined && known?.token === login.token ? { email: login.email, admin: known.admin } : undefined;
  };
  const log = (s: string): void => void jira.calls.push(s);
  return [
    http.get(`${base}/rest/api/3/myself`, ({ request }) => (accepted(request) ? HttpResponse.json(jira.account) : new HttpResponse(null, { status: 401 }))),
    http.get(`${base}/rest/api/3/mypermissions`, ({ request }) => {
      const login = accepted(request);
      if (login === undefined) return new HttpResponse(null, { status: 401 });
      return HttpResponse.json({ permissions: { ADMINISTER: { id: '0', key: 'ADMINISTER', type: 'GLOBAL', havePermission: login.admin } } });
    }),
    http.get(`${base}/rest/api/3/project/search`, () => HttpResponse.json({ isLast: true, values: jira.projects })),
    http.get(`${base}/rest/api/3/project/:key/statuses`, () =>
      jira.statusesStatus !== undefined
        ? new HttpResponse(null, { status: jira.statusesStatus })
        : HttpResponse.json([
            { id: '1', name: 'Task', statuses: jira.statuses.map((s, i) => ({ id: String(10100 + i), name: s.name, statusCategory: { id: i, key: s.category } })) },
          ]),
    ),
    http.get(`${base}/rest/api/3/project/:key`, ({ params }) => {
      const key = String(params['key']);
      const p = jira.projects.find((q) => q.key === key);
      if (!p) return new HttpResponse(null, { status: 404 });
      const style = jira.detailStyle[key] ?? p.style ?? 'classic';
      return HttpResponse.json({ id: '10100', key, name: p.name, style, simplified: style === 'next-gen', components: jira.components[key] ?? [] });
    }),
    http.get(`${base}/rest/api/3/field`, () => HttpResponse.json(jira.fields)),
    http.post(`${base}/rest/api/3/field`, async ({ request }) => {
      if (jira.createFieldStatus !== undefined) return new HttpResponse(null, { status: jira.createFieldStatus });
      const body = (await request.json()) as { name: string; type: string };
      log(`create-field ${body.name}`);
      const f = { id: `customfield_${jira.nextFieldId++}`, name: body.name, custom: true, schema: { type: 'x', custom: body.type } };
      jira.fields.push(f);
      return HttpResponse.json(f);
    }),
    http.get(`${base}/rest/api/3/screens`, () => HttpResponse.json({ isLast: true, values: jira.screens })),
    http.get(`${base}/rest/api/3/screens/:id/tabs`, () => HttpResponse.json([{ id: 100, name: 'Field Tab' }])),
    http.get(`${base}/rest/api/3/screens/:id/tabs/:tab/fields`, ({ params }) =>
      HttpResponse.json((jira.screenFields[Number(params['id'])] ?? []).map((id) => ({ id }))),
    ),
    http.post(`${base}/rest/api/3/screens/:id/tabs/:tab/fields`, async ({ params, request }) => {
      const { fieldId } = (await request.json()) as { fieldId: string };
      log(`add-to-screen ${fieldId}`);
      jira.screenFields[Number(params['id'])]?.push(fieldId);
      return HttpResponse.json({ id: fieldId });
    }),
    http.get(`${base}/rest/webhooks/1.0/webhook`, () => HttpResponse.json(jira.webhooks)),
    http.post(`${base}/rest/webhooks/1.0/webhook`, async ({ request }) => {
      const body = (await request.json()) as { name: string; url: string };
      log('register-webhook');
      jira.webhooks.push({ id: jira.webhooks.length + 1, name: body.name, url: body.url });
      return HttpResponse.json({ ...body, enabled: true }, { status: 201 });
    }),
  ];
}
