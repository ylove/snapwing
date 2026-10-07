// Helpers for onboarding step 2 (main 22.2): the site address the installer pastes, the account's
// admin check, the project list, and plain words for what the bootstrap found. Nothing here prints a
// field id, a webhook URL, or a transition name (main 22.3).

/** Said wherever a site address is refused: Snapwing works with Jira Cloud only. */
export const CLOUD_ONLY =
  'Snapwing works with Jira Cloud only, at an address like acme.atlassian.net; Jira Server and Data Center are not supported.';

/** What `checkSiteAddress` makes of a pasted address: the site's base URL, or one line saying why not. */
export type SiteAddress = { readonly ok: true; readonly baseUrl: string } | { readonly ok: false; readonly refusal: string };

/** A Jira Cloud site: one name under atlassian.net. */
const CLOUD_HOST = /^[a-z0-9][a-z0-9-]*\.atlassian\.net$/;

/**
 * Turns what the installer pastes into the site's base URL, `https://<name>.atlassian.net`, from
 * `acme`, `acme.atlassian.net`, or a full address on that host (a path, query, or trailing slash is
 * dropped, so a board or ticket link works). Anything else is refused before a request is sent, so
 * the login never goes to another host: plain http, a lookalike domain, localhost, a port, or a Jira
 * Server or Data Center address (whose context path, such as `/jira`, the refusal names).
 */
export function checkSiteAddress(input: string): SiteAddress {
  const refuse = (refusal: string): SiteAddress => ({ ok: false, refusal });
  let text = input.trim();
  if (text === '') return refuse(`Paste the address you open Jira at. ${CLOUD_ONLY}`);
  // A bare name is the Cloud site of that name.
  if (/^[a-z0-9][a-z0-9-]*$/i.test(text) && text.toLowerCase() !== 'localhost') text = `${text}.atlassian.net`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(text)) text = `https://${text}`;
  let url: URL;
  try {
    url = new URL(text);
  } catch {
    return refuse(`That does not look like a web address. ${CLOUD_ONLY}`);
  }
  const host = url.hostname.toLowerCase();
  if (!CLOUD_HOST.test(host)) {
    const path = url.pathname.replace(/\/+$/, '');
    return refuse(
      path === ''
        ? `That is not a Jira Cloud address. ${CLOUD_ONLY}`
        : `An address with a path such as ${path} is Jira Server or Data Center. ${CLOUD_ONLY}`,
    );
  }
  if (url.protocol !== 'https:') return refuse(`A Jira Cloud address starts with https://. ${CLOUD_ONLY}`);
  if (url.port !== '' || url.username !== '' || url.password !== '') {
    return refuse('Paste just the site address, such as acme.atlassian.net, with no port or sign-in in it.');
  }
  return { ok: true, baseUrl: `https://${host}` };
}

/** A login on a site, as the helpers below take it. */
export interface SiteLogin {
  readonly baseUrl: string;
  readonly email: string;
  readonly apiToken: string;
  /** Injected for tests; defaults to the global `fetch`. */
  readonly fetch?: typeof fetch;
}

const authorizationOf = (login: SiteLogin): string => `Basic ${Buffer.from(`${login.email}:${login.apiToken}`).toString('base64')}`;

const fetchOf = (login: SiteLogin): typeof fetch => login.fetch ?? ((input, init) => fetch(input, init));

const asRecord = (v: unknown): Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/**
 * - `admin`: the account holds Jira's Administer permission.
 * - `not-admin`: it signs in but does not hold it.
 * - `rejected`: Jira refused the login (401 or 403).
 * - `unreachable`: no answer, or one that says nothing about the account.
 */
export type AdminCheck = 'admin' | 'not-admin' | 'rejected' | 'unreachable';

/**
 * Whether the account is a Jira admin (`GET /rest/api/3/mypermissions?permissions=ADMINISTER`). The
 * setup creates custom fields, edits screens, and registers a webhook, which Jira allows only to an
 * account with the Administer permission, so the step checks this before it saves the login.
 */
export async function checkJiraAdmin(login: SiteLogin): Promise<AdminCheck> {
  let res: Response;
  try {
    res = await fetchOf(login)(`${login.baseUrl}/rest/api/3/mypermissions?permissions=ADMINISTER`, {
      headers: { Authorization: authorizationOf(login), Accept: 'application/json' },
    });
  } catch {
    return 'unreachable';
  }
  if (res.status === 401 || res.status === 403) return 'rejected';
  if (!res.ok) return 'unreachable';
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    return 'unreachable';
  }
  const administer = asRecord(asRecord(asRecord(body)['permissions'])['ADMINISTER']);
  return administer['havePermission'] === true ? 'admin' : 'not-admin';
}

export interface SiteProject {
  readonly key: string;
  readonly name: string;
  /** Team-managed (Jira calls it next-gen or simplified): it cannot hold Snapwing's custom fields. */
  readonly teamManaged: boolean;
}

/** Every project the account can see, through `GET /rest/api/3/project/search` (paged). */
export async function listProjects(options: SiteLogin): Promise<SiteProject[]> {
  const doFetch = fetchOf(options);
  const authorization = authorizationOf(options);
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
