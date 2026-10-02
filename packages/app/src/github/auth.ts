// GitHub App authentication (main 10.2, 16): an RS256 app JWT from GITHUB_APP_ID and GITHUB_APP_PRIVATE_KEY,
// exchanged for installation tokens scoped to one repository and a permission subset. fetch and node:crypto
// only. A token or the private key is never logged and never put in an error message.

import { createSign } from 'node:crypto';
import type { SecretsPort } from '@snapwing/pipeline/ports/secrets.ts';

export type GitHubPermissionLevel = 'read' | 'write' | 'admin';
/** Permission name (`contents`, `pull_requests`, ...) to level, as GitHub's access_tokens endpoint takes it. */
export type GitHubPermissions = Readonly<Record<string, GitHubPermissionLevel>>;

export interface InstallationTokenRequest {
  /** `owner/name`. The token is scoped to this one repository. */
  repo: string;
  permissions: GitHubPermissions;
}

export interface InstallationToken {
  token: string;
  /** ISO 8601, as GitHub returns it. */
  expiresAt: string;
}

export interface GitHubAuth {
  /** Returns a cached token while it has more than 5 minutes left, otherwise mints a new one. */
  installationToken(request: InstallationTokenRequest): Promise<InstallationToken>;
}

export interface GitHubAuthOptions {
  secrets: SecretsPort;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Default `https://api.github.com`. */
  apiBase?: string;
}

/** `iat` is this far in the past to absorb clock drift (GitHub's own advice). */
export const JWT_IAT_SKEW_SECONDS = 60;
/** GitHub rejects an `exp` more than 10 minutes out; 9 leaves room. */
export const JWT_LIFETIME_SECONDS = 9 * 60;
export const TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

/** A GitHub API call failed. Carries the status and GitHub's message, never a credential. */
export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API ${status}: ${message}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

function base64url(input: Buffer | string): string {
  return Buffer.from(input).toString('base64url');
}

/** Env files often carry PEM keys on one line with literal `\n`; restore the newlines. */
export function normalizePem(raw: string): string {
  return raw.includes('\\n') && !raw.includes('\n') ? raw.replaceAll('\\n', '\n') : raw;
}

/** `exp` is 9 minutes after now, `iat` 60 s before it (so the span is 10 minutes, GitHub's maximum, from `iat`). */
export function signAppJwt(appId: string, privateKeyPem: string, now: Date): string {
  const nowSec = Math.floor(now.getTime() / 1000);
  const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = base64url(JSON.stringify({ iat: nowSec - JWT_IAT_SKEW_SECONDS, exp: nowSec + JWT_LIFETIME_SECONDS, iss: appId }));
  const signature = createSign('RSA-SHA256').update(`${header}.${payload}`).sign(normalizePem(privateKeyPem));
  return `${header}.${payload}.${base64url(signature)}`;
}

export async function errorMessage(res: Response): Promise<string> {
  try {
    const body: unknown = await res.json();
    if (typeof body === 'object' && body !== null && 'message' in body && typeof body.message === 'string') return body.message;
  } catch {
    // fall through
  }
  return res.statusText || 'request failed';
}

function cacheKey(request: InstallationTokenRequest): string {
  const perms = Object.entries(request.permissions).sort(([a], [b]) => a.localeCompare(b));
  return JSON.stringify([request.repo, perms]);
}

export function createGitHubAuth(options: GitHubAuthOptions): GitHubAuth {
  const doFetch = options.fetch ?? fetch;
  const now = options.now ?? (() => new Date());
  const base = (options.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
  const cache = new Map<string, InstallationToken>();
  const inflight = new Map<string, Promise<InstallationToken>>();

  async function mint(request: InstallationTokenRequest): Promise<InstallationToken> {
    const slash = request.repo.indexOf('/');
    const name = request.repo.slice(slash + 1);
    if (slash <= 0 || name === '' || name.includes('/')) throw new Error(`repo must be "owner/name", got "${request.repo}"`);
    const [appId, privateKey, installationId] = await Promise.all([
      options.secrets.get('GITHUB_APP_ID'),
      options.secrets.get('GITHUB_APP_PRIVATE_KEY'),
      options.secrets.get('GITHUB_INSTALLATION_ID'),
    ]);
    const jwt = signAppJwt(appId.trim(), privateKey, now());
    const res = await doFetch(`${base}/app/installations/${encodeURIComponent(installationId.trim())}/access_tokens`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${jwt}`,
        Accept: 'application/vnd.github+json',
        'X-GitHub-Api-Version': '2022-11-28',
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ repositories: [name], permissions: request.permissions }),
    });
    if (!res.ok) throw new GitHubApiError(res.status, await errorMessage(res));
    const body: unknown = await res.json();
    if (typeof body !== 'object' || body === null || !('token' in body) || !('expires_at' in body) || typeof body.token !== 'string' || typeof body.expires_at !== 'string') {
      throw new GitHubApiError(res.status, 'access_tokens response had no token or expires_at');
    }
    return { token: body.token, expiresAt: body.expires_at };
  }

  return {
    async installationToken(request) {
      const key = cacheKey(request);
      const cached = cache.get(key);
      if (cached !== undefined && Date.parse(cached.expiresAt) - now().getTime() > TOKEN_REFRESH_MARGIN_MS) return cached;
      const pending = inflight.get(key);
      if (pending !== undefined) return pending;
      const p = mint(request)
        .then((t) => {
          cache.set(key, t);
          return t;
        })
        .finally(() => inflight.delete(key));
      inflight.set(key, p);
      return p;
    },
  };
}
