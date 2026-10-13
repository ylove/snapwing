/**
 * The console's API client (main 20.3, #348). Every call goes to `/console/api/*` on the page's own
 * origin with the session cookie, and every answer passes a validator before a page sees it: a 2xx
 * body through the caller's validator, an error body only through the narrow reads below. The console
 * reaches the server over HTTP only; wire types come from `@snapwing/capture-client`, never the app.
 *
 * Nothing here throws for a server or network failure: a call resolves to `ApiResult`, and
 * `describeProblem` words each failure for a person, including how to get a sign-in link from chat on
 * a 401 and which role is needed on a 403 (#349 answers both as JSON naming only the role needed).
 */

import { validateQueueView, type QueueView, type Validation } from '@snapwing/capture-client/wire.ts';

/** Where the server mounts the console API (#355). Same origin as the page, whatever the host. */
export const API_BASE = '/console/api';

/** The roles a console route can need (#349): `engineer` for the queue and incidents, `admin` for corrections. */
export type Role = 'engineer' | 'admin';

export type ApiProblem =
  /** 401: no session, or it expired. */
  | { readonly kind: 'signed-out' }
  /** 403: signed in without the role this call needs. */
  | { readonly kind: 'forbidden'; readonly need: Role }
  | { readonly kind: 'not-found'; readonly message?: string }
  /** 409: the thing changed under the page (a decided proposal, a merge that needs a linked account). */
  | { readonly kind: 'conflict'; readonly message?: string }
  /** Any other non-2xx status. */
  | { readonly kind: 'failed'; readonly status: number; readonly message?: string }
  /** A 2xx whose body did not pass the validator. */
  | { readonly kind: 'invalid-response'; readonly error: string }
  /** The request never got an answer. */
  | { readonly kind: 'network' };

export type ApiResult<T> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly problem: ApiProblem };

export type Validator<T> = (input: unknown) => Validation<T>;

export interface RequestOptions<T> {
  readonly method?: 'GET' | 'POST';
  /** Sent as JSON. */
  readonly body?: unknown;
  /** The role the route needs, named on a 403 when the server's answer does not name one. */
  readonly need: Role;
  /** Checks a 2xx body (`undefined` for an empty one). */
  readonly validate: Validator<T>;
}

export interface ApiClient {
  /** `path` is under `API_BASE` and starts with `/`; encode each dynamic segment with `encodeURIComponent`. */
  request<T>(path: string, options: RequestOptions<T>): Promise<ApiResult<T>>;
  /** `GET /console/api/queue`: the viewer's queue (#352). */
  queue(): Promise<ApiResult<QueueView>>;
}

export interface ApiClientOptions {
  /** Defaults to the page's `fetch`. Tests pass a fake. */
  readonly fetch?: (input: string, init: RequestInit) => Promise<Response>;
}

/** Longest server message the console shows; anything longer is cut. */
const MESSAGE_MAX_CHARS = 300;

export function createApiClient(options: ApiClientOptions = {}): ApiClient {
  const doFetch = options.fetch ?? ((input: string, init: RequestInit) => globalThis.fetch(input, init));

  async function request<T>(path: string, req: RequestOptions<T>): Promise<ApiResult<T>> {
    assertApiPath(path);
    const method = req.method ?? 'GET';
    const headers: Record<string, string> = { Accept: 'application/json' };
    const init: RequestInit = { method, headers, credentials: 'same-origin', cache: 'no-store' };
    if (req.body !== undefined) {
      headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(req.body);
    }

    let res: Response;
    try {
      res = await doFetch(`${API_BASE}${path}`, init);
    } catch {
      return { ok: false, problem: { kind: 'network' } };
    }

    let body: unknown;
    let parsed = true;
    try {
      const text = await res.text();
      body = text.trim() === '' ? undefined : (JSON.parse(text) as unknown);
    } catch {
      parsed = false;
    }

    if (res.ok) {
      if (!parsed) return { ok: false, problem: { kind: 'invalid-response', error: 'the body is not JSON' } };
      const checked = req.validate(body);
      return checked.ok ? { ok: true, value: checked.value } : { ok: false, problem: { kind: 'invalid-response', error: checked.error } };
    }
    return { ok: false, problem: problemFor(res.status, parsed ? body : undefined, req.need) };
  }

  return {
    request,
    queue: () => request(CONSOLE_API.queue, { need: 'engineer', validate: validateQueueView }),
  };
}

