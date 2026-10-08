// Creating the Snapwing GitHub App through GitHub's manifest flow (main 14.4, 22.2 step 3).
//
// `runManifestFlow` serves a local page that posts the manifest to GitHub, catches the redirect GitHub
// sends back with a one-time code, and exchanges the code for the App's credentials. The redirect is
// accepted only with the random `state` the page was built with; anything else is refused and does not
// end the wait. `runApp` is `pnpm github:bootstrap app` (credentials to `.env.live`); the onboarding step
// calls `runManifestFlow` and keeps the credentials as secrets itself.

import { randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import { join } from 'node:path';
import { assetPath } from '@snapwing/pipeline/util/assets.ts';
import { GitHubApiError, errorMessage, signAppJwt } from '../../github/auth.ts';
import { apiBase, DEFAULT_FIXTURE_REPO, ENV_FILE, isRecord, must, PEM_FILE, PLACEHOLDER_HOOK_URL, readPublicUrl, str, updateEnvFile, webBase, type BootstrapDeps, type GitHubDeps } from './api.ts';

export const DEFAULT_MANIFEST_PATH = assetPath('manifests/github-app.json');

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

/** What GitHub returns for a manifest code: the App and its credentials. */
export interface Conversion {
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

export interface ManifestFlowOptions {
  /** Snapwing's public https address; empty creates the App with the inactive placeholder webhook and no callback URL. */
  publicUrl: string;
  /** The App's name; GitHub App names are global. Default: the manifest's own. */
  name?: string;
  /** Create the App under this organization instead of the signed-in user. */
  org?: string;
  port?: number;
  /** Give up waiting for the redirect after this many ms. Default 10 minutes. */
  timeoutMs?: number;
  manifestPath?: string;
  /** Runs with the credentials before the browser is told it worked; a throw fails the flow. */
  onConverted?: (app: Conversion) => Promise<void>;
}

/**
 * The manifest for this install: placeholders filled in, the name set, and, without a public address,
 * an inactive placeholder webhook and no callback URL.
 */
export async function buildManifest(options: { publicUrl: string; redirectUrl: string; name?: string; manifestPath?: string }): Promise<Record<string, unknown>> {
  const template: unknown = JSON.parse(await readFile(options.manifestPath ?? DEFAULT_MANIFEST_PATH, 'utf8'));
  const filled = substitute(template, { SNAPWING_PUBLIC_URL: options.publicUrl, REDIRECT_URL: options.redirectUrl });
  if (!isRecord(filled)) throw new Error('the GitHub App manifest is not an object');
  let manifest = filled;
  if (options.publicUrl === '') {
    const { callback_urls: _callbacks, ...rest } = filled;
    manifest = { ...rest, hook_attributes: { url: PLACEHOLDER_HOOK_URL, active: false } };
  }
  return options.name === undefined ? manifest : { ...manifest, name: options.name };
}

/**
 * Opens the local page, waits for GitHub to redirect back with a code for the right `state`, and
 * exchanges it. Rejects when the wait runs out (the installer cancelled or closed the tab) or GitHub
 * refuses the code. The local server is always closed.
 */
export async function runManifestFlow(d: GitHubDeps, options: ManifestFlowOptions): Promise<Conversion> {
  const state = randomBytes(16).toString('hex');
  let finish: (r: Conversion) => void = () => undefined;
  let fail: (e: Error) => void = () => undefined;
  const done = new Promise<Conversion>((resolve, reject) => {
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

  async function exchange(code: string): Promise<Conversion> {
    const res = await d.fetch(`${apiBase(d)}/app-manifests/${encodeURIComponent(code)}/conversions`, {
      method: 'POST',
      headers: { Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new GitHubApiError(res.status, `manifest code exchange failed: ${await errorMessage(res)}`);
    const app = parseConversion(await res.json());
    await options.onConverted?.(app);
    return app;
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(options.port ?? 0, '127.0.0.1', resolve);
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('local server has no port');
  const local = `http://127.0.0.1:${address.port}`;
  const manifest = await buildManifest({
    publicUrl: options.publicUrl,
    redirectUrl: `${local}/callback`,
    ...(options.name === undefined ? {} : { name: options.name }),
    ...(options.manifestPath === undefined ? {} : { manifestPath: options.manifestPath }),
  });
  const target = options.org === undefined ? `${webBase(d)}/settings/apps/new` : `${webBase(d)}/organizations/${encodeURIComponent(options.org)}/settings/apps/new`;
  page = renderPage(`${target}?state=${state}`, manifest);

  const timer = setTimeout(() => fail(new Error('timed out waiting for GitHub to redirect back')), options.timeoutMs ?? 10 * 60 * 1000);
  try {
    d.log(`Open ${local} and click "Create GitHub App" (opening it now).`);
    d.openUrl(local);
    return await done;
  } finally {
    clearTimeout(timer);
    server.closeAllConnections();
    server.close();
  }
}

/** The page where the owner installs the App. */
export const installUrlFor = (d: GitHubDeps, slug: string): string => `${webBase(d)}/apps/${slug}/installations/new`;

/** `pnpm github:bootstrap app`: the manifest flow, with the credentials written to `.env.live` and the key file. */
export async function runApp(d: BootstrapDeps, options: AppOptions = {}): Promise<AppResult> {
  const fixtureRepo = options.fixtureRepo ?? DEFAULT_FIXTURE_REPO;
  d.log('app needs: a browser, and optionally SNAPWING_PUBLIC_URL in .env.live or the environment (without it the App is created with an inactive placeholder webhook).');
  const publicUrl = await readPublicUrl(d);
  if (publicUrl === '') d.log('SNAPWING_PUBLIC_URL is not set: creating the App with an inactive placeholder webhook (no callback URL); add it later with `pnpm github:bootstrap webhook`.');

  const app = await runManifestFlow(d, {
    publicUrl,
    ...(options.org === undefined ? {} : { org: options.org }),
    ...(options.port === undefined ? {} : { port: options.port }),
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    onConverted: async (c) => {
      await mkdir(join(d.root, 'secrets'), { recursive: true, mode: 0o700 });
      await writeFile(join(d.root, PEM_FILE), c.pem.endsWith('\n') ? c.pem : `${c.pem}\n`, { mode: 0o600 });
      await updateEnvFile(d, {
        GITHUB_APP_ID: c.id,
        GITHUB_APP_CLIENT_ID: c.clientId,
        GITHUB_APP_CLIENT_SECRET: c.clientSecret,
        GITHUB_WEBHOOK_SECRET: c.webhookSecret ?? randomBytes(32).toString('hex'),
        GITHUB_APP_PRIVATE_KEY: c.pem,
        GITHUB_APP_PRIVATE_KEY_PATH: PEM_FILE,
        GITHUB_APP_SLUG: c.slug,
      });
    },
  });
  const result: AppResult = { appId: app.id, slug: app.slug, installUrl: installUrlFor(d, app.slug) };
  d.log(`Created GitHub App "${result.slug}" (id ${result.appId}). Wrote ${ENV_FILE} and ${PEM_FILE}.`);
  d.log(`Next: install it on ${fixtureRepo} only (choose "Only select repositories"): ${result.installUrl}`);
  d.log('Then run `pnpm github:bootstrap verify`.');
  return result;
}

// ---------------------------------------------------------------------------------------------------------------------
// After the App exists: its installation and the repositories it can reach (used by the onboarding step)

/** The id of the App's installation on `owner` (a user or organization login), or undefined when it is not installed there. */
export async function findInstallation(d: GitHubDeps, appId: string, pem: string, owner: string): Promise<string | undefined> {
  const jwt = signAppJwt(appId, pem, d.now());
  const listed = await must(d, jwt, 'GET', '/app/installations?per_page=100');
  const installs = Array.isArray(listed.body) ? listed.body.filter(isRecord) : [];
  const mine = installs.find((i) => isRecord(i['account']) && String(i['account']['login']).toLowerCase() === owner.toLowerCase());
  const id = mine?.['id'];
  return typeof id === 'number' || typeof id === 'string' ? String(id) : undefined;
}

/** The repositories (`owner/name`) the installation can reach. */
export async function installationRepos(d: GitHubDeps, appId: string, pem: string, installationId: string): Promise<string[]> {
  const jwt = signAppJwt(appId, pem, d.now());
  const tokenBody = (await must(d, jwt, 'POST', `/app/installations/${encodeURIComponent(installationId)}/access_tokens`, {})).body;
  const token = isRecord(tokenBody) ? str(tokenBody['token'], 'installation token') : str(undefined, 'installation token');
  const names: string[] = [];
  for (let page = 1; page <= 20; page += 1) {
    const body = (await must(d, token, 'GET', `/installation/repositories?per_page=100&page=${page}`)).body;
    const list = isRecord(body) && Array.isArray(body['repositories']) ? body['repositories'].filter(isRecord) : [];
    for (const r of list) if (typeof r['full_name'] === 'string') names.push(r['full_name']);
    if (list.length < 100) break;
  }
  return names;
}

/** The App's slug as GitHub knows it, or undefined when GitHub refuses the App's own credentials. */
export async function readAppSlug(d: GitHubDeps, appId: string, pem: string): Promise<string | undefined> {
  try {
    const body = (await must(d, signAppJwt(appId, pem, d.now()), 'GET', '/app')).body;
    return isRecord(body) && typeof body['slug'] === 'string' ? body['slug'] : undefined;
  } catch (e) {
    if (e instanceof GitHubApiError && (e.status === 401 || e.status === 404)) return undefined;
    throw e;
  }
}

/**
 * Sets the App's webhook URL and secret with `PATCH /app/hook/config`. GitHub's manifest conversion
 * does not return the secret Snapwing generated, so the step sets it here. False when GitHub refused.
 */
export async function setWebhookConfig(d: GitHubDeps, appId: string, pem: string, url: string, secret: string): Promise<boolean> {
  const res = await d.fetch(`${apiBase(d)}/app/hook/config`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${signAppJwt(appId, pem, d.now())}`,
      Accept: 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ url, content_type: 'json', secret, insecure_ssl: '0' }),
  });
  return res.ok;
}
