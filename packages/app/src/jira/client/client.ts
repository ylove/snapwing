// Jira Cloud REST v3 client over `fetch` (main 9.1, 14.4; B 7.1). Basic auth with an API token.
// Only the projector calls this (CONTEXT 6, rule 2). Credentials never reach an error or a log.

import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import {
  JiraApiError,
  JiraAuthError,
  JiraNotFoundError,
  JiraRateLimitError,
  JiraTransitionNotFoundError,
  JiraValidationError,
} from './errors.ts';
import type {
  Adf,
  CreateFieldInput,
  JiraAttachment,
  JiraField,
  JiraIssue,
  JiraIssueRef,
  JiraMyself,
  JiraSearchPage,
  JiraTransition,
  UploadAttachmentInput,
  WebhookRegistration,
  WebhookSpec,
} from './types.ts';

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
}

export interface SearchJqlOptions {
  maxResults?: number;
  fields?: string[];
  nextPageToken?: string;
}

export interface JiraClient {
  createIssue(fields: Record<string, unknown>): Promise<JiraIssueRef>;
  getIssue(key: string, opts?: { fields?: string[] }): Promise<JiraIssue>;
  editIssue(key: string, fields: Record<string, unknown>): Promise<void>;
  /** Resolves the transition id by the target status name (or the transition's own name). */
  transitionIssue(key: string, toName: string): Promise<void>;
  addComment(key: string, adf: Adf): Promise<{ id: string }>;
  addLabels(key: string, labels: string[]): Promise<void>;
  uploadAttachment(key: string, file: UploadAttachmentInput): Promise<JiraAttachment[]>;
  searchJql(jql: string, opts?: SearchJqlOptions): Promise<JiraSearchPage>;
  listFields(): Promise<JiraField[]>;
  createField(input: CreateFieldInput): Promise<JiraField>;
  registerWebhook(input: { url: string; webhooks: WebhookSpec[] }): Promise<WebhookRegistration[]>;
  /** The account the credentials act as; inbound sync ignores changes made by it. */
  myself(): Promise<JiraMyself>;
}

/** The secret names of CONTEXT 6b. */
export const JIRA_SECRET_NAMES = { baseUrl: 'JIRA_BASE_URL', email: 'JIRA_EMAIL', apiToken: 'JIRA_API_TOKEN' } as const;

/** Builds a client from the SecretsPort. */
export async function createJiraClientFromSecrets(secrets: SecretsPort, opts: { fetch?: typeof fetch } = {}): Promise<JiraClient> {
  const [baseUrl, email, apiToken] = await Promise.all([
    secrets.get(JIRA_SECRET_NAMES.baseUrl),
    secrets.get(JIRA_SECRET_NAMES.email),
    secrets.get(JIRA_SECRET_NAMES.apiToken),
  ]);
  return createJiraClient({ baseUrl, email, apiToken, ...(opts.fetch ? { fetch: opts.fetch } : {}) });
}

function parseRetryAfterMs(header: string | null): number {
  if (header === null) return 1000;
  const secs = Number(header);
  if (Number.isFinite(secs)) return Math.max(0, Math.round(secs * 1000));
  const at = Date.parse(header);
  return Number.isNaN(at) ? 1000 : Math.max(0, at - Date.now());
}

function asRecord(v: unknown): Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};
}

