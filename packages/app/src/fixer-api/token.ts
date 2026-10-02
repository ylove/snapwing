// src/fixer-api/token.ts: the short-lived token a fixer run reports with (B 0 rule 4, B 9, main 16).
//
// A token is scoped to one work item and names the incident whose log its reports append to. It is
// `swf1.<claims>.<mac>`: `claims` is base64url JSON `{ w, i, iat, exp }` (work item, incident, issued
// and expiry times in epoch milliseconds), and `mac` is base64url HMAC-SHA256 over `swf1.<claims>`
// keyed with `SNAPWING_FIXER_TOKEN_SECRET`. Verification checks the MAC with a constant-time compare
// before it parses anything, then the expiry, then that the token's work item is the one in the path.
// Nothing here logs or echoes a token or the secret.

import { createHmac, timingSafeEqual } from 'node:crypto';
import { formatDuration, parseDuration } from '@snapwing/pipeline/util/duration.ts';

/** The env var (and repository secret) holding the HMAC key; CONTEXT.md 6b. */
export const FIXER_TOKEN_SECRET_ENV = 'SNAPWING_FIXER_TOKEN_SECRET';
/** Shortest secret accepted, in characters. */
export const MIN_FIXER_TOKEN_SECRET_LENGTH = 32;
/** Longest TTL a fixer token may have: tokens are short-lived (B 9). */
export const MAX_FIXER_TOKEN_TTL = 'P1D';
/** A TTL that covers the default fixer budget (PT30M) with room for the final report. */
export const DEFAULT_FIXER_TOKEN_TTL = 'PT45M';
/** How long a run's fixer token outlives its wall clock budget, for the final report. */
export const FIXER_TOKEN_MARGIN_MS = 15 * 60_000;

/**
 * A run's fixer token TTL: its wall clock budget plus `FIXER_TOKEN_MARGIN_MS` (`DEFAULT_FIXER_TOKEN_TTL`
 * for the default PT30M), at most `MAX_FIXER_TOKEN_TTL`. A run longer than an hour keeps reporting and
 * keeps getting fresh git tokens (`GET /fixer/{id}/git-token`, #266) to its end.
 */
export function fixerTokenTtl(wallClock: string): string {
  return formatDuration(Math.min(parseDuration(wallClock) + FIXER_TOKEN_MARGIN_MS, parseDuration(MAX_FIXER_TOKEN_TTL)));
}

const PREFIX = 'swf1';
const MAC_BYTES = 32;

export interface FixerTokenKeys {
  /** The value of `SNAPWING_FIXER_TOKEN_SECRET`. */
  secret: string;
  clock: () => Date;
}

export interface FixerTokenInput {
  workItemId: string;
  incidentId: string;
  /** ISO 8601 duration, at most `MAX_FIXER_TOKEN_TTL`. */
  ttl: string;
}

export interface FixerTokenClaims {
  workItemId: string;
  incidentId: string;
  issuedAt: Date;
  expiresAt: Date;
}

export type FixerTokenRejection = 'malformed' | 'bad-signature' | 'expired' | 'wrong-work-item';

export type FixerTokenVerification = { ok: true; claims: FixerTokenClaims } | { ok: false; reason: FixerTokenRejection };

/** Checks a presented token against the work item named in the request path. */
export type FixerTokenVerifier = (token: string, workItemId: string) => FixerTokenVerification;

/** Reads the HMAC key from the environment; throws when it is missing or too short. */
export function fixerTokenKeysFromEnv(env: Readonly<Record<string, string | undefined>>, clock: () => Date): FixerTokenKeys {
  const secret = env[FIXER_TOKEN_SECRET_ENV];
  if (secret === undefined || secret === '') throw new Error(`${FIXER_TOKEN_SECRET_ENV} is not set`);
  assertSecret(secret);
  return { secret, clock };
}

export function issueFixerToken(input: FixerTokenInput, keys: FixerTokenKeys): string {
  assertSecret(keys.secret);
  if (input.workItemId === '' || input.incidentId === '') throw new TypeError('issueFixerToken: workItemId and incidentId are required');
  const ttlMs = parseDuration(input.ttl);
  if (ttlMs <= 0 || ttlMs > parseDuration(MAX_FIXER_TOKEN_TTL)) {
    throw new RangeError(`issueFixerToken: ttl must be positive and at most ${MAX_FIXER_TOKEN_TTL}`);
  }
  const iat = keys.clock().getTime();
  const claims = { w: input.workItemId, i: input.incidentId, iat, exp: iat + ttlMs };
  const body = `${PREFIX}.${Buffer.from(JSON.stringify(claims), 'utf8').toString('base64url')}`;
  return `${body}.${mac(keys.secret, body).toString('base64url')}`;
}

export function verifyFixerToken(token: string, workItemId: string, keys: FixerTokenKeys): FixerTokenVerification {
  const parts = token.split('.');
  if (parts.length !== 3 || parts[0] !== PREFIX) return reject('malformed');
  const [, claimsPart = '', macPart = ''] = parts;
  if (!isBase64url(claimsPart) || !isBase64url(macPart)) return reject('malformed');

  const presented = Buffer.from(macPart, 'base64url');
  const expected = mac(keys.secret, `${PREFIX}.${claimsPart}`);
  // The MAC length is public; only the bytes are compared in constant time.
  if (presented.length !== MAC_BYTES || !timingSafeEqual(presented, expected)) return reject('bad-signature');

  const claims = parseClaims(claimsPart);
  if (claims === undefined) return reject('malformed');
  if (keys.clock().getTime() >= claims.expiresAt.getTime()) return reject('expired');
  if (claims.workItemId !== workItemId) return reject('wrong-work-item');
  return { ok: true, claims };
}

/** Binds `verifyFixerToken` to keys, for `createFixerRoutes`. */
export function fixerTokenVerifier(keys: FixerTokenKeys): FixerTokenVerifier {
  return (token, workItemId) => verifyFixerToken(token, workItemId, keys);
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

function parseClaims(part: string): FixerTokenClaims | undefined {
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(part, 'base64url').toString('utf8'));
  } catch {
    return undefined;
  }
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  const { w, i, iat, exp } = value as Record<string, unknown>;
  if (typeof w !== 'string' || w === '' || typeof i !== 'string' || i === '') return undefined;
  if (!Number.isSafeInteger(iat) || !Number.isSafeInteger(exp)) return undefined;
  return { workItemId: w, incidentId: i, issuedAt: new Date(iat as number), expiresAt: new Date(exp as number) };
}

function reject(reason: FixerTokenRejection): FixerTokenVerification {
  return { ok: false, reason };
}
