// The GitHub sandbox the onboarding tests run against: an account with no Snapwing App until the
// installer creates one through the manifest flow. `githubOnboardHandlers` are what the GitHub step
// calls (the manifest code exchange, the App's own credentials, the installation and its
// repositories, the webhook config); `githubRepoHandlers` are what the owners step and the triage
// scout read from the repositories (CODEOWNERS raw, any file as JSON, a user's public email).
// `installerBrowser` is the installer's browser: it reads the local page the step opens, clicks
// Create, and follows the install link. The test drive's pull requests are `FakeGitHub`
// (../e2e/github.ts). Every value here is a fake; none looks like a real credential.

import { http, HttpResponse, passthrough, type HttpHandler } from 'msw';

export const GITHUB_API = 'https://api.github.com';

export interface GitHubAccount {
  /** The account the App is installed on, once it is. */
  account: string;
  /** Whether the owner has installed the App. */
  installed: boolean;
  /** Whether opening the install link installs the App (the installer follows it). */
  autoInstall: boolean;
  /** The repositories the installation reaches; the first `emptyListings` listings answer none. */
  repos: string[];
  emptyListings: number;
  /** The `webhook_secret` the conversion returns (GitHub returns none for a manifest App). */
  webhookSecret: string | null;
  slug: string;
  /** The `owner.login` the conversion reports; default: `account`. */
  conversionOwner?: string;
  /** What the conversion hands out besides the slug. */
  app: { id: number; clientId: string; clientSecret: string; pem: string };
  installationId: number;
  /** What `POST /app/installations/:id/access_tokens` hands out. */
  installationToken: string;
  /** Every manifest the local page held, as GitHub would receive it. */
  manifests: Record<string, unknown>[];
  conversions: string[];
  hookConfigs: Record<string, unknown>[];
  /** False once GitHub no longer accepts the App's own credentials. */
  appValid: boolean;
  /** Files by path, per repository (`owner/name`). */
  files: Record<string, Record<string, string>>;
  /** Public emails by login (null: none shown). */
  users: Record<string, string | null>;
}

export function githubAccount(seed: Partial<GitHubAccount> & Pick<GitHubAccount, 'app'>): GitHubAccount {
  return {
    account: 'acme',
    installed: false,
    autoInstall: true,
    repos: ['acme/web'],
    emptyListings: 0,
    webhookSecret: null,
    slug: 'snapwing-acme',
    installationId: 777,
    installationToken: 'ghs_faketoken',
    manifests: [],
    conversions: [],
    hookConfigs: [],
    appValid: true,
    files: {},
    users: {},
    ...seed,
  };
}

/** What the GitHub step calls, and the local page and redirect it serves on 127.0.0.1 (real HTTP). */
export function githubOnboardHandlers(gh: GitHubAccount, api = GITHUB_API): HttpHandler[] {
  return [
    http.all('http://127.0.0.1:*/*', () => passthrough()),
    http.post(`${api}/app-manifests/:code/conversions`, ({ params }) => {
      gh.conversions.push(String(params['code']));
      return HttpResponse.json(
        { id: gh.app.id, slug: gh.slug, client_id: gh.app.clientId, client_secret: gh.app.clientSecret, webhook_secret: gh.webhookSecret, pem: gh.app.pem, owner: { login: gh.conversionOwner ?? gh.account } },
        { status: 201 },
      );
    }),
    http.get(`${api}/app`, ({ request }) =>
      gh.appValid && (request.headers.get('authorization') ?? '').startsWith('Bearer ') ? HttpResponse.json({ slug: gh.slug }) : HttpResponse.json({ message: 'Bad credentials' }, { status: 401 }),
    ),
    http.get(`${api}/app/installations`, () => HttpResponse.json(gh.installed ? [{ id: gh.installationId, account: { login: gh.account } }] : [])),
    http.post(`${api}/app/installations/:id/access_tokens`, () => HttpResponse.json({ token: gh.installationToken, expires_at: new Date(Date.now() + 3_600_000).toISOString() }, { status: 201 })),
    http.get(`${api}/installation/repositories`, () => {
      if (gh.emptyListings > 0) {
        gh.emptyListings -= 1;
        return HttpResponse.json({ total_count: 0, repositories: [] });
      }
      return HttpResponse.json({ total_count: gh.repos.length, repositories: gh.repos.map((full_name) => ({ full_name })) });
    }),
    http.patch(`${api}/app/hook/config`, async ({ request }) => {
      gh.hookConfigs.push((await request.json()) as Record<string, unknown>);
      return HttpResponse.json({});
    }),
  ];
}