async function readErrorBody(res: Response): Promise<{ errorMessages: string[]; errors: Record<string, string> }> {
  let body: Record<string, unknown> = {};
  try {
    body = asRecord(await res.json());
  } catch {
    // Not JSON; leave empty.
  }
  const msgs = Array.isArray(body.errorMessages) ? body.errorMessages.filter((m): m is string => typeof m === 'string') : [];
  const errors: Record<string, string> = {};
  for (const [k, v] of Object.entries(asRecord(body.errors))) if (typeof v === 'string') errors[k] = v;
  return { errorMessages: msgs, errors };
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  // Resolve the global lazily so interceptors installed after construction (MSW) still apply.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;

  async function request(
    method: string,
    path: string,
    init: { json?: unknown; form?: FormData; headers?: Record<string, string> } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { Authorization: authorization, Accept: 'application/json', ...init.headers };
    let body: string | FormData | undefined;
    if (init.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(init.json);
    } else if (init.form) {
      body = init.form;
    }
    let res: Response;
    try {
      res = await doFetch(`${base}${path}`, { method, headers, ...(body !== undefined ? { body } : {}) });
    } catch {
      // Network failures: name the call, never echo the request (it holds the Authorization header).
      throw new Error(`jira request failed: ${method} ${path}`);
    }
    if (res.ok) return res;
    const status = res.status;
    if (status === 429) throw new JiraRateLimitError(method, path, parseRetryAfterMs(res.headers.get('Retry-After')));
    if (status === 401 || status === 403) throw new JiraAuthError(status, method, path);
    const { errorMessages, errors } = await readErrorBody(res);
    if (status === 404) throw new JiraNotFoundError(method, path, errorMessages);
    if (status === 400 || status === 422) throw new JiraValidationError(status, method, path, errorMessages, errors);
    throw new JiraApiError(status, method, path);
  }

  async function json<T>(method: string, path: string, init?: { json?: unknown }): Promise<T> {
    const res = await request(method, path, init);
    return (await res.json()) as T;
  }

  const issuePath = (key: string): string => `/rest/api/3/issue/${encodeURIComponent(key)}`;

  return {
    createIssue: (fields) => json<JiraIssueRef>('POST', '/rest/api/3/issue', { json: { fields } }),

    getIssue(key, opts) {
      const q = opts?.fields ? `?fields=${encodeURIComponent(opts.fields.join(','))}` : '';
      return json<JiraIssue>('GET', `${issuePath(key)}${q}`);
    },

    async editIssue(key, fields) {
      await request('PUT', issuePath(key), { json: { fields } });
    },

    async transitionIssue(key, toName) {
      const { transitions } = await json<{ transitions: JiraTransition[] }>('GET', `${issuePath(key)}/transitions`);
      const want = toName.trim().toLowerCase();
      const match = transitions.find((t) => t.to.name.toLowerCase() === want) ?? transitions.find((t) => t.name.toLowerCase() === want);
      if (!match) {
        throw new JiraTransitionNotFoundError(
          key,
          toName,
          transitions.map((t) => t.to.name),
        );
      }
      await request('POST', `${issuePath(key)}/transitions`, { json: { transition: { id: match.id } } });
    },

    addComment: (key, adf) => json<{ id: string }>('POST', `${issuePath(key)}/comment`, { json: { body: adf } }),

    async addLabels(key, labels) {
      await request('PUT', issuePath(key), { json: { update: { labels: labels.map((add) => ({ add })) } } });
    },

    async uploadAttachment(key, file) {
      const form = new FormData();
      const blob = new Blob([file.content as Uint8Array<ArrayBuffer>], file.contentType ? { type: file.contentType } : {});
      form.append('file', blob, file.filename);
      const res = await request('POST', `${issuePath(key)}/attachments`, { form, headers: { 'X-Atlassian-Token': 'no-check' } });
      return (await res.json()) as JiraAttachment[];
    },

    searchJql(jql, opts = {}) {
      return json<JiraSearchPage>('POST', '/rest/api/3/search/jql', {
        json: {
          jql,
          ...(opts.maxResults !== undefined ? { maxResults: opts.maxResults } : {}),
          fields: opts.fields ?? ['summary'],
          ...(opts.nextPageToken ? { nextPageToken: opts.nextPageToken } : {}),
        },
      });
    },

    listFields: () => json<JiraField[]>('GET', '/rest/api/3/field'),

    createField: (input) => json<JiraField>('POST', '/rest/api/3/field', { json: input }),

    async registerWebhook(input) {
      const out = await json<{ webhookRegistrationResult: WebhookRegistration[] }>('POST', '/rest/api/3/webhook', { json: input });
      return out.webhookRegistrationResult;
    },

    myself: () => json<JiraMyself>('GET', '/rest/api/3/myself'),
  };
}
