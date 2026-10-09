// src/model-proxy/token.ts: the per-run model token a fixer or review container calls the server's
// model proxy with (ADR 0017, amendment 1). No model provider key ever enters a container; this token is
// what the container's wrapper holds instead (never the agent, #273), and all it can do is spend model
// calls for its own run through the proxy, on one provider and one model with a capped `max_tokens`,
// until the run is revoked or the token expires.
//
// The format mirrors the fixer token (`fixer-api/token.ts`): `swm1.<claims>.<mac>`, `claims` base64url
// JSON `{ w, r, p, m, x, iat, exp }` (work item, run, provider, model, the largest `max_tokens` one call
// may ask for, issued and expiry times in epoch milliseconds), `mac`
// base64url HMAC-SHA256 over `swm1.<claims>` keyed with `SNAPWING_FIXER_TOKEN_SECRET`. The prefix is
// inside the MAC, so a model token is never a valid fixer token (the fixer API, which can report a run
// done, refuses it) and a fixer token is never a valid model token. Nothing here logs or echoes a
// token or the secret.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { MODEL_PROVIDERS, type ModelProvider } from '@snapwing/pipeline/config/app-config.ts';
import { parseDuration } from '@snapwing/pipeline/util/duration.ts';
import { MAX_FIXER_TOKEN_TTL, MIN_FIXER_TOKEN_SECRET_LENGTH, FIXER_TOKEN_SECRET_ENV, type FixerTokenKeys } from '../fixer-api/token.ts';

/** Same key as the fixer token, domain separated by the prefix. */
export type ModelTokenKeys = FixerTokenKeys;

/** Longest TTL a model token may have. */
export const MAX_MODEL_TOKEN_TTL = MAX_FIXER_TOKEN_TTL;

const PREFIX = 'swm1';
const MAC_BYTES = 32;

/** What a model token lets its run call (#273): one provider, one model, at most `maxTokens` per call. */
export interface ModelGrant {
  provider: ModelProvider;
  model: string;
  maxTokens: number;
}

export interface ModelTokenInput extends ModelGrant {
  workItemId: string;
  runId: string;
  /** ISO 8601 duration, at most `MAX_MODEL_TOKEN_TTL`: the run's wall clock plus a small margin. */
  ttl: string;
}

export interface ModelTokenClaims extends ModelGrant {
  workItemId: string;
  runId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export type ModelTokenRejection = 'malformed' | 'bad-signature' | 'expired' | 'wrong-work-item';

export type ModelTokenVerification = { ok: true; claims: ModelTokenClaims } | { ok: false; reason: ModelTokenRejection };

/** Checks a presented token against the work item named in the request path. */
export type ModelTokenVerifier = (token: string, workItemId: string) => ModelTokenVerification;

export function issueModelToken(input: ModelTokenInput, keys: ModelTokenKeys): string {
  assertSecret(keys.secret);
  if (input.workItemId === '' || input.runId === '' || input.model === '') throw new TypeError('issueModelToken: workItemId, runId, and model are required');
  if (!Number.isSafeInteger(input.maxTokens) || input.maxTokens < 1) throw new RangeError('issueModelToken: maxTokens must be a positive integer');
  const ttlMs = parseDuration(input.ttl);
  if (ttlMs <= 0 || ttlMs > parseDuration(MAX_MODEL_TOKEN_TTL)) {
    throw new RangeError(`issueModelToken: ttl must be positive and at most ${MAX_MODEL_TOKEN_TTL}`);
  }
  const iat = keys.clock().getTime();
  const claims = { w: input.workItemId, r: input.runId, p: input.provider, m: input.model, x: input.maxTokens, iat, exp: iat + ttlMs };
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
  return `${body}.${mac(keys.secret, body).toString('base64url')}`;
}

export function verifyModelToken(token: string, workItemId: string, keys: ModelTokenKeys): ModelTokenVerification {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return reject('malformed');
  const [, claimsPart = '', macPart = ''] = parts;
  if (!isBase64url(claimsPart) || !isBase64url(macPart)) return reject('malformed');

  const presented = Buffer.from(macPart, 'base64url');
  const expected = mac(keys.secret, `${PREFIX}.${claimsPart}`);
  if (presented.length !== MAC_BYTES || !timingSafeEqual(presented, expected)) return reject('bad-signature');

  const claims = parseClaims(claimsPart);
  if (claims === undefined) return reject('malformed');
  if (keys.clock().getTime() >= claims.expiresAt.getTime()) return reject('expired');
  if (claims.workItemId !== workItemId) return reject('wrong-work-item');
  return { ok: true, claims };
}

/** Binds `verifyModelToken` to keys, for `createModelProxyRoutes`. */
export function modelTokenVerifier(keys: ModelTokenKeys): ModelTokenVerifier {
  return (token, workItemId) => verifyModelToken(token, workItemId, keys);
}

// Private ----------------------------------------------------------------------------------------

function assertSecret(secret: string): void {
  if (secret.length < MIN_FIXER_TOKEN_SECRET_LENGTH) {
    throw new Error(`${FIXER_TOKEN_SECRET_ENV} must be at least ${MIN_FIXER_TOKEN_SECRET_LENGTH} characters`);
  }
}

function mac(secret: string, body: string): Buffer {
  return createHmac('sha256', secret).update(body, 'utf8').digest();
}

function isBase64url(s: string): boolean {
  return s.length > 0 && /^[A-Za-z0-9_-]+$/.test(s);
}

function parseClaims(part: string): ModelTokenClaims | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { w, r, p, m, x, iat, exp } = value as Record<string, unknown>;
  if (typeof w !== 'string' || w === '' || typeof r !== 'string' || r === '') return undefined;
  if (!(MODEL_PROVIDERS as readonly unknown[]).includes(p) || typeof m !== 'string' || m === '' || !Number.isSafeInteger(x) || (x as number) < 1) return undefined;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return undefined;
  return { workItemId: w, runId: r, provider: p as ModelProvider, model: m, maxTokens: x as number, issuedAt: new Date(iat as number), expiresAt: new Date(exp as number) };
}

function reject(reason: ModelTokenRejection): ModelTokenVerification {
  return { ok: false, reason };
}
