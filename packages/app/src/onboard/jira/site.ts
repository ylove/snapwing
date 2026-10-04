// Helpers for onboarding step 2 (main 22.2): the site address the installer pastes, the project list,
// and plain words for what the bootstrap found. Nothing here prints a field id, a webhook URL, or a
// transition name (main 22.3).

/**
 * Turns what the installer pastes into the site's base URL: `acme`, `acme.atlassian.net`, or a full
 * address (a path, query, or trailing slash is dropped). Undefined when it is not a usable address.
 */
export function normalizeSiteAddress(input: string): string | undefined {
  let text = input.trim();
  if (text === '') return undefined;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return undefined;
  }
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && /^(localhost|127\.0\.0\.1)$/.test(url.hostname))) return undefined;
  let host = url.host;
  if (!host.includes('.') && !/^localhost(:\d+)?$/.test(host)) host = `${host}.atlassian.net`;
  if (!/^[a-z0-9.-]+(:\d+)?$/i.test(host)) return undefined;
  return `${url.protocol}//${host.toLowerCase()}`;
}

export interface SiteProject {
  readonly key: string;
  readonly name: string;
  /** Team-managed (Jira calls it next-gen or simplified): it cannot hold Snapwing's custom fields. */
  readonly teamManaged: boolean;
}

/** Every project the account can see, through `GET /rest/api/3/project/search` (paged). */
export async function listProjects(options: {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  readonly fetch?: typeof fetch;
}): Promise<SiteProject[]> {
  const doFetch: typeof fetch = options.fetch ?? ((input, init) => fetch(input, init));
  const authorization = `Basic ${Buffer.from(`${options.email}:${options.apiToken}`).toString('base64')}`;
  const out: SiteProject[] = [];
  for (let startAt = 0; ; ) {
    let res: Response;
    try {
      res = await doFetch(`${options.baseUrl}/rest/api/3/project/search?maxResults=50&startAt=${startAt}&orderBy=key`, {
        headers: { Authorization: authorization, Accept: 'application/json' },
      });
    } catch {
      throw new Error('could not reach Jira to list the projects');
    }
    if (!res.ok) throw new Error(`Jira would not list the projects (HTTP ${res.status})`);
    const page: unknown = await res.json();
    const record = typeof page === 'object' && page !== null ? (page as Record<string, unknown>) : {};
    const values = Array.isArray(record['values']) ? (record['values'] as unknown[]) : [];
    for (const v of values) {
      const p = typeof v === 'object' && v !== null ? (v as Record<string, unknown>) : {};
      if (typeof p['key'] !== 'string') continue;
      out.push({
        key: p['key'],
        name: typeof p['name'] === 'string' ? p['name'] : p['key'],
        teamManaged: p['style'] === 'next-gen' || p['simplified'] === true,
      });
    }
    startAt += values.length;
    if (record['isLast'] === true || values.length === 0) break;
  }
  return out;
}

const CATEGORY_WORDS: Readonly<Record<string, string>> = {
  new: 'To Do',
  indeterminate: 'In Progress',
  done: 'Done',
};

/**
 * Plain words for the status problems the workflow check found: which status category the project
 * lacks ("a status in the Done category"), never a transition name.
 */
export function describeStatusProblems(problems: readonly string[]): string {
  const missing = new Set<string>();
  let other = false;
  for (const problem of problems) {
    const m = /no status in category (\w+)/.exec(problem);
    const word = m?.[1] === undefined ? undefined : CATEGORY_WORDS[m[1]];
    if (word === undefined) other = true;
    else missing.add(word);
  }
  const parts = [...missing].map((w) => `the ${w} category`);
  if (other) parts.push('a status the config names');
  return parts.length === 0 ? 'a status' : parts.join(' and ');
}
