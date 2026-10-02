// src/model-proxy/routes.ts: the server's model proxy (ADR 0017, amendment 1), as web-standard
// handlers (ADR 0016). A fixer or review container runs untrusted code next to its coding agent, so no
// model provider key may enter it. The docker runner points each CLI's base URL here
// (`ANTHROPIC_BASE_URL`, `OPENAI_BASE_URL`, `GOOGLE_GEMINI_BASE_URL`) and gives it a per-run model
// token (`issueModelToken`) as its API key; the proxy checks that token, replaces it with the real
// key, and forwards the call.
//
//   POST /model/{workItemId}/anthropic/v1/messages                      -> api.anthropic.com
//   POST /model/{workItemId}/anthropic/v1/messages/count_tokens
//   POST /model/{workItemId}/openai/v1/responses                        -> api.openai.com
//   POST /model/{workItemId}/openai/v1/chat/completions
//   POST /model/{workItemId}/google/v1beta/models/{model}:{method}      -> generativelanguage.googleapis.com
//        ({method} one of generateContent, streamGenerateContent, countTokens)
//
// Only these generation endpoints exist, so a token cannot list keys, upload files, start batches, or
// reach anything else of a provider account. Routes are mounted only for providers with a key. The
// token comes from whichever header the CLI uses (`x-api-key`, `Authorization: Bearer`,
// `x-goog-api-key`, or Gemini's `key` query parameter); none of them is forwarded. Status codes: 401
// (missing, malformed, forged, or expired token), 403 (token for another work item), 404 (unknown
// model method), 429 (the run used its request cap), 502 (the provider could not be reached),
// otherwise the provider's own status and body. Responses never echo the token or the key.

import type { ModelTokenVerifier } from './token.ts';

export const MODEL_PROXY_PREFIX = '/model';
/** Requests one run may make through the proxy; a runaway loop stops here. */
export const DEFAULT_MAX_REQUESTS_PER_RUN = 1000;

export type ModelProxyProvider = 'anthropic' | 'openai' | 'google';

export interface ModelProviderUpstream {
  /** The provider key, from the secrets port; it never leaves this process except to the provider. */
  apiKey: string;
  /** Default the provider's public API origin. */
  baseUrl?: string;
}

export interface ModelProxyOptions {
  verify: ModelTokenVerifier;
  /** One entry per provider with a key; a provider left out has no routes. */
  providers: Partial<Record<ModelProxyProvider, ModelProviderUpstream>>;
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Default `DEFAULT_MAX_REQUESTS_PER_RUN`. */
  maxRequestsPerRun?: number;
  /** For pruning the per-run counters. Default the system clock. */
  clock?: () => Date;
}

export interface ModelProxyRouteContext {
  readonly params: Readonly<Record<string, string>>;
}

/** Structurally a `Route` of the API server (ADR 0016). */
export interface ModelProxyRoute {
  readonly method: 'POST';
  readonly path: string;
  readonly handler: (req: Request, ctx?: ModelProxyRouteContext) => Promise<Response>;
}

const DEFAULT_ORIGIN: Record<ModelProxyProvider, string> = {
  anthropic: 'https://api.anthropic.com',
  openai: 'https://api.openai.com',
  google: 'https://generativelanguage.googleapis.com',
};

const ENDPOINTS: Record<ModelProxyProvider, readonly string[]> = {
  anthropic: ['/v1/messages', '/v1/messages/count_tokens'],
  openai: ['/v1/responses', '/v1/chat/completions'],
  google: ['/v1beta/models/:call'],
};

const GEMINI_CALL = /^[A-Za-z0-9._-]+:(generateContent|streamGenerateContent|countTokens)$/;

/** Request headers passed to the provider; everything else (every credential header) is dropped. */
const FORWARD_REQUEST = ['content-type', 'accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent'];
/** Response headers passed back. */
const FORWARD_RESPONSE = ['content-type', 'retry-after', 'request-id', 'x-request-id'];

export function createModelProxyRoutes(options: ModelProxyOptions): ModelProxyRoute[] {
  const doFetch = options.fetch ?? fetch;
  const cap = options.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN;
  const clock = options.clock ?? (() => new Date());
  const used = new Map<string, { count: number; expiresAt: number }>();

  const routes: ModelProxyRoute[] = [];
  for (const provider of ['anthropic', 'openai', 'google'] as const) {
    const upstream = options.providers[provider];
    if (upstream === undefined || upstream.apiKey === '') continue;
    const origin = (upstream.baseUrl ?? DEFAULT_ORIGIN[provider]).replace(/\/+$/, '');
    for (const endpoint of ENDPOINTS[provider]) {
      routes.push({
        method: 'POST',
        path: `${MODEL_PROXY_PREFIX}/:workItemId/${provider}${endpoint}`,
        handler: async (req, ctx) => {
          const workItemId = ctx?.params['workItemId'] ?? '';
          const token = presentedToken(req);
          if (token === undefined) return json(401, { error: 'missing-token' });
          const verified = options.verify(token, workItemId);
          if (!verified.ok) return json(verified.reason === 'wrong-work-item' ? 403 : 401, { error: verified.reason });

          let path = endpoint;
          if (provider === 'google') {
            const call = ctx?.params['call'] ?? '';
            if (!GEMINI_CALL.test(call)) return json(404, { error: 'unknown-model-method' });
            path = `/v1beta/models/${encodeURIComponent(call).replaceAll('%3A', ':')}`;
          }

          const now = clock().getTime();
          for (const [run, entry] of used) if (entry.expiresAt <= now) used.delete(run);
          const entry = used.get(verified.claims.runId) ?? { count: 0, expiresAt: verified.claims.expiresAt.getTime() };
          if (entry.count >= cap) return json(429, { error: 'run-request-cap' });
          entry.count += 1;
          used.set(verified.claims.runId, entry);

          const url = new URL(`${origin}${path}`);
          for (const [k, v] of new URL(req.url).searchParams) if (k !== 'key') url.searchParams.append(k, v);
          const headers = new Headers();
          for (const name of FORWARD_REQUEST) {
            const v = req.headers.get(name);
            if (v !== null) headers.set(name, v);
          }
          setKey(headers, provider, upstream.apiKey);

          let res: Response;
          try {
            res = await doFetch(url, { method: 'POST', headers, body: await req.arrayBuffer() });
          } catch {
            return json(502, { error: 'provider-unreachable' });
          }
          const out = new Headers();
          for (const name of FORWARD_RESPONSE) {
            const v = res.headers.get(name);
            if (v !== null) out.set(name, v);
          }
          return new Response(res.body, { status: res.status, headers: out });
        },
      });
    }
  }
  return routes;
}

/** The token from whichever header or parameter the CLI put its API key in. */
function presentedToken(req: Request): string | undefined {
  const bearer = /^Bearer\s+(\S+)$/i.exec(req.headers.get('authorization') ?? '')?.[1];
  const candidates = [req.headers.get('x-api-key'), bearer, req.headers.get('x-goog-api-key'), new URL(req.url).searchParams.get('key')];
  return candidates.find((c): c is string => typeof c === 'string' && c !== '');
}

function setKey(headers: Headers, provider: ModelProxyProvider, key: string): void {
  if (provider === 'anthropic') headers.set('x-api-key', key);
  else if (provider === 'openai') headers.set('authorization', `Bearer ${key}`);
  else headers.set('x-goog-api-key', key);
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
}
