// GitHub bootstrap (main 14.4, 18; issue #146). Subcommands, in the order the owner runs them (issue #3):
//   pnpm github:bootstrap fixture   create or reset the fixture repository and its branch protection (needs `gh` with repo and workflow scopes)
//   pnpm github:bootstrap app       create the Snapwing GitHub App through GitHub's manifest flow; prints the install link for the fixture repo
//   (open the printed install link and install the App on the fixture repo only)
//   pnpm github:bootstrap verify    find the installation, record GITHUB_INSTALLATION_ID and GITHUB_APP_SLUG, check everything
//   pnpm github:bootstrap secrets   copy the GitHub values from .env.live into repository secrets (GH_ names) on ylove/snapwing
//   pnpm github:bootstrap webhook   later, once SNAPWING_PUBLIC_URL exists: point the App's webhook at it
//   pnpm github:bootstrap destroy --yes   when the build is done: delete the fixture repository (needs the delete_repo scope; the App stays)
// Branch protection needs a public repository on GitHub Free; `fixture` never changes visibility. If GitHub answers 403, `fixture`
// prints a FAIL line with the `gh repo edit ... --visibility public` command for the owner to run, and a re-run resets and protects.
// `app` works without SNAPWING_PUBLIC_URL: the App is then created with an inactive placeholder webhook (example.invalid) and no callback URL; `webhook` sets the real URL and secret.
// Flags: --repo owner/name (fixture repo for app, fixture, verify; target repo for secrets), --org <org> (app only),
// --port <n> (app only), --no-open (app only).
//
// Every network and process dependency is injected (BootstrapDeps), so the contract tests drive each command against
// MSW and a fake `gh`. A secret value is never logged and never put on a command line; `gh secret set` reads it
// from stdin. Do not run this against real GitHub from a test.

