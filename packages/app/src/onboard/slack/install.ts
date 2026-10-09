// Helpers for onboarding step 1, Slack (main 15.1, 22.2, 22.4): creating the app from the manifest,
// exchanging an OAuth redirect for the bot token, checking the tokens, and listing and joining
// channels. Every call goes through `callSlack` (the bootstrap's one Slack client), so a token is
// only ever sent as an Authorization header or a form field, never put in a message.

import { createServer, type Server } from 'node:http';
import type { SecretValue } from '../interview/io.ts';
import { callSlack, DEFAULT_MANIFEST_PATH, loadManifest, scrub, type Manifest } from './bootstrap.ts';

export { DEFAULT_API_BASE } from './bootstrap.ts';


/** Where the installer generates the one-time app configuration token (it expires after 12 hours). */
export const CONFIG_TOKEN_PAGE = 'https://api.slack.com/apps';

/** The path on the public address that Slack redirects to after an install. */
export const OAUTH_CALLBACK_PATH = '/slack/oauth/callback';

/** The manifest as Slack's manifest API takes it, with a redirect address when one can be caught. */
export function manifestForCreate(redirectUri: string | undefined, manifestPath: string | URL = DEFAULT_MANIFEST_PATH): Manifest {
  const manifest = loadManifest(manifestPath) as Manifest & { oauth_config?: Record<string, unknown> };
  if (redirectUri === undefined) return manifest;
  return { ...manifest, oauth_config: { ...manifest.oauth_config, redirect_urls: [redirectUri] } } as Manifest;
}

export function botScopesOf(manifest: Manifest): readonly string[] {
  return manifest.oauth_config?.scopes?.bot ?? [];
}

/** Why a Slack call did not succeed: Slack's own error code, or `network` when there was no answer. */
export class SlackCallError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'SlackCallError';
    this.code = code;
  }
}

async function call(base: string, method: string, init: { token?: string; form?: Record<string, string> }): Promise<Record<string, unknown>> {
  try {
    const { body } = await callSlack(`${base}/${method}`, init);
    if (!body.ok) throw new SlackCallError(body.error ?? 'unknown', `${method}: ${body.error ?? 'unknown'}`);
    return body;
  } catch (e) {
    if (e instanceof SlackCallError) throw e;
    throw new SlackCallError('network', scrub(`${method}: ${e instanceof Error ? e.message : String(e)}`, []));
  }
}

/** Codes Slack answers with when a token is not (or is no longer) good. */
const TOKEN_REFUSALS = new Set(['invalid_auth', 'not_authed', 'token_expired', 'token_revoked', 'account_inactive', 'invalid_token']);
export const isTokenRefusal = (e: unknown): boolean => e instanceof SlackCallError && TOKEN_REFUSALS.has(e.code);

/** What `apps.manifest.validate` made of the manifest: fine, a refused token, or a problem in the manifest itself. */
export type ManifestCheck =
  | { readonly status: 'ok' }
  | { readonly status: 'token' }
  | { readonly status: 'invalid'; readonly detail: string }
  | { readonly status: 'unreachable' };

export async function validateManifest(base: string, configToken: SecretValue, manifest: Manifest): Promise<ManifestCheck> {
  try {
    const { body } = await callSlack(`${base}/apps.manifest.validate`, { token: configToken.reveal(), form: { manifest: JSON.stringify(manifest) } });
    if (body.ok) return { status: 'ok' };
    if (TOKEN_REFUSALS.has(body.error ?? '')) return { status: 'token' };
    const errors = Array.isArray(body['errors'])
      ? (body['errors'] as { message?: string; pointer?: string }[]).map((x) => `${x.pointer ?? ''} ${x.message ?? ''}`.trim()).join('; ')
      : '';
    return { status: 'invalid', detail: `${body.error ?? 'unknown'}${errors === '' ? '' : ` (${errors})`}` };
  } catch {
    return { status: 'unreachable' };
  }
}

export interface CreatedApp {
  readonly appId: string;
  readonly clientId: string;
  readonly clientSecret: string;
  readonly signingSecret: string;
}

/** `apps.manifest.create`. Throws `SlackCallError`. */
export async function createApp(base: string, configToken: SecretValue, manifest: Manifest): Promise<CreatedApp> {
  const body = await call(base, 'apps.manifest.create', { token: configToken.reveal(), form: { manifest: JSON.stringify(manifest) } });
  const creds = (body['credentials'] ?? {}) as Record<string, unknown>;
  const text = (v: unknown): string => (typeof v === 'string' ? v : '');
  const created = {
    appId: text(body['app_id']),
    clientId: text(creds['client_id']),
    clientSecret: text(creds['client_secret']),
    signingSecret: text(creds['signing_secret']),
  };
  if (Object.values(created).some((v) => v === '')) throw new SlackCallError('incomplete', 'apps.manifest.create: the answer had no app id or credentials');
  return created;
}

/** The link that installs the app without a redirect: the bot token is then copied from the app's page. */
export const installPageUrl = (appId: string): string => `https://api.slack.com/apps/${encodeURIComponent(appId)}/install-on-team`;

