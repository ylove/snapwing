import { readFileSync } from 'node:fs';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { http, HttpResponse, type JsonBodyType } from 'msw';
import { setupServer } from 'msw/node';
import { SecretNotFoundError, type SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import {
  JiraApiError,
  JiraAuthError,
  JiraNotFoundError,
  JiraRateLimitError,
  JiraTransitionNotFoundError,
  JiraValidationError,
  createJiraClient,
  createJiraClientFromSecrets,
  jiraSearch,
  type Adf,
} from '../../src/jira/client/index.ts';

const BASE = 'https://example.atlassian.net';
const EMAIL = 'bot@example.com';
const TOKEN = 'jira-token-test';
const AUTH = `Basic ${Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64')}`;

function fixture(name: string): JsonBodyType {
  return JSON.parse(readFileSync(new URL(`../fixtures/jira/${name}.json`, import.meta.url), 'utf8'));
}

const server = setupServer();
beforeAll(() => server.listen());
afterEach(() => server.resetHandlers());
afterAll(() => server.close());

const client = createJiraClient({ baseUrl: `${BASE}/`, email: EMAIL, apiToken: TOKEN });
const adf: Adf = { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text: 'hello' }] }] };

describe('operations', () => {
  it('createIssue posts fields with basic auth', async () => {
    let seen: { auth: string | null; body: unknown } | undefined;
    server.use(
      http.post(`${BASE}/rest/api/3/issue`, async ({ request }) => {
        seen = { auth: request.headers.get('authorization'), body: await request.json() };
        return HttpResponse.json(fixture('create-issue'), { status: 201 });
      }),
    );
    const ref = await client.createIssue({ summary: 'x', project: { key: 'TEST' } });
    expect(ref.key).toBe('TEST-24');
    expect(seen?.auth).toBe(AUTH);
    expect(seen?.body).toEqual({ fields: { summary: 'x', project: { key: 'TEST' } } });
  });

  it('getIssue reads an issue and passes the field list', async () => {
    let query = '';
    server.use(
      http.get(`${BASE}/rest/api/3/issue/TEST-1`, ({ request }) => {
        query = new URL(request.url).search;
        return HttpResponse.json(fixture('get-issue'));
      }),
    );
    const issue = await client.getIssue('TEST-1', { fields: ['summary', 'labels'] });
    expect(issue.fields.summary).toBe('Cart total is blank after promo code');
    expect(query).toBe('?fields=summary%2Clabels');
  });

  it('editIssue puts fields and accepts 204', async () => {
    let body: unknown;
    server.use(
      http.put(`${BASE}/rest/api/3/issue/TEST-1`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await client.editIssue('TEST-1', { summary: 'new' });
    expect(body).toEqual({ fields: { summary: 'new' } });
  });

  it('transitionIssue resolves the id by target status name, case-insensitively', async () => {
    let body: unknown;
    server.use(
      http.get(`${BASE}/rest/api/3/issue/TEST-1/transitions`, () => HttpResponse.json(fixture('transitions'))),
      http.post(`${BASE}/rest/api/3/issue/TEST-1/transitions`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await client.transitionIssue('TEST-1', 'in progress');
    expect(body).toEqual({ transition: { id: '11' } });
  });

  it('transitionIssue throws JiraTransitionNotFoundError listing the available names', async () => {
    server.use(http.get(`${BASE}/rest/api/3/issue/TEST-1/transitions`, () => HttpResponse.json(fixture('transitions'))));
    const err = await client.transitionIssue('TEST-1', 'Shipped').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraTransitionNotFoundError);
    expect((err as JiraTransitionNotFoundError).available).toEqual(['In Progress', 'Done']);
    expect((err as Error).message).toContain('In Progress, Done');
  });

  it('addComment posts the ADF body', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/rest/api/3/issue/TEST-1/comment`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('add-comment'), { status: 201 });
      }),
    );
    const c = await client.addComment('TEST-1', adf);
    expect(c.id).toBe('10010');
    expect(body).toEqual({ body: adf });
  });

  it('addLabels adds through the update block', async () => {
    let body: unknown;
    server.use(
      http.put(`${BASE}/rest/api/3/issue/TEST-1`, async ({ request }) => {
        body = await request.json();
        return new HttpResponse(null, { status: 204 });
      }),
    );
    await client.addLabels('TEST-1', ['snapwing', 'needs-clarification']);
    expect(body).toEqual({ update: { labels: [{ add: 'snapwing' }, { add: 'needs-clarification' }] } });
  });

  it('uploadAttachment sends multipart with X-Atlassian-Token: no-check', async () => {
    let seen: { token: string | null; type: string | null; name: string; size: number } | undefined;
    server.use(
      http.post(`${BASE}/rest/api/3/issue/TEST-1/attachments`, async ({ request }) => {
        const form = await request.formData();
        const file = form.get('file') as File;
        seen = { token: request.headers.get('x-atlassian-token'), type: request.headers.get('content-type'), name: file.name, size: file.size };
        return HttpResponse.json(fixture('attachments'));
      }),
    );
    const out = await client.uploadAttachment('TEST-1', { filename: 'cart-blank.png', content: new Uint8Array([1, 2, 3]), contentType: 'image/png' });
    expect(out[0]?.filename).toBe('cart-blank.png');
    expect(seen?.token).toBe('no-check');
    expect(seen?.type).toMatch(/^multipart\/form-data; boundary=/);
    expect(seen).toMatchObject({ name: 'cart-blank.png', size: 3 });
  });

  it('searchJql posts to /search/jql', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('search-jql'));
      }),
    );
    const page = await client.searchJql('project = TEST', { maxResults: 2, fields: ['summary'] });
    expect(page.issues.map((i) => i.key)).toEqual(['TEST-1', 'TEST-2']);
    expect(page.nextPageToken).toBe('CAEaAggD');
    expect(body).toEqual({ jql: 'project = TEST', maxResults: 2, fields: ['summary'] });
  });

  it('listFields returns the field list', async () => {
    server.use(http.get(`${BASE}/rest/api/3/field`, () => HttpResponse.json(fixture('fields'))));
    const fields = await client.listFields();
    expect(fields.find((f) => f.name === 'Implementation Prompt')?.id).toBe('customfield_10000');
  });

  it('createField posts the definition', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/rest/api/3/field`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('create-field'), { status: 201 });
      }),
    );
    const input = { name: 'Conversation Link', type: 'com.atlassian.jira.plugin.system.customfieldtypes:url' };
    const f = await client.createField(input);
    expect(f.id).toBe('customfield_10001');
    expect(body).toEqual(input);
  });

  it('registerWebhook returns per-webhook results', async () => {
    let body: unknown;
    server.use(
      http.post(`${BASE}/rest/api/3/webhook`, async ({ request }) => {
        body = await request.json();
        return HttpResponse.json(fixture('register-webhook'), { status: 202 });
      }),
    );
    const input = { url: 'https://snapwing.example.com/hooks/jira', webhooks: [{ jqlFilter: 'project = TEST', events: ['jira:issue_updated'] }] };
    const out = await client.registerWebhook(input);
    expect(out[0]?.createdWebhookId).toBe(1000);
    expect(out[1]?.errors).toHaveLength(1);
    expect(body).toEqual(input);
  });

  it('myself returns the account id', async () => {
    server.use(http.get(`${BASE}/rest/api/3/myself`, () => HttpResponse.json(fixture('myself'))));
    expect((await client.myself()).accountId).toBe('5b10a2844c20165700ede21g');
  });
});

