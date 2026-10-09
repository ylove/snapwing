// src/model-proxy/routes.ts: the server's model proxy (ADR 0017, amendment 1), as web-standard
// handlers (ADR 0016). A fixer or review container runs untrusted code next to its coding agent, so no
// model provider key may enter it. The container's wrapper holds a per-run model token
// (`issueModelToken`) and forwards each CLI call here (infra/docker/fixer/wrapper.ts); the proxy checks
// that token, replaces it with the real key, and forwards the call.
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
// token comes from whichever header the caller uses (`x-api-key`, `Authorization: Bearer`,
// `x-goog-api-key`, or Gemini's `key` query parameter); none of them is forwarded.
//
// What a token may spend (#273): its claims name one provider, one model, and the largest `max_tokens`
// one call may ask for, all from the harness config. A call to another provider's routes is refused.
// The body must be a JSON object; the proxy sets its model to the token's (for Gemini, the model in the
// path) and lowers any larger output limit to the cap (`max_tokens`, `max_output_tokens`,
// `max_completion_tokens`, `generationConfig.maxOutputTokens`), setting it when absent, and asks an
// OpenAI chat stream to report its usage. Each call is counted against the run in the state store
// before it is forwarded (`reserveModelRequest`: refused once the run is revoked, has made
// `maxRequestsPerRun` calls, or has spent `maxTokensPerRun` tokens), and the input and output tokens
// the provider reports are added to the run's counters as the response streams back (usage.ts). The
// counters live in the state store, so they hold across processes and restarts.
//
// Status codes: 400 (the body is not a JSON object), 401 (missing, malformed, forged, expired, or
// revoked token: its run ended or was stopped), 403 (token for another work item or another provider),
// 404 (unknown model method), 429 (the run used its request or token cap), 502 (the provider could not
// be reached), otherwise the provider's own status and body. Responses never echo the token or the key.

import type { ModelRequestLimits, RunCredentialsPort } from '@snapwing/pipeline/state/run-credentials.ts';
import type { ModelGrant, ModelTokenVerifier } from './token.ts';
import { isObject, meterResponse } from './usage.ts';

export const MODEL_PROXY_PREFIX = '/model';
/** Requests one run may make through the proxy; a runaway loop stops here. */
export const DEFAULT_MAX_REQUESTS_PER_RUN = 1000;
/** Tokens (input, cache reads included, plus output) one run may spend through the proxy. */
export const DEFAULT_MAX_TOKENS_PER_RUN = 50_000_000;

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
  /** Revocation and the persisted per-run counters (the state store). */
  credentials: Pick<RunCredentialsPort, 'reserveModelRequest' | 'recordModelTokens'>;
  /** Default the global `fetch`. */
  fetch?: typeof fetch;
  /** Default `DEFAULT_MAX_REQUESTS_PER_RUN`. */
  maxRequestsPerRun?: number;
  /** Default `DEFAULT_MAX_TOKENS_PER_RUN`. */
  maxTokensPerRun?: number;
  /** A usage that could not be recorded. Never given a token. */
  onError?: (e: unknown) => void;
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
const FORWARD_REQUEST = ['accept', 'anthropic-version', 'anthropic-beta', 'openai-beta', 'user-agent'];
/** Response headers passed back. */
const FORWARD_RESPONSE = ['content-type', 'retry-after', 'request-id', 'x-request-id'];

export function createModelProxyRoutes(options: ModelProxyOptions): ModelProxyRoute[] {
  const doFetch = options.fetch ?? fetch;
  const limits: ModelRequestLimits = { maxRequests: options.maxRequestsPerRun ?? DEFAULT_MAX_REQUESTS_PER_RUN, maxTokens: options.maxTokensPerRun ?? DEFAULT_MAX_TOKENS_PER_RUN };
  const onError = options.onError ?? (() => undefined);

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
          const grant = verified.claims;
          if (grant.provider !== provider) return json(403, { error: 'wrong-provider' });

          let path = endpoint;
          let method = '';
          if (provider === 'google') {
            const call = ctx?.params['call'] ?? '';
            if (!GEMINI_CALL.test(call)) return json(404, { error: 'unknown-model-method' });
            method = call.slice(call.lastIndexOf(':') + 1);
            path = `/v1beta/models/${encodeURIComponent(grant.model)}:${method}`;
          }
          let body: unknown;
          try {
            body = JSON.parse(await req.text()) as unknown;
          } catch {
            body = undefined;
          }
          if (!isObject(body)) return json(400, { error: 'invalid-body' });
          pin(provider, endpoint, method, body, grant);

          const reserved = await options.credentials.reserveModelRequest(grant.runId, limits);
          if (!reserved.ok) return reserved.reason === 'revoked' ? json(401, { error: 'revoked' }) : json(429, { error: `run-${reserved.reason}` });

          const url = new URL(`${origin}${path}`);
          for (const [k, v] of new URL(req.url).searchParams) if (k !== 'key') url.searchParams.append(k, v);
          const headers = new Headers({ 'content-type': 'application/json' });
          for (const name of FORWARD_REQUEST) {
            const v = req.headers.get(name);
            if (v !== null) headers.set(name, v);
          }
          setKey(headers, provider, upstream.apiKey);

          let res: Response;
          try {
            res = await doFetch(url, { method: 'POST', headers, body: JSON.stringify(body) });
          } catch {
            return json(502, { error: 'provider-unreachable' });
          }
          const out = new Headers();
          for (const name of FORWARD_RESPONSE) {
            const v = res.headers.get(name);
            if (v !== null) out.set(name, v);
          }
          if (res.body === null) return new Response(null, { status: res.status, headers: out });
          const metered = meterResponse(res.body, provider, res.headers.get('content-type') ?? '', (usage) => {
            options.credentials.recordModelTokens(grant.runId, usage.input, usage.output).catch(onError);
          });
          return new Response(metered, { status: res.status, headers: out });
        },
      });
    }
  }
  return routes;
}

/** The token's model, and its cap on any output limit (set when the caller set none). */
function pin(provider: ModelProxyProvider, endpoint: string, method: string, body: Record<string, unknown>, grant: ModelGrant): void {
  const cap = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) && v >= 1 ? Math.min(Math.floor(v), grant.maxTokens) : grant.maxTokens);
  if (provider === 'google') {
    if (method === 'countTokens') return;
    const config = isObject(body['generationConfig']) ? body['generationConfig'] : {};
    config['maxOutputTokens'] = cap(config['maxOutputTokens']);
    body['generationConfig'] = config;
    return;
  }
  body['model'] = grant.model;
  if (endpoint === '/v1/messages') {
    const max = cap(body['max_tokens']);
    body['max_tokens'] = max;
    // A thinking budget must stay under max_tokens, or the provider refuses the call.
    const thinking = body['thinking'];
    if (isObject(thinking) && typeof thinking['budget_tokens'] === 'number' && thinking['budget_tokens'] >= max) thinking['budget_tokens'] = Math.max(1, max - 1);
  } else if (endpoint === '/v1/responses') {
    body['max_output_tokens'] = cap(body['max_output_tokens']);
  } else if (endpoint === '/v1/chat/completions') {
    body['max_completion_tokens'] = cap(body['max_completion_tokens'] ?? body['max_tokens']);
    delete body['max_tokens'];
    if (body['stream'] === true) body['stream_options'] = { ...(isObject(body['stream_options']) ? body['stream_options'] : {}), include_usage: true };
  }
}

/** The token from whichever header or parameter the caller put its API key in. */
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
