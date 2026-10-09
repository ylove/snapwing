// What the GitHub App setup shares (main 14.4, 18; 22.2 step 3): the deps every command takes, the
// `.env.live` file the bootstrap script keeps, and one small GitHub REST client. The onboarding step
// and `scripts/github-bootstrap.ts` both build on it. A secret value is never logged here.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createEnvFileSecrets } from '@snapwing/pipeline/providers/local/secrets.ts';
import { SecretNotFoundError } from '@snapwing/pipeline/ports/secrets.ts';
import { GitHubApiError, errorMessage } from '../../github/auth.ts';
import { upsertEnv, writeFileAtomic } from '../interview/env.ts';

export { upsertEnv };

/** The repository the bootstrap commands use when none is given. */
export const DEFAULT_FIXTURE_REPO = 'ylove/snapwing-fixture-web';
export const REQUIRED_CHECK = 'snapwing/review';
export const ENV_FILE = '.env.live';
export const PEM_FILE = 'secrets/github-app.pem';
/** Inactive webhook URL sent when SNAPWING_PUBLIC_URL is unset; `webhook` replaces it. */
export const PLACEHOLDER_HOOK_URL = 'https://example.invalid/snapwing/webhooks/github';

/** What the manifest flow and the REST client need. */
export interface GitHubDeps {
  fetch: typeof fetch;
  log(line: string): void;
  openUrl(url: string): void;
  now(): Date;
  apiBase?: string;
  /** Where the manifest form posts. Default `https://github.com`. */
  webBase?: string;
}

export interface BootstrapDeps extends GitHubDeps {
  /** Runs `gh` with `args`, writing `input` to its stdin when given. Resolves with stdout; rejects on a non-zero exit. */
  gh(args: readonly string[], input?: string): Promise<string>;
  /** The snapwing repository root: `.env.live`, `secrets/`, and `fixtures/` live under it. */
  root: string;
  /** Environment fallback for `SNAPWING_PUBLIC_URL`. */
  env: Readonly<Record<string, string | undefined>>;
}

export const apiBase = (d: GitHubDeps): string => (d.apiBase ?? 'https://api.github.com').replace(/\/+$/, '');
export const webBase = (d: GitHubDeps): string => (d.webBase ?? 'https://github.com').replace(/\/+$/, '');

// ---------------------------------------------------------------------------------------------------------------------
// .env.live editing

async function readIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, 'utf8');
  } catch (e) {
    if (e instanceof Error && (e as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw e;
  }
}

export async function updateEnvFile(d: BootstrapDeps, entries: Readonly<Record<string, string>>): Promise<void> {
  const path = join(d.root, ENV_FILE);
  await writeFileAtomic(path, upsertEnv(await readIfExists(path), entries));
}

export function envSecrets(d: BootstrapDeps): ReturnType<typeof createEnvFileSecrets> {
  return createEnvFileSecrets({ path: join(d.root, ENV_FILE), fallbackEnv: {} });
}

/** `SNAPWING_PUBLIC_URL` from `.env.live`, else the environment, without a trailing slash; empty when unset. */
export async function readPublicUrl(d: BootstrapDeps): Promise<string> {
  let publicUrl = d.env['SNAPWING_PUBLIC_URL'] ?? '';
  try {
    publicUrl = await envSecrets(d).get('SNAPWING_PUBLIC_URL');
  } catch (e) {
    if (!(e instanceof SecretNotFoundError)) throw e;
  }
  return publicUrl.trim().replace(/\/+$/, '');
}

// ---------------------------------------------------------------------------------------------------------------------
// GitHub REST

export interface ApiResult {
  status: number;
  body: unknown;
}

export async function call(d: GitHubDeps, bearer: string, method: string, path: string, body?: unknown): Promise<ApiResult> {
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
export async function must(d: GitHubDeps, bearer: string, method: string, path: string, body?: unknown, allow: readonly number[] = []): Promise<ApiResult> {
  const r = await call(d, bearer, method, path, body);
  if ((r.status < 200 || r.status > 299) && !allow.includes(r.status)) throw new GitHubApiError(r.status, `${method} ${path}: ${messageOf(r.body)}`);
  return r;
}

export function messageOf(body: unknown): string {
  return isRecord(body) && typeof body['message'] === 'string' ? body['message'] : 'request failed';
}

export function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export function str(v: unknown, what: string): string {
  if (typeof v !== 'string' || v === '') throw new Error(`GitHub response had no ${what}`);
  return v;
}

export function splitRepo(repo: string): { owner: string; name: string } {
  const [owner, name, ...rest] = repo.split('/');
  if (owner === undefined || owner === '' || name === undefined || name === '' || rest.length > 0) throw new Error(`repo must be "owner/name", got "${repo}"`);
  return { owner, name };
}

export async function ghToken(d: BootstrapDeps): Promise<string> {
  const token = (await d.gh(['auth', 'token'])).trim();
  if (token === '') throw new Error('gh has no login: run `gh auth login` first');
  return token;
}