describe('typed errors', () => {
  it('JiraRateLimitError carries retryAfterMs from Retry-After', async () => {
    server.use(http.get(`${BASE}/rest/api/3/myself`, () => new HttpResponse(null, { status: 429, headers: { 'Retry-After': '7' } })));
    const err = await client.myself().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraRateLimitError);
    expect((err as JiraRateLimitError).retryAfterMs).toBe(7000);
  });

  it.each([401, 403])('JiraAuthError on %i', async (status) => {
    server.use(http.get(`${BASE}/rest/api/3/myself`, () => new HttpResponse(null, { status })));
    const err = await client.myself().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraAuthError);
    expect((err as JiraAuthError).status).toBe(status);
  });

  it('JiraNotFoundError on 404', async () => {
    server.use(http.get(`${BASE}/rest/api/3/issue/NOPE-1`, () => HttpResponse.json(fixture('error-not-found'), { status: 404 })));
    const err = await client.getIssue('NOPE-1').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraNotFoundError);
    expect((err as JiraNotFoundError).errorMessages).toEqual(['Issue does not exist or you do not have permission to see it.']);
  });

  it('JiraValidationError carries errorMessages and errors on 400', async () => {
    server.use(http.post(`${BASE}/rest/api/3/issue`, () => HttpResponse.json(fixture('error-validation'), { status: 400 })));
    const err = await client.createIssue({}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(JiraValidationError);
    expect((err as JiraValidationError).errorMessages).toEqual(['Issue type is required.']);
    expect((err as JiraValidationError).errors).toEqual({ summary: 'You must specify a summary of the issue.' });
  });

  it('other statuses become JiraApiError', async () => {
    server.use(http.get(`${BASE}/rest/api/3/myself`, () => new HttpResponse(null, { status: 503 })));
    await expect(client.myself()).rejects.toBeInstanceOf(JiraApiError);
  });

  it('never puts the token or the Authorization header in an error', async () => {
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, () => new HttpResponse(null, { status: 401 })),
      http.post(`${BASE}/rest/api/3/issue`, () => HttpResponse.json(fixture('error-validation'), { status: 400 })),
    );
    const failing = createJiraClient({
      baseUrl: BASE,
      email: EMAIL,
      apiToken: TOKEN,
      fetch: () => Promise.reject(new Error(`boom ${AUTH}`)),
    });
    const errors = [
      await client.myself().catch((e: unknown) => e),
      await client.createIssue({}).catch((e: unknown) => e),
      await failing.myself().catch((e: unknown) => e),
    ];
    for (const e of errors) {
      const text = JSON.stringify(e, Object.getOwnPropertyNames(e));
      expect(text).not.toContain(TOKEN);
      expect(text).not.toContain(AUTH);
      expect(text).not.toContain(Buffer.from(`${EMAIL}:${TOKEN}`).toString('base64'));
    }
  });
});