import { execFile, spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { GitHubApiError, errorMessage, signAppJwt } from '../packages/app/src/github/auth.ts';
import { createEnvFileSecrets } from '../packages/pipeline/src/providers/local/secrets.ts';
import { SecretNotFoundError } from '../packages/pipeline/src/ports/secrets.ts';

export const DEFAULT_FIXTURE_REPO = 'ylove/snapwing-fixture-web';
export const DEFAULT_SNAPWING_REPO = 'ylove/snapwing';
export const REQUIRED_CHECK = 'snapwing/review';
export const ENV_FILE = '.env.live';
export const PEM_FILE = 'secrets/github-app.pem';
/** Inactive webhook URL sent when SNAPWING_PUBLIC_URL is unset; `webhook` replaces it. */
export const PLACEHOLDER_HOOK_URL = 'https://example.invalid/snapwing/webhooks/github';
/** Repository secret names (build/CONTEXT.md 6b): GitHub forbids a `GITHUB_` prefix on them. */
export const SECRET_MAP: Readonly<Record<string, string>> = {
  GITHUB_APP_ID: 'GH_APP_ID',
  GITHUB_APP_PRIVATE_KEY: 'GH_APP_PRIVATE_KEY',
  GITHUB_INSTALLATION_ID: 'GH_INSTALLATION_ID',
  GITHUB_WEBHOOK_SECRET: 'GH_WEBHOOK_SECRET',
  GITHUB_APP_SLUG: 'GH_APP_SLUG',
};

const FIXTURE_DIR = 'fixtures/snapwing-fixture-web';
const MANIFEST_FILE = 'manifests/github-app.json';
const SEED_DATE = '2026-01-01T00:00:00Z';

export interface BootstrapDeps {
  fetch: typeof fetch;
  /** Runs `gh` with `args`, writing `input` to its stdin when given. Resolves with stdout; rejects on a non-zero exit. */
  gh(args: readonly string[], input?: string): Promise<string>;
  /** The snapwing repository root: `.env.live`, `secrets/`, `manifests/`, and `fixtures/` live under it. */
  root: string;
  /** Environment fallback for `SNAPWING_PUBLIC_URL`. */
  env: Readonly<Record<string, string | undefined>>;
  log(line: string): void;
  openUrl(url: string): void;
  now(): Date;
  apiBase?: string;
  /** Where the manifest form posts. Default `https://github.com`. */
  webBase?: string;
}

const apiBase = (d: BootstrapDeps): string => (d.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
const webBase = (d: BootstrapDeps): string => (d.webBase ?? 'https://github.com').replace(/\/+$/, '');

// ---------------------------------------------------------------------------------------------------------------------
// .env.live editing

function needsQuotes(value: string): boolean {
  return !/^[A-Za-z0-9_./:@+=,-]*$/.test(value);
}

function formatEnvValue(value: string): string {
  if (!needsQuotes(value)) return value;
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/** End offset (exclusive, past the line's newline) of the definition that starts at `start`. */
function definitionEnd(text: string, start: number, valueStart: number): number {
  let i = valueStart;
  while (text[i] === ' ' || text[i] === '\t') i += 1;
  if (text[i] === '"') {
    i += 1;
    while (i < text.length && text[i] !== '"') i += text[i] === '\\' ? 2 : 1;
    i += 1;
  }
  const eol = text.indexOf('\n', Math.max(i, start));
  return eol === -1 ? text.length : eol + 1;
}

/**
 * Sets `entries` in `.env`-dialect `text`, keeping every other line. A key already present is replaced in place (its
 * later duplicates dropped); a new key is appended. Multi-line double-quoted values (a PEM) are replaced whole.
 */
export function upsertEnv(text: string, entries: Readonly<Record<string, string>>): string {
  let out = text.replace(/\r\n?/g, '\n');
  for (const [key, value] of Object.entries(entries)) {
    const rendered = `${key}=${formatEnvValue(value)}\n`;
    const re = new RegExp(`^(?:export\\s+)?${key}\\s*=`, 'gm');
    let result = '';
    let cursor = 0;
    let replaced = false;
    for (let m = re.exec(out); m !== null; m = re.exec(out)) {
      const end = definitionEnd(out, m.index, m.index + m[0].length);
      result += out.slice(cursor, m.index) + (replaced ? '' : rendered);
      replaced = true;
      cursor = end;
      re.lastIndex = end;
    }
    result += out.slice(cursor);
    if (!replaced) result = (result === '' || result.endsWith('\n') ? result : `${result}\n`) + rendered;
    out = result;
  }
  return out;
}

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

async function updateEnvFile(d: BootstrapDeps, entries: Readonly<Record<string, string>>): Promise<void> {
  const path = join(d.root, ENV_FILE);
  await writeFile(path, upsertEnv(await readIfExists(path), entries), { mode: 0o600 });
}

function envSecrets(d: BootstrapDeps): ReturnType<typeof createEnvFileSecrets> {
  return createEnvFileSecrets({ path: join(d.root, ENV_FILE), fallbackEnv: {} });
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub REST

interface ApiResult {
  status: number;
  body: unknown;
}

async function call(d: BootstrapDeps, bearer: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
  const res = await d.fetch(`${apiBase(d)}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${bearer}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (res.status === 204) return { status: 204, body: null };
  if (!res.ok) return { status: res.status, body: { message: await errorMessage(res) } };
  const text = await res.text();
  return { status: res.status, body: text === '' ? null : (JSON.parse(text) as unknown) };
}

/** Like `call` but throws `GitHubApiError` unless the status is 2xx or in `allow`. */
async function must(d: BootstrapDeps, bearer: string, method: string, path: string, body?: unknown, allow: readonly number[] = []): Promise<ApiResult> {
  const r = await call(d, bearer, method, path, body);
  if ((r.status < 200 || r.status > 299) && !allow.includes(r.status)) throw new GitHubApiError(r.status, `${method} ${path}: ${messageOf(r.body)}`);
  return r;
}

function messageOf(body: unknown): string {
  return isRecord(body) && typeof body['message'] === 'string' ? body['message'] : 'request failed';
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`GitHub response had no ${what}`);
  return v;
}

function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) throw new Error(`repo must be "owner/name", got "${repo}"`);
  return { owner, name };
}

async function ghToken(d: BootstrapDeps): Promise<string> {
  const token = (await d.gh(['auth', 'token'])).trim();
  if (token === '') throw new Error('gh has no login: run `gh auth login` first');
  return token;
}

// ---------------------------------------------------------------------------------------------------------------------
// app: the manifest flow

export interface AppOptions {
  /** Create the App under this organization instead of the signed-in user. */
  org?: string;
  /** Local port for the redirect page; default: any free port. */
  port?: number;
  fixtureRepo?: string;
  /** Give up waiting for the redirect after this many ms. Default 10 minutes. */
  timeoutMs?: number;
}

export interface AppResult {
  appId: string;
  slug: string;
  installUrl: string;
}

function substitute(value: unknown, vars: Readonly<Record<string, string>>): unknown {
  if (typeof value === 'string') return value.replace(/\$\{([A-Z_]+)\}/g, (_m, name: string) => vars[name] ?? '');
  if (Array.isArray(value)) return value.map((v) => substitute(v, vars));
  if (isRecord(value)) return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, substitute(v, vars)]));
  return value;
}

function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function renderPage(action: string, manifest: unknown): string {
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Create the Snapwing GitHub App</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 36rem; margin: 4rem auto;">
<h1>Create the Snapwing GitHub App</h1>
<p>GitHub shows every permission the manifest sets. Accept the defaults and click Create on GitHub.</p>
<form method="post" action="${escapeHtml(action)}">
<input type="hidden" name="manifest" value="${escapeHtml(JSON.stringify(manifest))}">
<button type="submit" style="font-size: 1.1rem; padding: 0.6rem 1.2rem;">Create GitHub App</button>
</form></body></html>`;
}

interface Conversion {
  id: string;
  slug: string;
  clientId: string;
  clientSecret: string;
  /** GitHub returns none when the manifest had no hook_attributes. */
  webhookSecret: string | null;
  pem: string;
}

function parseConversion(body: unknown): Conversion {
  if (!isRecord(body)) throw new Error('manifest conversion returned no body');
  const id = body['id'];
  return {
    id: typeof id === 'number' || typeof id === 'string' ? String(id) : str(undefined, 'id'),
    slug: str(body['slug'], 'slug'),
    clientId: str(body['client_id'], 'client_id'),
    clientSecret: str(body['client_secret'], 'client_secret'),
    webhookSecret: typeof body['webhook_secret'] === 'string' && body['webhook_secret'] !== '' ? body['webhook_secret'] : null,
    pem: str(body['pem'], 'pem'),
  };
}

/** `SNAPWING_PUBLIC_URL` from `.env.live`, else the environment, without a trailing slash; empty when unset. */
async function readPublicUrl(d: BootstrapDeps): Promise<string> {
  let publicUrl = d.env['SNAPWING_PUBLIC_URL'] ?? '';
  try {
    publicUrl = await envSecrets(d).get('SNAPWING_PUBLIC_URL');
  } catch (e) {
    if (!(e instanceof SecretNotFoundError)) throw e;
  }
  return publicUrl.trim().replace(/\/+$/, '');
}

export async function runApp(d: BootstrapDeps, options: AppOptions = {}): Promise<AppResult> {
  const fixtureRepo = options.fixtureRepo ?? DEFAULT_FIXTURE_REPO;
  d.log('app needs: a browser, and optionally SNAPWING_PUBLIC_URL in .env.live or the environment (without it the App is created with an inactive placeholder webhook).');
  const publicUrl = await readPublicUrl(d);
  if (publicUrl === '') d.log('SNAPWING_PUBLIC_URL is not set: creating the App with an inactive placeholder webhook (no callback URL); add it later with `pnpm github:bootstrap webhook`.');

  const state = randomBytes(16).toString('hex');
  const manifestTemplate: unknown = JSON.parse(await readFile(join(d.root, MANIFEST_FILE), 'utf8'));

  let finish: (r: AppResult) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const done = new Promise<AppResult>((resolve, reject) => {
    finish = resolve;
    fail = reject;
  });

  let page = '';
  let handling = false;
  const server: Server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const reply = (status: number, html: string): void => {
      res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(html);
    };
    if (url.pathname === '/' && req.method === 'GET') return reply(200, page);
    if (url.pathname !== '/callback' || req.method !== 'GET') return reply(404, 'not found');
    const code = url.searchParams.get('code') ?? '';
    if (url.searchParams.get('state') !== state || code === '') return reply(400, 'bad state or missing code');
    if (handling) return reply(409, 'already handled');
    handling = true;
    exchange(code).then(
      (result) => {
        reply(200, '<!doctype html><title>Done</title><p>The Snapwing GitHub App is created. Return to the terminal.</p>');
        finish(result);
      },
      (e: unknown) => {
        reply(500, 'The code exchange failed. See the terminal.');
        fail(e instanceof Error ? e : new Error(String(e)));
      },
    );
  });

  async function exchange(code: string): Promise<AppResult> {
    const res = await d.fetch(`${apiBase(d)}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new GitHubApiError(res.status, `manifest code exchange failed: ${await errorMessage(res)}`);
    const app = parseConversion(await res.json());
    await mkdir(join(d.root, 'secrets'), { recursive: true, mode: 0o700 });
    await writeFile(join(d.root, PEM_FILE), app.pem.endsWith('\n') ? app.pem : `${app.pem}\n`, { mode: 0o600 });
    await updateEnvFile(d, {
      GITHUB_APP_ID: app.id,
      GITHUB_APP_CLIENT_ID: app.clientId,
      GITHUB_APP_CLIENT_SECRET: app.clientSecret,
      GITHUB_WEBHOOK_SECRET: app.webhookSecret ?? randomBytes(32).toString('hex'),
      GITHUB_APP_PRIVATE_KEY: app.pem,
      GITHUB_APP_PRIVATE_KEY_PATH: PEM_FILE,
      GITHUB_APP_SLUG: app.slug,
    });
    return { appId: app.id, slug: app.slug, installUrl: `${webBase(d)}/apps/${app.slug}/installations/new` };
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local server has no port');
  const local = `http://127.0.0.1:${address.port}`;
  const substituted = substitute(manifestTemplate, { SNAPWING_PUBLIC_URL: publicUrl, REDIRECT_URL: `${local}/callback` });
  let manifest = substituted;
  if (publicUrl === '' && isRecord(substituted)) {
    const { callback_urls: _callbacks, ...rest } = substituted;
    manifest = { ...rest, hook_attributes: { url: PLACEHOLDER_HOOK_URL, active: false } };
  }
  const target = options.org === undefined ? `${webBase(d)}/settings/apps/new` : `${webBase(d)}/organizations/${encodeURIComponent(options.org)}/settings/apps/new`;
  page = renderPage(`${target}?state=${state}`, manifest);

  const timer = setTimeout(() => fail(new Error('timed out waiting for GitHub to redirect back')), options.timeoutMs ?? 10 * 60 * 1000);
  try {
    d.log(`Open ${local} and click "Create GitHub App" (opening it now).`);
    d.openUrl(local);
    const result = await done;
    d.log(`Created GitHub App "${result.slug}" (id ${result.appId}). Wrote ${ENV_FILE} and ${PEM_FILE}.`);
    d.log(`Next: install it on ${fixtureRepo} only (choose "Only select repositories"): ${result.installUrl}`);
    d.log('Then run `pnpm github:bootstrap verify`.');
    return result;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

// ---------------------------------------------------------------------------------------------------------------------
// fixture

/** Reads `gh auth status` and fails with the refresh command when a required scope is missing. */
async function checkGhScopes(d: BootstrapDeps, required: readonly string[] = ['repo', 'workflow']): Promise<void> {
  const REFRESH_HINT = `gh auth refresh -s ${required.join(',')}`;
  let status: string;
  try {
    status = await d.gh(['auth', 'status']);
  } catch {
    throw new Error(`gh is not logged in: run \`gh auth login\`, then \`${REFRESH_HINT}\``);
  }
  const line = /Token scopes:(.*)/i.exec(status)?.[1];
  if (line === undefined) {
    d.log('note: gh auth status lists no token scopes (fine-grained or environment token); continuing.');
    return;
  }
  const have = line.split(/[\s,'"]+/).filter((x) => x !== '');
  const missing = required.filter((x) => !have.includes(x));
  if (missing.length > 0) throw new Error(`gh is missing the ${missing.join(' and ')} scope(s): run \`${REFRESH_HINT}\` and retry`);
  d.log(`ok   gh has the ${required.join(' and ')} scope(s).`);
}

export interface FixtureOptions {
  repo?: string;
}

export interface FixtureResult {
  repo: string;
  created: boolean;
  commit: string;
  closedPullRequests: number[];
  deletedBranches: string[];
}

async function listFixtureFiles(root: string): Promise<{ path: string; content: Buffer }[]> {
  const base = join(root, FIXTURE_DIR);
  const out: { path: string; content: Buffer }[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else out.push({ path: relative(base, full).split('\\').join('/'), content: await readFile(full) });
    }
  }
  await walk(base);
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

const isStray = (ref: string): boolean => ref.startsWith('fix/') || ref.startsWith('test/');

export async function runFixture(d: BootstrapDeps, options: FixtureOptions = {}): Promise<FixtureResult> {
  const repo = options.repo ?? DEFAULT_FIXTURE_REPO;
  const { owner, name } = splitRepo(repo);
  d.log('fixture needs: `gh` logged in with the repo and workflow scopes (checking now).');
  await checkGhScopes(d);
  const token = await ghToken(d);
  return reset(d, token, repo, owner, name);
}

/** A 403 from the protection endpoint is GitHub's plan limit; report the cause and the owner's command, not a stack. */
async function protectionPut(repo: string, run: () => Promise<unknown>): Promise<void> {
  try {
    await run();
  } catch (e) {
    if (e instanceof GitHubApiError && e.status === 403) {
      throw new Error(
        `FAIL branch protection needs a public repository on this GitHub plan; the owner decides: run \`gh repo edit ${repo} --visibility public --accept-visibility-change-consequences\` and then re-run \`pnpm github:bootstrap fixture\``,
        { cause: e },
      );
    }
    throw e;
  }
}

async function reset(d: BootstrapDeps, token: string, repo: string, owner: string, name: string): Promise<FixtureResult> {
  const userBody = (await must(d, token, 'GET', '/user')).body;
  const login = isRecord(userBody) ? str(userBody['login'], 'login') : str(undefined, 'login');

  let created = false;
  let info = await call(d, token, 'GET', `/repos/${repo}`);
  if (info.status === 404) {
    const path = owner.toLowerCase() === login.toLowerCase() ? '/user/repos' : `/orgs/${owner}/repos`;
    info = await must(d, token, 'POST', path, {
      name,
      private: true,
      auto_init: true,
      description: 'Snapwing fixture: a small web project with one seeded bug. Reset by `pnpm github:bootstrap fixture`.',
    });
    created = true;
  } else if (info.status < 200 || info.status > 299) {
    throw new GitHubApiError(info.status, `GET /repos/${repo}: ${messageOf(info.body)}`);
  }
  const branch = isRecord(info.body) && typeof info.body['default_branch'] === 'string' ? info.body['default_branch'] : 'main';

  // A protected branch refuses the force push below, so lift the rule first and set it again at the end.
  await must(d, token, 'DELETE', `/repos/${repo}/branches/${branch}/protection`, undefined, [404, 403]);

  const closedPullRequests: number[] = [];
  for (let page = 1; ; page += 1) {
    const prs = (await must(d, token, 'GET', `/repos/${repo}/pulls?state=open&per_page=100&page=${page}`)).body;
    if (!Array.isArray(prs)) break;
    for (const pr of prs) {
      if (!isRecord(pr) || !isRecord(pr['head'])) continue;
      const ref = pr['head']['ref'];
      const number = pr['number'];
      if (typeof ref !== 'string' || typeof number !== 'number' || !isStray(ref)) continue;
      await must(d, token, 'PATCH', `/repos/${repo}/pulls/${number}`, { state: 'closed' });
      closedPullRequests.push(number);
    }
    if (prs.length < 100) break;
  }

  const deletedBranches: string[] = [];
  for (const prefix of ['fix/', 'test/']) {
    const refs = (await must(d, token, 'GET', `/repos/${repo}/git/matching-refs/heads/${prefix}`)).body;
    if (!Array.isArray(refs)) continue;
    for (const r of refs) {
      const ref = isRecord(r) ? r['ref'] : undefined;
      if (typeof ref !== 'string' || !ref.startsWith('refs/heads/') || !isStray(ref.slice('refs/heads/'.length))) continue;
      await must(d, token, 'DELETE', `/repos/${repo}/git/${ref}`, undefined, [422]);
      deletedBranches.push(ref.slice('refs/heads/'.length));
    }
  }

  // One root commit with a fixed author and date: the same files always give the same commit.
  const files = await listFixtureFiles(d.root);
  const tree: { path: string; mode: string; type: string; sha: string }[] = [];
  for (const f of files) {
    const blob = (await must(d, token, 'POST', `/repos/${repo}/git/blobs`, { content: f.content.toString('base64'), encoding: 'base64' })).body;
    tree.push({ path: f.path, mode: '100644', type: 'blob', sha: isRecord(blob) ? str(blob['sha'], 'blob sha') : str(undefined, 'blob sha') });
  }
  const treeBody = (await must(d, token, 'POST', `/repos/${repo}/git/trees`, { tree })).body;
  const stamp = { name: 'Snapwing Fixture', email: 'fixture@snapwing.invalid', date: SEED_DATE };
  const commitBody = (
    await must(d, token, 'POST', `/repos/${repo}/git/commits`, {
      message: 'Seed the Snapwing fixture',
      tree: isRecord(treeBody) ? str(treeBody['sha'], 'tree sha') : str(undefined, 'tree sha'),
      parents: [],
      author: stamp,
      committer: stamp,
    })
  ).body;
  const commit = isRecord(commitBody) ? str(commitBody['sha'], 'commit sha') : str(undefined, 'commit sha');
  const updated = await call(d, token, 'PATCH', `/repos/${repo}/git/refs/heads/${branch}`, { sha: commit, force: true });
  if (updated.status === 422 || updated.status === 404) {
    await must(d, token, 'POST', `/repos/${repo}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit });
  } else if (updated.status < 200 || updated.status > 299) {
    throw new GitHubApiError(updated.status, `PATCH git/refs/heads/${branch}: ${messageOf(updated.body)}`);
  }

  await protectionPut(repo, () => must(d, token, 'PUT', `/repos/${repo}/branches/${branch}/protection`, {
    required_status_checks: { strict: false, checks: [{ context: REQUIRED_CHECK }] },
    enforce_admins: false,
    required_pull_request_reviews: { required_approving_review_count: 1, dismiss_stale_reviews: false, require_code_owner_reviews: false },
    restrictions: null,
  }));

  d.log(`${created ? 'Created' : 'Reset'} ${repo} at ${commit.slice(0, 7)}; ${branch} requires ${REQUIRED_CHECK} and one approval.`);
  d.log('Next: `pnpm github:bootstrap app`.');
  d.log(`Closed ${closedPullRequests.length} stray PR(s), deleted ${deletedBranches.length} stray branch(es).`);
  return { repo, created, commit, closedPullRequests, deletedBranches };
}

// ---------------------------------------------------------------------------------------------------------------------
// destroy

export interface DestroyOptions {
  repo?: string;
  yes?: boolean;
}

/** Deletes the fixture repository. The GitHub App is not touched. */
export async function runDestroy(d: BootstrapDeps, options: DestroyOptions = {}): Promise<{ repo: string; deleted: boolean }> {
  const repo = options.repo ?? DEFAULT_FIXTURE_REPO;
  splitRepo(repo);
  d.log(`destroy needs: --yes, and \`gh\` logged in with the delete_repo scope; it deletes ${repo} for good.`);
  if (options.yes !== true) throw new Error(`refusing to delete ${repo} without --yes: rerun \`pnpm github:bootstrap destroy --yes\``);
  await checkGhScopes(d, ['delete_repo']);
  const token = await ghToken(d);
  const r = await call(d, token, 'DELETE', `/repos/${repo}`);
  if (r.status === 404) {
    d.log(`${repo} does not exist; nothing to delete.`);
  } else if (r.status < 200 || r.status > 299) {
    throw new GitHubApiError(r.status, `DELETE /repos/${repo}: ${messageOf(r.body)}`);
  } else {
    d.log(`Deleted ${repo}.`);
  }
  d.log('The Snapwing GitHub App itself stays: delete it at https://github.com/settings/apps (open the App, then Advanced, then Delete GitHub App) if it is no longer wanted.');
  return { repo, deleted: r.status !== 404 };
}

// ---------------------------------------------------------------------------------------------------------------------
// verify

export interface VerifyOptions {
  repo?: string;
}

export interface VerifyCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface VerifyResult {
  ok: boolean;
  installationId: string | null;
  checks: VerifyCheck[];
}

export async function runVerify(d: BootstrapDeps, options: VerifyOptions = {}): Promise<VerifyResult> {
  const repo = options.repo ?? DEFAULT_FIXTURE_REPO;
  const { owner } = splitRepo(repo);
  d.log(`verify needs: GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY in ${ENV_FILE} (from \`app\`), the App installed on ${repo}, and \`gh\` logged in.`);
  const secrets = envSecrets(d);
  const appId = (await secrets.get('GITHUB_APP_ID')).trim();
  const pem = await secrets.get('GITHUB_APP_PRIVATE_KEY');
  const jwt = signAppJwt(appId, pem, d.now());

  const checks: VerifyCheck[] = [];
  const record = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    d.log(`${ok ? 'ok  ' : 'FAIL'} ${name}: ${detail}`);
  };

  // The slug names the App's bot login (`<slug>[bot]`) for the GitHub webhook route; `app` writes it too, this picks it up on a re-run.
  const appBody = (await must(d, jwt, 'GET', '/app')).body;
  const slug = isRecord(appBody) ? str(appBody['slug'], 'slug') : str(undefined, 'slug');
  await updateEnvFile(d, { GITHUB_APP_SLUG: slug });
  record('app', true, `read App "${slug}"; wrote GITHUB_APP_SLUG to ${ENV_FILE}`);

  const listed = await must(d, jwt, 'GET', '/app/installations?per_page=100');
  const installs = Array.isArray(listed.body) ? listed.body.filter(isRecord) : [];
  const mine = installs.filter((i) => isRecord(i['account']) && String(i['account']['login']).toLowerCase() === owner.toLowerCase());
  const chosen = mine[0];
  const rawId = chosen?.['id'];
  if (rawId === undefined || (typeof rawId !== 'number' && typeof rawId !== 'string')) {
    record('installation', false, `the App is not installed on ${owner}; open the install link printed by \`app\``);
    return { ok: false, installationId: null, checks };
  }
  const installationId = String(rawId);
  await updateEnvFile(d, { GITHUB_INSTALLATION_ID: installationId });
  record('installation', true, `found installation ${installationId} on ${owner}; wrote GITHUB_INSTALLATION_ID to ${ENV_FILE}`);

  const tokenBody = (await must(d, jwt, 'POST', `/app/installations/${installationId}/access_tokens`, {})).body;
  const installToken = isRecord(tokenBody) ? str(tokenBody['token'], 'installation token') : str(undefined, 'installation token');
  const repos = (await must(d, installToken, 'GET', '/installation/repositories?per_page=100')).body;
  const names = isRecord(repos) && Array.isArray(repos['repositories']) ? repos['repositories'].filter(isRecord).map((r) => String(r['full_name']).toLowerCase()) : [];
  record('repository access', names.includes(repo.toLowerCase()), names.includes(repo.toLowerCase()) ? `installation covers ${repo}` : `installation does not cover ${repo}`);

  const gh = await ghToken(d);
  const owned = await call(d, gh, 'GET', `/repos/${repo}`);
  const branch = isRecord(owned.body) && typeof owned.body['default_branch'] === 'string' ? owned.body['default_branch'] : 'main';
  const prot = await call(d, gh, 'GET', `/repos/${repo}/branches/${branch}/protection`);
  if (prot.status === 404 || !isRecord(prot.body)) {
    record('branch protection', false, `${branch} has no protection rule; run \`fixture\``);
  } else {
    const rsc = prot.body['required_status_checks'];
    const contexts = isRecord(rsc) && Array.isArray(rsc['checks']) ? rsc['checks'].filter(isRecord).map((c) => c['context']) : [];
    const legacy = isRecord(rsc) && Array.isArray(rsc['contexts']) ? rsc['contexts'] : [];
    const prr = prot.body['required_pull_request_reviews'];
    const approvals = isRecord(prr) && typeof prr['required_approving_review_count'] === 'number' ? prr['required_approving_review_count'] : 0;
    const hasCheck = contexts.includes(REQUIRED_CHECK) || legacy.includes(REQUIRED_CHECK);
    record('branch protection', hasCheck && approvals >= 1, `${branch}: required check ${REQUIRED_CHECK} ${hasCheck ? 'present' : 'missing'}, ${approvals} approval(s) required`);
  }
  const ok = checks.every((c) => c.ok);
  if (ok) d.log('Next: `pnpm github:bootstrap secrets`.');
  return { ok, installationId, checks };
}

// ---------------------------------------------------------------------------------------------------------------------
// secrets

export interface SecretsOptions {
  repo?: string;
}

export async function runSecrets(d: BootstrapDeps, options: SecretsOptions = {}): Promise<{ repo: string; set: string[] }> {
  const repo = options.repo ?? DEFAULT_SNAPWING_REPO;
  splitRepo(repo);
  d.log(`secrets targets ${repo}: it copies ${Object.keys(SECRET_MAP).join(', ')} from ${ENV_FILE} into repository secrets (${Object.values(SECRET_MAP).join(', ')}) using \`gh\`.`);
  const source = envSecrets(d);
  const values: [string, string][] = [];
  const missing: string[] = [];
  for (const [local, remote] of Object.entries(SECRET_MAP)) {
    try {
      values.push([remote, await source.get(local)]);
    } catch (e) {
      if (!(e instanceof SecretNotFoundError)) throw e;
      missing.push(local);
    }
  }
  if (missing.length > 0) throw new Error(`${ENV_FILE} is missing ${missing.join(', ')}; run the earlier steps first (nothing was set)`);
  const set: string[] = [];
  for (const [remote, value] of values) {
    await d.gh(['secret', 'set', remote, '--repo', repo], value);
    set.push(remote);
    d.log(`set ${remote} on ${repo}`);
  }
  return { repo, set };
}

// ---------------------------------------------------------------------------------------------------------------------
// webhook

export interface WebhookResult {
  url: string;
  /** True when GitHub's API cannot switch the webhook on and the owner must tick "Active" on the settings page. */
  needsActivation: boolean;
  settingsUrl: string;
}

/**
 * Sets the App's webhook URL and secret. `PATCH /app/hook/config` changes the URL, secret, and content type only; it
 * cannot turn a webhook on. An App created without a public URL has an inactive placeholder webhook, so the first
 * time (the hook URL is empty or still the placeholder) the owner must tick "Active" once on the App settings page.
 */
export async function runWebhook(d: BootstrapDeps): Promise<WebhookResult> {
  d.log(`webhook needs: SNAPWING_PUBLIC_URL (in ${ENV_FILE} or the environment) and GITHUB_APP_ID, GITHUB_APP_PRIVATE_KEY, GITHUB_WEBHOOK_SECRET in ${ENV_FILE} (from \`app\`).`);
  const publicUrl = await readPublicUrl(d);
  if (publicUrl === '') throw new Error(`SNAPWING_PUBLIC_URL is not set (in ${ENV_FILE} or the environment); set it to the public https URL of this install and rerun`);
  const secrets = envSecrets(d);
  const appId = (await secrets.get('GITHUB_APP_ID')).trim();
  const pem = await secrets.get('GITHUB_APP_PRIVATE_KEY');
  const webhookSecret = await secrets.get('GITHUB_WEBHOOK_SECRET');
  const jwt = signAppJwt(appId, pem, d.now());
  const url = `${publicUrl}/webhooks/github`;

  const appBody = (await must(d, jwt, 'GET', '/app')).body;
  const slug = isRecord(appBody) && typeof appBody['slug'] === 'string' ? appBody['slug'] : '';
  const owner = isRecord(appBody) && isRecord(appBody['owner']) ? appBody['owner'] : {};
  const settingsUrl =
    owner['type'] === 'Organization' && typeof owner['login'] === 'string'
      ? `${webBase(d)}/organizations/${owner['login']}/settings/apps/${slug}`
      : `${webBase(d)}/settings/apps/${slug}`;

  const before = await call(d, jwt, 'GET', '/app/hook/config');
  const hadUrl = before.status === 200 && isRecord(before.body) && typeof before.body['url'] === 'string' && before.body['url'] !== '' && before.body['url'] !== PLACEHOLDER_HOOK_URL;

  const patched = await call(d, jwt, 'PATCH', '/app/hook/config', { url, content_type: 'json', secret: webhookSecret, insecure_ssl: '0' });
  const accepted = patched.status >= 200 && patched.status <= 299;
  if (!accepted && patched.status !== 404 && patched.status !== 422) throw new GitHubApiError(patched.status, `PATCH /app/hook/config: ${messageOf(patched.body)}`);

  const needsActivation = !accepted || !hadUrl;
  if (accepted) d.log(`Set the App webhook URL to ${url} with the stored GITHUB_WEBHOOK_SECRET.`);
  else d.log(`GitHub's API refused to set the webhook (${patched.status}: ${messageOf(patched.body)}), because the App was created without one.`);
  if (needsActivation) {
    d.log("GitHub's API cannot switch on a webhook that was never set. One-time step in the browser:");
    d.log(`  1. Open ${settingsUrl}`);
    d.log(`  2. Under "Webhook", tick "Active" (the URL ${url} and the secret are already set by this command).`);
    d.log('  3. Click "Save changes".');
  }
  d.log(`If the App was created without a user authorization callback URL, add ${publicUrl}/auth/github/callback under "Callback URL" on ${settingsUrl} and save.`);
  return { url, needsActivation, settingsUrl };
}

// ---------------------------------------------------------------------------------------------------------------------
// CLI

const USAGE = 'usage: pnpm github:bootstrap <fixture|app|verify|secrets|webhook|destroy> [--repo owner/name] [--org <org>] [--port <n>] [--no-open] [--yes]';

export interface ParsedArgs {
  command: string;
  repo?: string;
  org?: string;
  port?: number;
  open: boolean;
  yes: boolean;
}

export function parseArgs(argv: readonly string[]): ParsedArgs {
  const [command = '', ...rest] = argv;
  const out: ParsedArgs = { command, open: true, yes: false };
  for (let i = 0; i < rest.length; i += 1) {
    const flag = rest[i];
    const value = (): string => {
      const v = rest[(i += 1)];
      if (v === undefined) throw new Error(`${flag} needs a value`);
      return v;
    };
    if (flag === '--repo') out.repo = value();
    else if (flag === '--org') out.org = value();
    else if (flag === '--port') out.port = Number(value());
    else if (flag === '--no-open') out.open = false;
    else if (flag === '--yes') out.yes = true;
    else throw new Error(`unknown argument ${String(flag)}\n${USAGE}`);
  }
  return out;
}

function realGh(args: readonly string[], input?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('gh', [...args], { stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c: Buffer) => (stdout += c.toString()));
    child.stderr.on('data', (c: Buffer) => (stderr += c.toString()));
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve(stdout === '' ? stderr : stdout) : reject(new Error(`gh ${args.slice(0, 2).join(' ')} failed (${code}): ${stderr.trim()}`))));
    child.stdin.end(input ?? '');
  });
}

export async function main(argv: readonly string[]): Promise<number> {
  const args = parseArgs(argv);
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  const deps: BootstrapDeps = {
    fetch: (input, init) => fetch(input, init),
    gh: realGh,
    root,
    env: process.env,
    log: (line) => console.log(line),
    openUrl: (url) => {
      if (args.open) execFile(process.platform === 'darwin' ? 'open' : 'xdg-open', [url], () => undefined);
    },
    now: () => new Date(),
  };
  const repoOpt = args.repo === undefined ? {} : { repo: args.repo };
  switch (args.command) {
    case 'app':
      await runApp(deps, { ...(args.org === undefined ? {} : { org: args.org }), ...(args.port === undefined ? {} : { port: args.port }), ...(args.repo === undefined ? {} : { fixtureRepo: args.repo }) });
      return 0;
    case 'fixture':
      await runFixture(deps, repoOpt);
      return 0;
    case 'verify':
      return (await runVerify(deps, repoOpt)).ok ? 0 : 1;
    case 'secrets':
      await runSecrets(deps, repoOpt);
      return 0;
    case 'destroy':
      await runDestroy(deps, { ...repoOpt, yes: args.yes });
      return 0;
    case 'webhook':
      await runWebhook(deps);
      return 0;
    default:
      console.error(USAGE);
      return 2;
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e: unknown) => {
      console.error(e instanceof Error ? e.message : String(e));
      process.exit(1);
    },
  );
}