export function authorizeUrl(clientId: string, scopes: readonly string[], redirectUri: string, state: string): string {
  const q = new URLSearchParams({ client_id: clientId, scope: scopes.join(','), redirect_uri: redirectUri, state });
  return `https://slack.com/oauth/v2/authorize?${q.toString()}`;
}

/** `oauth.v2.access`: the bot token for the code Slack redirected with. Throws `SlackCallError`. */
export async function exchangeCode(base: string, app: { clientId: string; clientSecret: string }, code: string, redirectUri: string): Promise<string> {
  const body = await call(base, 'oauth.v2.access', {
    form: { client_id: app.clientId, client_secret: app.clientSecret, code, redirect_uri: redirectUri },
  });
  const token = body['access_token'];
  if (typeof token !== 'string' || token === '') throw new SlackCallError('incomplete', 'oauth.v2.access: no bot token in the answer');
  return token;
}

export interface BotIdentity {
  readonly userId: string;
  readonly teamId: string;
  readonly team: string;
}

export type TokenCheck<T> = { readonly status: 'ok'; readonly value: T } | { readonly status: 'rejected' | 'unreachable' };

/** `auth.test` with the bot token: who it is. Never throws. */
export async function checkBotToken(base: string, token: SecretValue): Promise<TokenCheck<BotIdentity>> {
  try {
    const b = await call(base, 'auth.test', { token: token.reveal() });
    const text = (v: unknown): string => (typeof v === 'string' ? v : '');
    return { status: 'ok', value: { userId: text(b['user_id']), teamId: text(b['team_id']), team: text(b['team']) } };
  } catch (e) {
    return { status: isTokenRefusal(e) ? 'rejected' : 'unreachable' };
  }
}

/** `apps.connections.open` with the app-level token. Never throws. */
export async function checkAppToken(base: string, token: SecretValue): Promise<TokenCheck<true>> {
  try {
    await call(base, 'apps.connections.open', { token: token.reveal() });
    return { status: 'ok', value: true };
  } catch (e) {
    return { status: isTokenRefusal(e) ? 'rejected' : 'unreachable' };
  }
}

export interface SlackChannel {
  readonly id: string;
  readonly name: string;
  readonly isPrivate: boolean;
  /** Whether the bot is already in it. */
  readonly isMember: boolean;
}

/** The channels the bot can see: every public one, and the private ones it has been invited to. */
export async function listChannels(base: string, token: SecretValue): Promise<SlackChannel[]> {
  const out: SlackChannel[] = [];
  let cursor = '';
  do {
    const b = await call(base, 'conversations.list', {
      token: token.reveal(),
      form: { types: 'public_channel,private_channel', exclude_archived: 'true', limit: '200', ...(cursor ? { cursor } : {}) },
    });
    for (const c of Array.isArray(b['channels']) ? (b['channels'] as Record<string, unknown>[]) : []) {
      if (typeof c['id'] !== 'string' || typeof c['name'] !== 'string') continue;
      out.push({ id: c['id'], name: c['name'], isPrivate: c['is_private'] === true, isMember: c['is_member'] === true });
    }
    const meta = (b['response_metadata'] ?? {}) as Record<string, unknown>;
    cursor = typeof meta['next_cursor'] === 'string' ? meta['next_cursor'] : '';
  } while (cursor !== '');
  return out;
}

/** `conversations.join` for a public channel. True when the bot is in it afterwards. Never throws. */
export async function joinChannel(base: string, token: SecretValue, channelId: string): Promise<boolean> {
  try {
    await call(base, 'conversations.join', { token: token.reveal(), form: { channel: channelId } });
    return true;
  } catch {
    return false;
  }
}

/** A running catch for the OAuth redirect. */
export interface RedirectListener {
  /** The code Slack redirected with (for the right `state`), or undefined when none came in time. */
  wait(timeoutMs: number): Promise<string | undefined>;
  close(): void;
}

/**
 * Listens on `port` for the OAuth redirect that arrives through the public https address. Undefined
 * when the port cannot be used, and the step then takes the token by paste instead.
 */
export function listenForRedirect(port: number, state: string): Promise<RedirectListener | undefined> {
  return new Promise((resolve) => {
    let deliver: (code: string) => void = () => undefined;
    const arrived = new Promise<string>((r) => {
      deliver = r;
    });
    const server: Server = createServer((req, res) => {
      const url = new URL(req.url ?? '/', 'http://localhost');
      if (url.pathname !== OAUTH_CALLBACK_PATH) {
        res.writeHead(404).end();
        return;
      }
      const code = url.searchParams.get('code');
      const good = code !== null && url.searchParams.get('state') === state;
      res.writeHead(good ? 200 : 400, { 'content-type': 'text/plain; charset=utf-8' });
      res.end(good ? 'Snapwing is installed. You can close this tab and go back to the terminal.' : 'That was not the install Snapwing is waiting for.');
      if (good) deliver(code);
    });
    server.once('error', () => resolve(undefined));
    server.listen(port, '127.0.0.1', () => {
      server.removeAllListeners('error');
      resolve({
        wait: (timeoutMs) => Promise.race([arrived, new Promise<undefined>((r) => setTimeout(() => r(undefined), timeoutMs).unref())]),
        close: () => void server.close(),
      });
    });
  });
}