describe('credentials from the SecretsPort', () => {
  const secrets = (values: Record<string, string>): SecretsPort => ({
    get(name) {
      const v = values[name];
      return v === undefined ? Promise.reject(new SecretNotFoundError(name, 'test')) : Promise.resolve(v);
    },
  });

  it('reads JIRA_BASE_URL, JIRA_EMAIL, JIRA_API_TOKEN', async () => {
    let auth: string | null = null;
    server.use(
      http.get(`${BASE}/rest/api/3/myself`, ({ request }) => {
        auth = request.headers.get('authorization');
        return HttpResponse.json(fixture('myself'));
      }),
    );
    const c = await createJiraClientFromSecrets(secrets({ JIRA_BASE_URL: BASE, JIRA_EMAIL: EMAIL, JIRA_API_TOKEN: TOKEN }));
    await c.myself();
    expect(auth).toBe(AUTH);
  });

  it('rejects with SecretNotFoundError when one is missing', async () => {
    await expect(createJiraClientFromSecrets(secrets({ JIRA_BASE_URL: BASE }))).rejects.toBeInstanceOf(SecretNotFoundError);
  });
});

describe('jiraSearch', () => {
  it('maps hits and follows nextPageToken up to the limit', async () => {
    const bodies: Array<Record<string, unknown>> = [];
    server.use(
      http.post(`${BASE}/rest/api/3/search/jql`, async ({ request }) => {
        const body = (await request.json()) as Record<string, unknown>;
        bodies.push(body);
        return HttpResponse.json(fixture(body.nextPageToken ? 'search-jql-page2' : 'search-jql'));
      }),
    );
    const hits = await jiraSearch(client).search('project = TEST', 10);
    expect(hits).toEqual([
      { key: 'TEST-1', summary: 'Cart total is blank after promo code', assignee: 'Mia Krystof' },
      { key: 'TEST-2', summary: 'Checkout button unresponsive' },
      { key: 'TEST-3', summary: 'Promo code field rejects lowercase' },
    ]);
    expect(bodies[0]).toMatchObject({ jql: 'project = TEST', maxResults: 10, fields: ['summary', 'assignee'] });
    expect(bodies[1]).toMatchObject({ nextPageToken: 'CAEaAggD', maxResults: 8 });
  });

  it('stops at the limit', async () => {
    server.use(http.post(`${BASE}/rest/api/3/search/jql`, () => HttpResponse.json(fixture('search-jql'))));
    const hits = await jiraSearch(client).search('project = TEST', 1);
    expect(hits.map((h) => h.key)).toEqual(['TEST-1']);
  });
});