/** The console API's paths under `API_BASE`, so pages and tests cannot drift. */
export const CONSOLE_API = {
  queue: '/queue',
} as const;

function assertApiPath(path: string): void {
  if (!path.startsWith('/') || path.includes('//') || path.split(/[/?#]/).some((s) => s === '..' || s === '.')) {
    throw new TypeError(`not a console API path: ${path}`);
  }
}

function problemFor(status: number, body: unknown, need: Role): ApiProblem {
  const message = messageOf(body);
  const withMessage = message === undefined ? {} : { message };
  switch (status) {
    case 401:
      return { kind: 'signed-out' };
    case 403:
      return { kind: 'forbidden', need: roleOf(body) ?? need };
    case 404:
      return { kind: 'not-found', ...withMessage };
    case 409:
      return { kind: 'conflict', ...withMessage };
    default:
      return { kind: 'failed', status, ...withMessage };
  }
}

function isRecord(v: unknown): v is Readonly<Record<string, unknown>> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The role a 403 names (`{ "need": "admin" }`), when it names one the console knows. */
function roleOf(body: unknown): Role | undefined {
  if (!isRecord(body)) return undefined;
  const need = body['need'];
  return need === 'engineer' || need === 'admin' ? need : undefined;
}

/** A short plain-text `message` (else `error`) from an error body, when there is one. */
function messageOf(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const raw = typeof body['message'] === 'string' ? body['message'] : body['error'];
  if (typeof raw !== 'string') return undefined;
  const flat = raw.replace(/\s+/g, ' ').trim();
  if (flat === '') return undefined;
  return flat.length > MESSAGE_MAX_CHARS ? `${flat.slice(0, MESSAGE_MAX_CHARS - 3)}...` : flat;
}

export interface ProblemText {
  readonly title: string;
  readonly lines: readonly string[];
}

const ROLE_TEXT: Readonly<Record<Role, { readonly title: string; readonly line: string }>> = {
  engineer: {
    title: 'Engineer role needed',
    line: 'You are signed in, but this page needs the engineer role in the workspace map.',
  },
  admin: {
    title: 'Admin role needed',
    line: 'You are signed in, but this page needs the admin role: an engineer with the admin flag in the workspace map.',
  },
};

/** How the console words a failed call. Pure, so the wording is tested without a page. */
export function describeProblem(problem: ApiProblem): ProblemText {
  switch (problem.kind) {
    case 'signed-out':
      return {
        title: 'Sign in from chat',
        lines: [
          'The console signs you in with a one-time link that Snapwing gives you in chat.',
          "In Slack, open Snapwing's Home tab and choose Open console.",
          'In Teams, send queue to Snapwing and choose Open console on the queue card.',
          'Each link works once and expires after a few minutes, so open a fresh one each time.',
        ],
      };
    case 'forbidden':
      return {
        title: ROLE_TEXT[problem.need].title,
        lines: [ROLE_TEXT[problem.need].line, 'If you should have it, ask whoever keeps the workspace map to update your entry.'],
      };
    case 'not-found':
      return { title: 'Not found', lines: [problem.message ?? 'Snapwing has nothing at this address.'] };
    case 'conflict':
      return {
        title: 'Something changed',
        lines: [problem.message ?? 'This changed since the page loaded. Reload the page and try again.'],
      };
    case 'failed':
      return {
        title: 'Something went wrong',
        lines: [problem.message ?? `The server answered with status ${problem.status}. Try again in a moment.`],
      };
    case 'invalid-response':
      return {
        title: 'Unexpected answer from the server',
        lines: [
          `The server's answer did not have the expected shape: ${problem.error}.`,
          'The console and the server may be on different versions. Reload the page.',
        ],
      };
    case 'network':
      return { title: 'Could not reach Snapwing', lines: ['Check your connection and try again.'] };
  }
}
