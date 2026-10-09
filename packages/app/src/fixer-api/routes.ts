// src/fixer-api/routes.ts: the fixer reporting API over HTTP (B 9), as web-standard handlers
// (`(req: Request) => Promise<Response>`, ADR 0016), so they test without a server.
//
//   POST /fixer/{workItemId}/checkpoint   { phase, detail }
//   POST /fixer/{workItemId}/artifact     { kind, body, contentType? }
//   POST /fixer/{workItemId}/done         { summary, testsAdded }: the work is committed and bundled;
//                                         the server pushes it and opens the pull request (#262)
//   POST /fixer/{workItemId}/failed       { reason, partialBranch?, attempts }
//   GET  /fixer/{workItemId}/stop         204 when a stop is pending, else 200 { stop: false }
//
// Every call carries `Authorization: Bearer <token>` from `issueFixerToken` for that work item; the
// token names the incident and the run (#273). Status codes: 200 (appended; JSON `{ seq }`, plus
// `artifact` for an artifact), 400 (body is not JSON or fails validation, nothing appended), 401
// (missing, malformed, forged, expired, or revoked token: the run ended or was stopped), 403 (token for
// another work item), 404 (no such incident), 413 (the run has written its share of artifacts, by count
// or bytes, `DEFAULT_ARTIFACT_LIMITS`), 409 (the run
// already finished or the incident is closed, nothing appended; the fixer should end; or, for `done`,
// `{ error: 'handoff-refused', reason }`: the server refused the handed-back work, recorded nothing,
// and the fixer should report `failed`). A fixer should treat any other 409 like a stop. Responses
// never echo the fixer token or the request body, and none carries a credential: no route hands a
// container any GitHub token (#262).

import type { ArtifactLimits, RunCredentialsPort } from '@snapwing/pipeline/state/run-credentials.ts';
import type { FixerReporter, FixerTarget, FixerRefusal } from './reporter.ts';
import type { FixerTokenVerifier } from './token.ts';
import type { FixerInputError } from './validate.ts';

export type FixerOperation = 'checkpoint' | 'artifact' | 'done' | 'failed' | 'stop';

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

/** What one run may write through `artifact` (#273): every version counts, by number and by request bytes. */
export const DEFAULT_ARTIFACT_LIMITS: ArtifactLimits = { maxArtifacts: 20, maxBytes: 4 * 1024 * 1024 };

export interface FixerRouteOptions {
  /** Revocation and the per-run artifact caps (#273); compose passes the state store. Absent: neither is checked. */
  credentials?: Pick<RunCredentialsPort, 'runCredentialsRevoked' | 'reserveArtifact'>;
  /** Default `DEFAULT_ARTIFACT_LIMITS`. */
  artifactLimits?: ArtifactLimits;
}

export function createFixerRoutes(reporter: FixerReporter, verify: FixerTokenVerifier, options: FixerRouteOptions = {}): FixerRoute[] {
  const { credentials } = options;
  const post = (op: Exclude<FixerOperation, 'stop'>): FixerRoute => ({
    method: 'POST',
    path: `${FIXER_ROUTE_PREFIX}/:workItemId/${op}`,
    handler: (req, ctx) =>
      withTarget(req, ctx, op, verify, credentials, async (target) => {
        const text = await req.text();
        const body = parseJson(text);
        if (!body.ok) return json(400, { error: 'invalid-json' });
        switch (op) {
          case 'checkpoint':
            return reply(await reporter.checkpoint(target, body.value));
          case 'artifact': {
            if (credentials !== undefined && target.runId !== undefined) {
              const reserved = await credentials.reserveArtifact(target.runId, Buffer.byteLength(text, 'utf8'), options.artifactLimits ?? DEFAULT_ARTIFACT_LIMITS);
              if (!reserved.ok) return reserved.reason === 'revoked' ? unauthorized('revoked') : json(413, { error: 'artifact-cap' });
            }
            const r = await reporter.artifact(target, body.value);
            return r.ok ? json(200, { seq: r.seq, artifact: r.artifact }) : reply(r);
          }
          case 'done': {
            const r = await reporter.done(target, body.value);
            if (r.ok) return reply(r);
            return r.code === 'handoff-refused' ? json(409, { error: r.code, reason: r.reason }) : reply(r);
          }
          case 'failed':
            return reply(await reporter.failed(target, body.value));
        }
      }),
  });

  const stop: FixerRoute = {
    method: 'GET',
    path: `${FIXER_ROUTE_PREFIX}/:workItemId/stop`,
    handler: (req, ctx) =>
      withTarget(req, ctx, 'stop', verify, credentials, async (target) => {
        const r = await reporter.stop(target);
        if (!r.ok) return refused(r.code);
        return r.stop ? new Response(null, { status: 204, headers: NO_STORE }) : json(200, { stop: false });
      }),
  };

  return [post('checkpoint'), post('artifact'), post('done'), post('failed'), stop];
}

// Private ----------------------------------------------------------------------------------------

const NO_STORE = { 'cache-control': 'no-store' } as const;

async function withTarget(
  req: Request,
  ctx: FixerRouteContext | undefined,
  op: FixerOperation,
  verify: FixerTokenVerifier,
  credentials: FixerRouteOptions['credentials'],
  fn: (target: FixerTarget) => Promise<Response>,
): Promise<Response> {
  const workItemId = ctx?.params['workItemId'] ?? workItemFromPath(req.url, op);
  if (workItemId === undefined || workItemId === '') return json(404, { error: 'not-found' });
  const token = bearer(req.headers.get('authorization'));
  if (token === undefined) return unauthorized('missing-token');
  const v = verify(token, workItemId);
  if (!v.ok) return v.reason === 'wrong-work-item' ? json(403, { error: 'forbidden' }) : unauthorized(v.reason);
  if (credentials !== undefined && (await credentials.runCredentialsRevoked(v.claims.runId))) return unauthorized('revoked');
  return fn({ workItemId, incidentId: v.claims.incidentId, runId: v.claims.runId });
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

function parseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(text) as unknown };
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
