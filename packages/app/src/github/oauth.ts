// Linking a chat user to a GitHub account (main 11.2, main 16, ADR 0007): GitHub App user
// authorization (the OAuth web flow with the App's client id and secret), so a `Merge` tap acts as
// that human and GitHub's audit log names them. fetch and node:crypto only.
//
// Flow. Snapwing hands the chat user, privately, `linkUrl(user)`: `/auth/github/start?state=...`,
// where `state` is signed (HMAC-SHA256 under a key derived from SNAPWING_ENCRYPTION_KEY) and carries
// the workspace, the chat user, a nonce, and an expiry (10 minutes by default). The start route
// checks it, sets a cookie holding the nonce (so the callback runs in the browser that started), and
// redirects to GitHub's authorize page with the same `state`. The callback checks the signature, the
// expiry, and the cookie, then spends the nonce through `seenWebhook` (single use: a replayed state
// is rejected even inside its expiry), exchanges the code, reads `/user`, and stores the link with
// both tokens sealed (AES-256-GCM, `util/seal.ts`), bound to the row and column.
//
// Use. `userToken(user)` opens the access token and refreshes it first when it expires within 5
// minutes (GitHub rotates the refresh token on every refresh). A refresh GitHub refuses as
// `bad_refresh_token` re-reads the row, since another process may have refreshed it; if not, the
// link is dead and is removed, and the user links again. Tokens, the client secret, and the key are
// never logged, never put in an error, and never put in a response.
//
// Secrets (CONTEXT.md 6b): GITHUB_APP_CLIENT_ID, GITHUB_APP_CLIENT_SECRET (stored by
// `pnpm github:bootstrap`), SNAPWING_ENCRYPTION_KEY, SNAPWING_PUBLIC_URL. The callback URL is
// `${SNAPWING_PUBLIC_URL}/auth/github/callback`, as the bootstrap registers it.

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';
import type { ChatPlatform, LinkedIdentity, LinkedIdentityKey, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { deriveKey, parseSealKey, seal, unseal, type SealKey } from '@snapwing/pipeline/util/seal.ts';
import type { Route } from '../server/http.ts';
import { TOKEN_REFRESH_MARGIN_MS } from './auth.ts';

export const START_PATH = '/auth/github/start';
export const CALLBACK_PATH = '/auth/github/callback';
/** The cookie that binds the callback to the browser that started; scoped to `/auth/github`. */
export const STATE_COOKIE = 'snapwing_github_oauth';
/** `seenWebhook` source under which a spent state nonce is recorded. */
export const STATE_NONCE_SOURCE = 'github-oauth-state';
export const DEFAULT_STATE_TTL_SEC = 600;
const STATE_KEY_INFO = 'snapwing github oauth state v1';

export interface ChatUser {
  chat: ChatPlatform;
  userId: string;
}

export interface UserToken {
  token: string;
  githubLogin: string;
  githubUserId: number;
}

export interface GitHubOAuthOptions {
  state: StatePort;
  secrets: SecretsPort;
  /** The install's workspace; links are stored under it. */
  workspaceId: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Default `https://github.com` (authorize and token endpoints). */
  githubBase?: string;
  /** Default `https://api.github.com`. */
  apiBase?: string;
  /** How long a link stays usable, in seconds. Default 600. */
  stateTtlSec?: number;
}

export interface GitHubOAuth {
  /** `GET /auth/github/start` and `GET /auth/github/callback` (ADR 0016). */
  readonly routes: Route[];
  /** The link to send the chat user, privately; it works once, within `stateTtlSec`. */
  linkUrl(user: ChatUser): Promise<string>;
  /** The user's link, as stored (tokens sealed), or null. Backs the Slack `githubLinked` check. */
  getLinkedIdentity(user: ChatUser): Promise<LinkedIdentity | null>;
  /** True when the user has a link whose access token is current or can still be refreshed. */
  isLinked(user: ChatUser): Promise<boolean>;
  /** A usable user-to-server token, refreshed first when close to expiry; null when not linked or the link is dead. */
  userToken(user: ChatUser): Promise<UserToken | null>;
  /** Removes the user's link; true when there was one. */
  unlink(user: ChatUser): Promise<boolean>;
}

/** GitHub refused an OAuth exchange, or answered in a shape we do not know. Never carries a token. */
export class GitHubOAuthError extends Error {
  /** GitHub's `error` code (`bad_verification_code`, `bad_refresh_token`, ...), or `http_<status>`. */
  readonly code: string;

  constructor(code: string, message: string) {
    super(`GitHub OAuth: ${message}`);
    this.name = 'GitHubOAuthError';
    this.code = code;
  }
}

interface StatePayload {
  v: 1;
  w: string;
  c: ChatPlatform;
  u: string;
  n: string;
  /** Expiry, epoch seconds. */
  e: number;
}

type StateCheck = { ok: true; payload: StatePayload } | { ok: false; reason: 'invalid' | 'expired' };

interface TokenGrant {
  accessToken: string;
  accessTokenExpiresAt?: string;
  refreshToken?: string;
  refreshTokenExpiresAt?: string;
}

const NO_STORE = { 'Cache-Control': 'no-store' };

function page(status: number, title: string, message: string, extraHeaders: Record<string, string> = {}): Response {
  const esc = (s: string): string => s.replace(/[&<>"']/g, (ch) => `&#${ch.charCodeAt(0)};`);
  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>${esc(title)}</title></head><body><h1>${esc(title)}</h1><p>${esc(message)}</p></body></html>`;
  return new Response(body, { status, headers: { 'Content-Type': 'text/html; charset=utf-8', ...NO_STORE, ...extraHeaders } });
}

function readCookie(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (header === null) return undefined;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return part.slice(eq + 1).trim();
  }
  return undefined;
}

function isStatePayload(v: unknown): v is StatePayload {
  if (typeof v !== 'object' || v === null) return false;
  const p = v as Record<string, unknown>;
  return (
    p['v'] === 1 &&
    typeof p['w'] === 'string' &&
    (p['c'] === 'slack' || p['c'] === 'teams') &&
    typeof p['u'] === 'string' &&
    p['u'] !== '' &&
    typeof p['n'] === 'string' &&
    /^[A-Za-z0-9_-]{16,}$/.test(p['n']) &&
    typeof p['e'] === 'number' &&
    Number.isFinite(p['e'])
  );
}

function sealContext(key: LinkedIdentityKey, column: 'access_token' | 'refresh_token'): string {
  return JSON.stringify(['linked_identities', key.workspaceId, key.chat, key.chatUserId, column]);
}

function str(body: Record<string, unknown>, name: string): string | undefined {
  const v = body[name];
  return typeof v === 'string' && v !== '' ? v : undefined;
}

function seconds(body: Record<string, unknown>, name: string): number | undefined {
  const v = body[name];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^\d+$/.test(v) ? Number(v) : undefined;
  return n !== undefined && Number.isFinite(n) && n > 0 ? n : undefined;
}

export function createGitHubOAuth(options: GitHubOAuthOptions): GitHubOAuth {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const githubBase = (options.githubBase ?? 'https://github.com').replace(/\/+$/, '');
  const apiBase = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const ttlSec = options.stateTtlSec ?? DEFAULT_STATE_TTL_SEC;
  if (!Number.isFinite(ttlSec) || ttlSec <= 0) throw new RangeError('stateTtlSec must be a number of seconds greater than 0');
  const { state, secrets, workspaceId } = options;
  const inflight = new Map<string, Promise<UserToken | null>>();

  let keys: Promise<{ seal: SealKey; stateMac: Buffer }> | undefined;
  function sealKeys(): Promise<{ seal: SealKey; stateMac: Buffer }> {
    keys ??= secrets.get('SNAPWING_ENCRYPTION_KEY').then((raw) => {
      const sealKey = parseSealKey(raw);
      return { seal: sealKey, stateMac: deriveKey(sealKey, STATE_KEY_INFO) };
    });
    // A failed read is not cached, so a fixed secret is picked up without a restart.
    keys.catch(() => {
      keys = undefined;
    });
    return keys;
  }

  async function publicUrl(): Promise<string> {
    return (await secrets.get('SNAPWING_PUBLIC_URL')).trim().replace(/\/+$/, '');
  }

  async function client(): Promise<{ id: string; secret: string }> {
    const [id, secret] = await Promise.all([secrets.get('GITHUB_APP_CLIENT_ID'), secrets.get('GITHUB_APP_CLIENT_SECRET')]);
    return { id: id.trim(), secret: secret.trim() };
  }

  function keyOf(user: ChatUser): LinkedIdentityKey {
    return { workspaceId, chat: user.chat, chatUserId: user.userId };
  }

  // State ------------------------------------------------------------------------------------------

  async function signState(payload: StatePayload): Promise<string> {
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    const mac = createHmac('sha256', (await sealKeys()).stateMac).update(body).digest('base64url');
    return `${body}.${mac}`;
  }

  async function checkState(raw: string | null): Promise<StateCheck> {
    if (raw === null) return { ok: false, reason: 'invalid' };
    const dot = raw.indexOf('.');
    if (dot <= 0) return { ok: false, reason: 'invalid' };
    const body = raw.slice(0, dot);
    const given = Buffer.from(raw.slice(dot + 1), 'base64url');
    const expected = createHmac('sha256', (await sealKeys()).stateMac).update(body).digest();
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return { ok: false, reason: 'invalid' };
    let payload: unknown;
    try {
      payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
    } catch {
      return { ok: false, reason: 'invalid' };
    }
    if (!isStatePayload(payload) || payload.w !== workspaceId) return { ok: false, reason: 'invalid' };
    if (payload.e * 1000 <= now().getTime()) return { ok: false, reason: 'expired' };
    return { ok: true, payload };
  }

  function stateFailure(reason: 'invalid' | 'expired'): Response {
    return reason === 'expired'
      ? page(400, 'Link expired', 'This link has expired. Ask Snapwing for a new one.')
      : page(400, 'Link not valid', 'This link is not valid. Ask Snapwing for a new one.');
  }

  // GitHub -----------------------------------------------------------------------------------------

  async function tokenRequest(params: Record<string, string>): Promise<TokenGrant> {
    const res = await doFetch(`${githubBase}/login/oauth/access_token`, {
      method: 'POST',
      headers: { Accept: 'application/json', 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(params).toString(),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (typeof body !== 'object' || body === null) throw new GitHubOAuthError(`http_${res.status}`, `token endpoint answered ${res.status} without JSON`);
    const b = body as Record<string, unknown>;
    const error = str(b, 'error');
    if (error !== undefined) throw new GitHubOAuthError(error, `token endpoint refused the request (${error})`);
    const accessToken = str(b, 'access_token');
    if (!res.ok || accessToken === undefined) throw new GitHubOAuthError(`http_${res.status}`, `token endpoint answered ${res.status} without an access token`);
    const at = now().getTime();
    const expiresIn = seconds(b, 'expires_in');
    const refreshToken = str(b, 'refresh_token');
    const refreshExpiresIn = seconds(b, 'refresh_token_expires_in');
    return {
      accessToken,
      ...(expiresIn === undefined ? {} : { accessTokenExpiresAt: new Date(at + expiresIn * 1000).toISOString() }),
      ...(refreshToken === undefined ? {} : { refreshToken }),
      ...(refreshToken === undefined || refreshExpiresIn === undefined ? {} : { refreshTokenExpiresAt: new Date(at + refreshExpiresIn * 1000).toISOString() }),
    };
  }

  async function githubUser(token: string): Promise<{ login: string; id: number }> {
    const res = await doFetch(`${apiBase}/user`, {
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28' },
    });
    if (!res.ok) throw new GitHubOAuthError(`http_${res.status}`, `GET /user answered ${res.status}`);
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null) throw new GitHubOAuthError('bad_response', 'GET /user answered without a user');
    const { login, id } = body as Record<string, unknown>;
    if (typeof login !== 'string' || login === '' || typeof id !== 'number' || !Number.isSafeInteger(id)) {
      throw new GitHubOAuthError('bad_response', 'GET /user answered without a login and id');
    }
    return { login, id };
  }

  async function store(key: LinkedIdentityKey, grant: TokenGrant, user: { login: string; id: number }): Promise<void> {
    const sk = (await sealKeys()).seal;
    await state.linkIdentity({
      ...key,
      githubLogin: user.login,
      githubUserId: user.id,
      accessToken: seal(sk, grant.accessToken, sealContext(key, 'access_token')),
      ...(grant.accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt: grant.accessTokenExpiresAt }),
      ...(grant.refreshToken === undefined ? {} : { refreshToken: seal(sk, grant.refreshToken, sealContext(key, 'refresh_token')) }),
      ...(grant.refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt: grant.refreshTokenExpiresAt }),
    });
  }

  // Routes -----------------------------------------------------------------------------------------

  async function start(req: Request): Promise<Response> {
    const raw = new URL(req.url).searchParams.get('state');
    const check = await checkState(raw);
    if (!check.ok || raw === null) return stateFailure(check.ok ? 'invalid' : check.reason);
    const [{ id }, base] = await Promise.all([client(), publicUrl()]);
    const authorize = new URL(`${githubBase}/login/oauth/authorize`);
    authorize.searchParams.set('client_id', id);
    authorize.searchParams.set('redirect_uri', `${base}${CALLBACK_PATH}`);
    authorize.searchParams.set('state', raw);
    const maxAge = Math.max(1, Math.ceil(check.payload.e - now().getTime() / 1000));
    return new Response(null, {
      status: 302,
      headers: {
        Location: authorize.toString(),
        'Set-Cookie': `${STATE_COOKIE}=${check.payload.n}; Path=/auth/github; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`,
        ...NO_STORE,
      },
    });
  }

  async function callback(req: Request): Promise<Response> {
    const params = new URL(req.url).searchParams;
    const check = await checkState(params.get('state'));
    if (!check.ok) return stateFailure(check.reason);
    const { payload } = check;
    const cookie = readCookie(req, STATE_COOKIE);
    const nonce = Buffer.from(payload.n);
    const given = Buffer.from(cookie ?? '');
    if (given.length !== nonce.length || !timingSafeEqual(given, nonce)) {
      return page(400, 'Link not valid', 'Finish linking in the browser where you opened the link. Ask Snapwing for a new one.');
    }
    const clearCookie = { 'Set-Cookie': `${STATE_COOKIE}=; Path=/auth/github; Max-Age=0; HttpOnly; Secure; SameSite=Lax` };
    if (params.get('error') !== null) {
      return page(400, 'Not linked', 'GitHub authorization was cancelled. Ask Snapwing for a new link to try again.', clearCookie);
    }
    const code = params.get('code');
    if (code === null || code === '') return page(400, 'Link not valid', 'GitHub sent no authorization code. Ask Snapwing for a new link.', clearCookie);
    // Spend the nonce before the exchange, so a replayed callback never reaches GitHub. Kept a minute
    // past the expiry, by which time the signature check alone rejects it.
    const keepSec = Math.max(1, Math.ceil(payload.e - now().getTime() / 1000)) + 60;
    if (await state.seenWebhook(STATE_NONCE_SOURCE, payload.n, keepSec)) {
      return page(400, 'Link already used', 'This link was already used. Ask Snapwing for a new one.', clearCookie);
    }
    const [{ id, secret }, base] = await Promise.all([client(), publicUrl()]);
    let grant: TokenGrant;
    let user: { login: string; id: number };
    try {
      grant = await tokenRequest({ client_id: id, client_secret: secret, code, redirect_uri: `${base}${CALLBACK_PATH}` });
      user = await githubUser(grant.accessToken);
    } catch (e) {
      if (e instanceof GitHubOAuthError) {
        return page(502, 'Not linked', 'GitHub did not complete the authorization. Ask Snapwing for a new link to try again.', clearCookie);
      }
      throw e;
    }
    await store({ workspaceId, chat: payload.c, chatUserId: payload.u }, grant, user);
    return page(200, 'GitHub linked', `Snapwing is linked to GitHub as @${user.login}. You can close this tab.`, clearCookie);
  }

  // Use --------------------------------------------------------------------------------------------

  function refreshable(identity: LinkedIdentity, at: number): boolean {
    return identity.refreshToken !== undefined && (identity.refreshTokenExpiresAt === undefined || Date.parse(identity.refreshTokenExpiresAt) > at);
  }

  async function freshToken(user: ChatUser, retried: boolean): Promise<UserToken | null> {
    const key = keyOf(user);
    const identity = await state.getLinkedIdentity(key);
    if (identity === null) return null;
    const sk = (await sealKeys()).seal;
    const at = now().getTime();
    const current = { githubLogin: identity.githubLogin, githubUserId: identity.githubUserId };
    if (identity.accessTokenExpiresAt === undefined || Date.parse(identity.accessTokenExpiresAt) - at > TOKEN_REFRESH_MARGIN_MS) {
      return { token: unseal(sk, identity.accessToken, sealContext(key, 'access_token')), ...current };
    }
    if (!refreshable(identity, at) || identity.refreshToken === undefined) {
      await state.unlinkIdentity(key);
      return null;
    }
    const { id, secret } = await client();
    let grant: TokenGrant;
    try {
      grant = await tokenRequest({
        client_id: id,
        client_secret: secret,
        grant_type: 'refresh_token',
        refresh_token: unseal(sk, identity.refreshToken, sealContext(key, 'refresh_token')),
      });
    } catch (e) {
      if (!(e instanceof GitHubOAuthError) || e.code !== 'bad_refresh_token') throw e;
      // Another process may have spent this refresh token first; its row then carries the new one.
      const again = await state.getLinkedIdentity(key);
      if (!retried && again !== null && again.refreshToken !== identity.refreshToken) return freshToken(user, true);
      if (again !== null && again.refreshToken === identity.refreshToken) await state.unlinkIdentity(key);
      return null;
    }
    await store(key, grant, { login: identity.githubLogin, id: identity.githubUserId });
    return { token: grant.accessToken, ...current };
  }

  return {
    routes: [
      { method: 'GET', path: START_PATH, handler: start },
      { method: 'GET', path: CALLBACK_PATH, handler: callback },
    ],

    async linkUrl(user) {
      if (user.userId === '') throw new Error('linkUrl: userId is empty');
      const token = await signState({
        v: 1,
        w: workspaceId,
        c: user.chat,
        u: user.userId,
        n: randomBytes(18).toString('base64url'),
        e: Math.floor(now().getTime() / 1000) + Math.ceil(ttlSec),
      });
      return `${await publicUrl()}${START_PATH}?state=${encodeURIComponent(token)}`;
    },

    getLinkedIdentity(user) {
      return state.getLinkedIdentity(keyOf(user));
    },

    async isLinked(user) {
      const identity = await state.getLinkedIdentity(keyOf(user));
      if (identity === null) return false;
      const at = now().getTime();
      return identity.accessTokenExpiresAt === undefined || Date.parse(identity.accessTokenExpiresAt) > at || refreshable(identity, at);
    },

    userToken(user) {
      const k = JSON.stringify([user.chat, user.userId]);
      const pending = inflight.get(k);
      if (pending !== undefined) return pending;
      const p = freshToken(user, false).finally(() => inflight.delete(k));
      inflight.set(k, p);
      return p;
    },

    unlink(user) {
      return state.unlinkIdentity(keyOf(user));
    },
  };
}
