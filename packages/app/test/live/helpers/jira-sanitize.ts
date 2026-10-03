// Turns a payload recorded from a real Jira site into one that is safe to commit: account ids, emails, names,
// the site's host, avatar URLs, numeric ids and custom field ids are replaced by obvious fakes, and the
// project key becomes TEST. The shape and key set are kept, so a recording can replace a hand-written fixture.

export interface SanitizeContext {
  /** The site's base URL (`JIRA_BASE_URL`). */
  baseUrl: string;
  projectKey: string;
  /** Values that must never survive (email, token, ...). */
  secrets: readonly string[];
}

export function createJiraSanitizer(ctx: SanitizeContext): (input: unknown) => unknown {
  const host = (() => {
    try {
      return new URL(ctx.baseUrl).host;
    } catch {
      return '';
    }
  })();
  const ids = new Map<string, string>();
  const accounts = new Map<string, string>();
  const customFields = new Map<string, string>();
  const fakeNumeric = (v: string): string => {
    let f = ids.get(v);
    if (f === undefined) {
      f = String(10000 + ids.size);
      ids.set(v, f);
    }
    return f;
  };
  const fakeAccount = (v: string): string => {
    let f = accounts.get(v);
    if (f === undefined) {
      f = `5b10a2844c20165700ede2${String(accounts.size + 1).padStart(2, '0')}`;
      accounts.set(v, f);
    }
    return f;
  };
  const fakeCustomField = (v: string): string => {
    let f = customFields.get(v);
    if (f === undefined) {
      f = `customfield_${String(10050 + customFields.size)}`;
      customFields.set(v, f);
    }
    return f;
  };
  const keyRe = ctx.projectKey === '' ? undefined : new RegExp(`\\b${ctx.projectKey}-(\\d+)\\b`, 'g');

  const text = (value: string): string => {
    let out = value;
    for (const s of ctx.secrets) if (s.length > 3) out = out.split(s).join('fake');
    if (host !== '') out = out.split(host).join('example.atlassian.net');
    if (keyRe !== undefined) out = out.replace(keyRe, 'TEST-$1');
    out = out.replace(/customfield_\d+/g, (m) => fakeCustomField(m));
    // Numeric ids in URLs (`/issue/10042/comment/10050`, `/attachment/10001`) and account ids in queries.
    out = out.replace(/\/(issue|comment|attachment|project|status|webhook)\/(\d{3,})/g, (_, k: string, n: string) => `/${k}/${fakeNumeric(n)}`);
    out = out.replace(/accountId=([0-9a-f:-]{10,})/gi, (_, a: string) => `accountId=${fakeAccount(a)}`);
    return out;
  };

  const walk = (value: unknown, key: string): unknown => {
    if (Array.isArray(value)) return value.map((v) => walk(v, key));
    if (typeof value === 'object' && value !== null) {
      return Object.fromEntries(
        Object.entries(value).map(([k, v]) => {
          if (k === 'avatarUrls') {
            return [k, Object.fromEntries(Object.keys(v as object).map((s) => [s, `https://example.atlassian.net/avatar/${s}.png`]))];
          }
          return [/^customfield_\d+$/.test(k) ? fakeCustomField(k) : k, walk(v, k)];
        }),
      );
    }
    if (typeof value !== 'string') return value;
    if (key === 'accountId') return fakeAccount(value);
    if (key === 'emailAddress') return 'user@example.com';
    if (key === 'displayName') return 'Test User';
    if (key === 'timeZone') return 'Etc/UTC';
    if (key === 'locale') return 'en_US';
    if (key === 'id' && /^\d{4,}$/.test(value)) return fakeNumeric(value);
    return text(value);
  };
  return (input) => walk(input, '');
}

/** Every key path of a JSON value with its type, for diffing a recording's shape against a fixture's. */
export function shapeOf(value: unknown, prefix = ''): string[] {
  if (Array.isArray(value)) return value.length === 0 ? [`${prefix}[]`] : shapeOf(value[0], `${prefix}[]`);
  if (typeof value === 'object' && value !== null) {
    return Object.entries(value).flatMap(([k, v]) => shapeOf(v, prefix === '' ? k : `${prefix}.${k}`));
  }
  return [`${prefix}:${value === null ? 'null' : typeof value}`];
}
