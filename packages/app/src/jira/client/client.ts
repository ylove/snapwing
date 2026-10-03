// Jira Cloud REST v3 client over `fetch` (main 9.1, 14.4; B 7.1). Basic auth with an API token.
// Only the projector calls this (CONTEXT 6, rule 2). Credentials never reach an error or a log.

import type { JiraProjectStatus, JiraStatusCategory } from '@snapwing/pipeline/jira/statuses.ts';
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
  JiraProject,
  JiraSearchPage,
  JiraUser,
  JiraTransition,
  UploadAttachmentInput,
} from './types.ts';

export interface JiraClientOptions {
  baseUrl: string;
  email: string;
  apiToken: string;
  /** Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Where the client notes a degraded write (a transition resolution Jira would not take). Defaults to `console.warn`. */
  log?: (message: string) => void;
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
  /**
   * Resolves the transition id by the target status name (or the transition's own name). With a
   * `resolution` (a resolution name such as "Won't Do") it is sent as `fields.resolution`. A site
   * whose transition screen lacks the Resolution field answers 400; the transition is then sent
   * plain, the fallback is logged, and a comment records the resolution that could not be set.
   */
  transitionIssue(key: string, toName: string, resolution?: string): Promise<void>;
  addComment(key: string, adf: Adf): Promise<{ id: string }>;
  addLabels(key: string, labels: string[]): Promise<void>;
  uploadAttachment(key: string, file: UploadAttachmentInput): Promise<JiraAttachment[]>;
  searchJql(jql: string, opts?: SearchJqlOptions): Promise<JiraSearchPage>;
  listFields(): Promise<JiraField[]>;
  createField(input: CreateFieldInput): Promise<JiraField>;
  /** The account the credentials act as; inbound sync ignores changes made by it. */
  myself(): Promise<JiraMyself>;
  getProject(key: string): Promise<JiraProject>;
  /**
   * The active person whose email is `email` (`GET /user/search?query=`), or undefined. A match needs
   * the same `emailAddress` (case-insensitive); when privacy settings hide every result's email, a
   * single active person is taken, since the query was the email itself. Apps and inactive accounts
   * never match. Jira assigns by `accountId`, so this is how an email becomes an assignee.
   */
  findUserByEmail(email: string): Promise<JiraUser | undefined>;
  /**
   * The project's workflow statuses with their categories (`GET /project/{key}/statuses`), across
   * its issue types, each name once, in Jira's order. Logical targets resolve against these (#268).
   */
  projectStatuses(key: string): Promise<JiraProjectStatus[]>;
}

const CATEGORIES: readonly JiraStatusCategory[] = ['new', 'indeterminate', 'done', 'undefined'];

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

function plainAdf(text: string): Adf {
  return { type: 'doc', version: 1, content: [{ type: 'paragraph', content: [{ type: 'text', text }] }] };
}

export function createJiraClient(options: JiraClientOptions): JiraClient {
  const base = options.baseUrl.replace(/\/+$/, '');
  // Resolve the global lazily so interceptors installed after construction (MSW) still apply.
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const log = options.log ?? ((message: string): void => console.warn(message));
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

    async transitionIssue(key, toName, resolution) {
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
      const path = `${issuePath(key)}/transitions`;
      if (resolution === undefined) {
        await request('POST', path, { json: { transition: { id: match.id } } });
        return;
      }
      try {
        await request('POST', path, { json: { transition: { id: match.id }, fields: { resolution: { name: resolution } } } });
      } catch (err) {
        if (!(err instanceof JiraValidationError)) throw err;
        // The transition screen has no Resolution field (or Jira will not take this value).
        log(`jira transition of ${key} to ${match.to.name} refused resolution "${resolution}" (${err.status}); sent without it`);
        await request('POST', path, { json: { transition: { id: match.id } } });
        await request('POST', `${issuePath(key)}/comment`, {
          json: { body: plainAdf(`Snapwing moved this issue to ${match.to.name} but could not set the resolution "${resolution}": the workflow's transition screen does not accept it. Set the resolution by hand if it matters.`) },
        });
      }
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

    myself: () => json<JiraMyself>('GET', '/rest/api/3/myself'),

    getProject: (key) => json<JiraProject>('GET', `/rest/api/3/project/${encodeURIComponent(key)}`),

    async findUserByEmail(email) {
      const wanted = email.trim().toLowerCase();
      if (wanted === '') return undefined;
      const found = await json<unknown>('GET', `/rest/api/3/user/search?query=${encodeURIComponent(email.trim())}`);
      const people = (Array.isArray(found) ? found.map(asRecord) : []).flatMap((u): JiraUser[] => {
        const accountId = u['accountId'];
        if (typeof accountId !== 'string' || accountId === '') return [];
        if (u['active'] === false) return [];
        if (u['accountType'] !== undefined && u['accountType'] !== 'atlassian') return [];
        return [
          {
            accountId,
            ...(typeof u['displayName'] === 'string' ? { displayName: u['displayName'] } : {}),
            ...(typeof u['emailAddress'] === 'string' && u['emailAddress'] !== '' ? { emailAddress: u['emailAddress'] } : {}),
          },
        ];
      });
      const exact = people.find((u) => u.emailAddress?.toLowerCase() === wanted);
      if (exact !== undefined) return exact;
      const hidden = people.filter((u) => u.emailAddress === undefined);
      return people.length === 1 && hidden.length === 1 ? hidden[0] : undefined;
    },

    async projectStatuses(key) {
      const types = await json<unknown>('GET', `/rest/api/3/project/${encodeURIComponent(key)}/statuses`);
      const out: JiraProjectStatus[] = [];
      const seen = new Set<string>();
      for (const type of Array.isArray(types) ? types.map(asRecord) : []) {
        for (const status of Array.isArray(type['statuses']) ? type['statuses'].map(asRecord) : []) {
          const name = status['name'];
          if (typeof name !== 'string' || seen.has(name.toLowerCase())) continue;
          seen.add(name.toLowerCase());
          const category = CATEGORIES.find((c) => c === asRecord(status['statusCategory'])['key']) ?? 'undefined';
          out.push({ name, category });
        }
      }
      return out;
    },
  };
}
