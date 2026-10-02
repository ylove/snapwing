// src/fixer-api/routes.ts: the fixer reporting API over HTTP (B 9), as web-standard handlers
// (`(req: Request) => Promise<Response>`, ADR 0016), so they test without a server.
//
//   POST /fixer/{workItemId}/checkpoint   { phase, detail }
//   POST /fixer/{workItemId}/artifact     { kind, body, contentType? }
//   POST /fixer/{workItemId}/done         { prNumber, branch, summary, testsAdded }
//   POST /fixer/{workItemId}/failed       { reason, partialBranch?, attempts }
//   GET  /fixer/{workItemId}/stop         204 when a stop is pending, else 200 { stop: false }
//   GET  /fixer/{workItemId}/git-token    200 { token, expiresAt }: a fresh installation token for the
//                                         incident's repository (git-token.ts, #266); mounted only
//                                         with `options.gitToken` (the docker runner)
//
// Every call carries `Authorization: Bearer <token>` from `issueFixerToken` for that work item; the
// token names the incident. Status codes: 200 (appended; JSON `{ seq }`, plus `artifact` for an
// artifact), 400 (body is not JSON or fails validation, nothing appended), 401 (missing, malformed,
// forged, or expired token), 403 (token for another work item), 404 (no such incident), 409 (the run
// already finished or the incident is closed, nothing appended; the fixer should end), 502 (git-token
// only: no token could be minted). A fixer should treat 409 like a stop. Responses never echo the
// fixer token or the request body; only the git-token answer carries a credential, marked `no-store`.

import type { FixerGitTokenSource } from './git-token.ts';
import type { FixerReporter, FixerTarget, FixerRefusal } from './reporter.ts';
import type { FixerTokenVerifier } from './token.ts';
import type { FixerInputError } from './validate.ts';

export type FixerOperation = 'checkpoint' | 'artifact' | 'done' | 'failed' | 'stop' | 'git-token';

export interface FixerRouteOptions {
  /** Serves `GET /fixer/{workItemId}/git-token` (#266). Absent: the route is not mounted. */
  gitToken?: FixerGitTokenSource;
}

export interface FixerRouteContext {
  readonly params: Readonly<Record<string, string>>;
}

/** Structurally a `Route` of the API server (ADR 0016). */
export interface FixerRoute {
  readonly method: 'GET' | 'POST';
  readonly path: string;
  readonly handler: (req: Request, ctx?: FixerRouteContext) => Promise<Response>;
}

export const FIXER_ROUTE_PREFIX = '/fixer';

export function createFixerRoutes(reporter: FixerReporter, verify: FixerTokenVerifier, options: FixerRouteOptions = {}): FixerRoute[] {
  const post = (op: Exclude<FixerOperation, 'stop' | 'git-token'>): FixerRoute => ({
    method: 'POST',
    path: `${FIXER_ROUTE_PREFIX}/:workItemId/${op}`,
    handler: (req, ctx) =>
      withTarget(req, ctx, op, verify, async (target) => {
        const body = await readJson(req);
        if (!body.ok) return json(400, { error: 'invalid-json' });
        switch (op) {
          case 'checkpoint':
            return reply(await reporter.checkpoint(target, body.value));
          case 'artifact': {
            const r = await reporter.artifact(target, body.value);
            return r.ok ? json(200, { seq: r.seq, artifact: r.artifact }) : reply(r);
          }
          case 'done':
            return reply(await reporter.done(target, body.value));
          case 'failed':
            return reply(await reporter.failed(target, body.value));
        }
      }),
  });

  const stop: FixerRoute = {
    method: 'GET',
    path: `${FIXER_ROUTE_PREFIX}/:workItemId/stop`,
    handler: (req, ctx) =>
      withTarget(req, ctx, 'stop', verify, async (target) => {
        const r = await reporter.stop(target);
        if (!r.ok) return refused(r.code);
        return r.stop ? new Response(null, { status: 204, headers: NO_STORE }) : json(200, { stop: false });
      }),
  };

  const routes = [post('checkpoint'), post('artifact'), post('done'), post('failed'), stop];
  const source = options.gitToken;
  if (source !== undefined) {
    routes.push({
      method: 'GET',
      path: `${FIXER_ROUTE_PREFIX}/:workItemId/git-token`,
      handler: (req, ctx) =>
        withTarget(req, ctx, 'git-token', verify, async (target) => {
          const r = await source(target);
          if (r.ok) return json(200, { token: r.token, expiresAt: r.expiresAt });
          if (r.code === 'mint-failed') return json(502, { error: 'git-token-unavailable' });
          if (r.code === 'no-repo') return json(409, { error: 'no-repo' });
          return refused(r.code);
        }),
    });
  }
  return routes;
}

// Private ----------------------------------------------------------------------------------------

const NO_STORE = { 'cache-control': 'no-store' } as const;

async function withTarget(
  req: Request,
  ctx: FixerRouteContext | undefined,
  op: FixerOperation,
  verify: FixerTokenVerifier,
  fn: (target: FixerTarget) => Promise<Response>,
): Promise<Response> {
  const workItemId = ctx?.params['workItemId'] ?? workItemFromPath(req.url, op);
  if (workItemId === undefined || workItemId === '') return json(404, { error: 'not-found' });
  const token = bearer(req.headers.get('authorization'));
  if (token === undefined) return unauthorized('missing-token');
  const v = verify(token, workItemId);
  if (!v.ok) return v.reason === 'wrong-work-item' ? json(403, { error: 'forbidden' }) : unauthorized(v.reason);
  return fn({ workItemId, incidentId: v.claims.incidentId });
}

/** `/fixer/{id}/{op}` at the end of the path, for a caller that passes no route params. */
function workItemFromPath(url: string, op: FixerOperation): string | undefined {
  const parts = new URL(url).pathname.split('/').filter((p) => p !== '');
  const n = parts.length;
  if (n < 3 || parts[n - 1] !== op || parts[n - 3] !== FIXER_ROUTE_PREFIX.slice(1)) return undefined;
  try {
    return decodeURIComponent(parts[n - 2] ?? '');
  } catch {
    return undefined;
  }
}

function bearer(header: string | null): string | undefined {
  const m = header === null ? null : /^Bearer\s+(\S+)\s*$/i.exec(header);
  return m?.[1];
}

async function readJson(req: Request): Promise<{ ok: true; value: unknown } | { ok: false }> {
  try {
    return { ok: true, value: JSON.parse(await req.text()) as unknown };
  } catch {
    return { ok: false };
  }
}

type Refused = { ok: false; code: 'invalid'; error: FixerInputError } | { ok: false; code: FixerRefusal };

function reply(r: { ok: true; seq: number } | Refused): Response {
  if (r.ok) return json(200, { seq: r.seq });
  if (r.code === 'invalid') return json(400, { error: 'invalid', field: r.error.field, message: r.error.message });
  return refused(r.code);
}

function refused(code: FixerRefusal): Response {
  return json(code === 'unknown-incident' ? 404 : 409, { error: code });
}

function unauthorized(reason: string): Response {
  return new Response(JSON.stringify({ error: 'unauthorized', reason }), {
    status: 401,
    headers: { 'content-type': 'application/json', 'www-authenticate': 'Bearer', ...NO_STORE },
  });
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...NO_STORE } });
}
