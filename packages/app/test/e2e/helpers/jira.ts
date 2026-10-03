// The Jira side of the e2e tier (main 14.4, B 7): the per-run webhook to the tunnel, reading the filed
// issue back, the `[snapwing-test]` summary prefix, and teardown. Basic auth with the API token; the
// token is only ever in a header.
//
// The webhook is registered by `pnpm jira:bootstrap webhook` (`runBootstrap`, the admin webhook API
// with `?secret=`) under a per-run name, and deleted by that name in teardown.

import { PREFIX } from './env.ts';

export type Rec = Record<string, unknown>;

export interface JiraAccess {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class JiraHttpError extends Error {
  override readonly name = 'JiraHttpError';
  constructor(
    readonly method: string,
    readonly path: string,
    readonly status: number,
    detail: string,
  ) {
    super(`jira ${method} ${path}: HTTP ${status}${detail === '' ? '' : ` ${detail}`}`);
  }
}

export function createJiraDriver(access: JiraAccess) {
  const base = access.baseUrl.replace(/\/+$/, '');
  const authorization = `Basic ${Buffer.from(`${access.email}:${access.apiToken}`).toString('base64')}`;

  async function call(method: string, path: string, body?: unknown): Promise<unknown> {
    const res = await fetch(path.startsWith('https://') ? path : `${base}${path}`, {
      method,
      headers: { authorization, accept: 'application/json', ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (!res.ok) {
      let detail = '';
      try {
        const parsed = JSON.parse(text) as Rec;
        detail = [...((parsed['errorMessages'] as string[] | undefined) ?? []), ...Object.values((parsed['errors'] as Rec | undefined) ?? {}).map(String)].join('; ');
      } catch {
        // Not JSON.
      }
      throw new JiraHttpError(method, new URL(path.startsWith('https://') ? path : `${base}${path}`).pathname, res.status, detail.slice(0, 200));
    }
    return text === '' ? {} : (JSON.parse(text) as unknown);
  }

  return {
    async deleteWebhook(self: string): Promise<void> {
      await call('DELETE', self);
    },
    /** Admin webhooks whose name starts with `prefix` (stale ones from a run that died before teardown). */
    async webhooksNamed(prefix: string): Promise<string[]> {
      const list = (await call('GET', '/rest/webhooks/1.0/webhook')) as Rec[];
      return (Array.isArray(list) ? list : []).filter((w) => String(w['name'] ?? '').startsWith(prefix)).map((w) => (typeof w['self'] === 'string' ? w['self'] : `/rest/webhooks/1.0/webhook/${String(w['id'])}`));
    },
    async issue(key: string): Promise<{ key: string; fields: Rec }> {
      return (await call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}`)) as { key: string; fields: Rec };
    },
    /** The issue's comments, oldest first, each body as plain text (`adfText`). */
    async comments(key: string): Promise<{ text: string; created: string }[]> {
      const page = (await call('GET', `/rest/api/3/issue/${encodeURIComponent(key)}/comment?maxResults=100&orderBy=created`)) as Rec;
      const list = (page['comments'] as Rec[] | undefined) ?? [];
      return list.map((c) => ({ text: adfText(c['body']), created: String(c['created'] ?? '') }));
    },
    /** The account the API token belongs to (`GET /myself`). */
    async myself(): Promise<{ accountId: string }> {
      const me = (await call('GET', '/rest/api/3/myself')) as Rec;
      return { accountId: String(me['accountId'] ?? '') };
    },
    /** Keys of issues matching `jql` (first page only; the tier makes a handful). */
    async search(jql: string, fields: string[]): Promise<{ key: string; fields: Rec }[]> {
      const page = (await call('POST', '/rest/api/3/search/jql', { jql, fields, maxResults: 50 })) as Rec;
      return (page['issues'] as { key: string; fields: Rec }[] | undefined) ?? [];
    },
    /**
     * Deletes the issue (already gone is fine). Without the Delete Issues permission (403) it closes the
     * issue to Done instead and resolves 'closed', for the caller to report.
     */
    async deleteIssue(key: string): Promise<'deleted' | 'closed'> {
      try {
        await call('DELETE', `/rest/api/3/issue/${encodeURIComponent(key)}?deleteSubtasks=true`);
        return 'deleted';
      } catch (e) {
        if (e instanceof JiraHttpError && e.status === 404) return 'deleted';
        if (!(e instanceof JiraHttpError && e.status === 403)) throw e;
      }
      const path = `/rest/api/3/issue/${encodeURIComponent(key)}/transitions`;
      const list = ((await call('GET', path)) as { transitions?: { id: string; to?: { name?: string; statusCategory?: { key?: string } } }[] }).transitions ?? [];
      const done = list.find((t) => t.to?.statusCategory?.key === 'done');
      if (done !== undefined) await call('POST', path, { transition: { id: done.id } });
      return 'closed';
    },
  };
}

export type JiraDriver = ReturnType<typeof createJiraDriver>;

/** The text of a Jira value: a string as is, an ADF document as its text nodes joined by newlines. */
export function adfText(value: unknown): string {
  if (typeof value === 'string') return value;
  const out: string[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    const n = node as { text?: unknown; content?: unknown };
    if (typeof n.text === 'string') out.push(n.text);
    if (Array.isArray(n.content)) for (const c of n.content) walk(c);
  };
  walk(value);
  return out.join('\n');
}

/**
 * Test hygiene (main 14.4: "Live and e2e runs prefix every issue summary with `[snapwing-test]`"): the
 * product has no summary prefix, so the harness adds it to the one request that creates an issue,
 * `POST <site>/rest/api/3/issue`, in flight. Nothing else is touched. Returns the wrapped fetch.
 */
export function prefixingFetch(inner: typeof fetch, jiraBaseUrl: string): typeof fetch {
  const createUrl = `${jiraBaseUrl.replace(/\/+$/, '')}/rest/api/3/issue`;
  return async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = (init?.method ?? (input instanceof Request ? input.method : 'GET')).toUpperCase();
    if (method === 'POST' && url === createUrl && typeof init?.body === 'string') {
      try {
        const body = JSON.parse(init.body) as { fields?: Rec };
        const summary = body.fields?.['summary'];
        if (body.fields !== undefined && typeof summary === 'string' && !summary.startsWith(PREFIX)) {
          body.fields['summary'] = `${PREFIX} ${summary}`.slice(0, 255);
          return inner(input, { ...init, body: JSON.stringify(body) });
        }
      } catch {
        // Not JSON: send as is.
      }
    }
    return inner(input, init);
  };
}