/**
 * The repositories' files and their people, read with the installation token: CODEOWNERS raw (the
 * owners step asks for `application/vnd.github.raw+json`), any other read as GitHub's JSON with base64
 * content (the triage scout), and a user's public email.
 */
export function githubRepoHandlers(gh: GitHubAccount, api = GITHUB_API): HttpHandler[] {
  const authorized = (request: Request): boolean => request.headers.get('authorization') === `Bearer ${gh.installationToken}`;
  return [
    http.get(`${api}/repos/:owner/:repo/contents/*`, ({ request, params }) => {
      if (!authorized(request)) return HttpResponse.json({ message: 'Bad credentials' }, { status: 401 });
      const repo = `${String(params['owner'])}/${String(params['repo'])}`;
      const path = decodeURIComponent(new URL(request.url).pathname.split('/contents/')[1] ?? '');
      const text = gh.files[repo]?.[path];
      if (text === undefined) return HttpResponse.json({ message: 'Not Found' }, { status: 404 });
      if ((request.headers.get('accept') ?? '').includes('raw')) return new HttpResponse(text, { headers: { 'content-type': 'text/plain' } });
      return HttpResponse.json({ type: 'file', path, encoding: 'base64', content: Buffer.from(text, 'utf8').toString('base64') });
    }),
    http.get(`${api}/users/:login`, ({ params }) => {
      const login = String(params['login']);
      return login in gh.users ? HttpResponse.json({ login, email: gh.users[login] }) : HttpResponse.json({ message: 'Not Found' }, { status: 404 });
    }),
  ];
}

/** Reads the local page the step opened: where it posts, its state, and the manifest it carries. */
export async function readManifestPage(gh: GitHubAccount, local: string): Promise<{ action: string; state: string; manifest: Record<string, unknown> }> {
  const html = await (await fetch(local)).text();
  const unescape = (s: string): string => s.replaceAll('&quot;', '"').replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');
  const action = unescape(/action="([^"]+)"/.exec(html)?.[1] ?? '');
  const manifest = JSON.parse(unescape(/name="manifest" value="([^"]*)"/.exec(html)?.[1] ?? '{}')) as Record<string, unknown>;
  gh.manifests.push(manifest);
  return { action, state: new URL(action).searchParams.get('state') ?? '', manifest };
}

/** The installer clicks Create on GitHub, and GitHub redirects back to the local page with a one-time code. */
export async function createAppInBrowser(gh: GitHubAccount, local: string, code: string): Promise<void> {
  const { state } = await readManifestPage(gh, local);
  const res = await fetch(`${local}/callback?code=${encodeURIComponent(code)}&state=${state}`);
  if (res.status !== 200) throw new Error(`the manifest redirect answered ${res.status}`);
}

/**
 * The installer's browser for a whole interview: the GitHub step's local page creates the App, the
 * install link installs it, and every other page (Slack's, Microsoft's, Atlassian's) is only looked
 * at. Every URL it was given is in `opened`; anything that went wrong is in `errors`.
 */
export function installerBrowser(gh: GitHubAccount): { openUrl: (url: string) => Promise<void>; opened: string[]; errors: string[] } {
  const opened: string[] = [];
  const errors: string[] = [];
  const openUrl = (url: string): Promise<void> => {
    opened.push(url);
    const run = async (): Promise<void> => {
      if (url.startsWith('http://127.0.0.1:')) await createAppInBrowser(gh, url, `c0de-${String(opened.length)}`);
      else if (gh.autoInstall && /\/apps\/[^/]+\/installations\/new$/.test(url)) gh.installed = true;
    };
    return run().catch((e: unknown) => {
      errors.push(e instanceof Error ? e.message : String(e));
    });
  };
  return { openUrl, opened, errors };
}
