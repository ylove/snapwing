// Teams authentication (main 15.2 Auth, 16, 17; ADR 0007). Inbound: every Bot Framework activity carries a JWT
// that `verifyBotFrameworkJwt` checks in full against the Bot Framework OpenID metadata and its JWKS (RS256
// signature, issuer, audience, nbf and exp with 5 minutes of skew, and the serviceUrl claim). Outbound: client
// credentials tokens for the Bot Connector and for Microsoft Graph, cached until 5 minutes before expiry.
// There is no DEMO_ONLY mode: validation is the same in every environment, so main 15.2's production refusal
// never applies. fetch and node:crypto only. A token or the app password is never logged and never put in an
// error message.

import { createPublicKey, verify as verifySignature } from 'node:crypto';
import type { KeyObject } from 'node:crypto';

/** The Bot Framework's OpenID metadata (public cloud). */
export const BOT_FRAMEWORK_OPENID_METADATA_URL = 'https://login.botframework.com/v1/.well-known/openidconfiguration';
/** The `iss` of every token the Bot Connector sends. */
export const BOT_FRAMEWORK_ISSUER = 'https://api.botframework.com';
/** Allowed clock difference for `nbf` and `exp`. */
export const BOT_FRAMEWORK_CLOCK_SKEW_MS = 5 * 60 * 1000;
/** How long fetched metadata and keys are trusted before a scheduled refresh. */
export const BOT_FRAMEWORK_KEYS_TTL_MS = 24 * 60 * 60 * 1000;
/** An unknown `kid` refetches the keys at most this often. */
export const BOT_FRAMEWORK_KEYS_REFETCH_MS = 60 * 1000;

export const MICROSOFT_LOGIN_HOST = 'https://login.microsoftonline.com';
/** The authority of a multi-tenant bot registration. New registrations are single-tenant. */
export const BOT_FRAMEWORK_MULTI_TENANT = 'botframework.com';
export const BOT_CONNECTOR_SCOPE = 'https://api.botframework.com/.default';
export const GRAPH_SCOPE = 'https://graph.microsoft.com/.default';
/** A cached outbound token is replaced once it has this little left. */
export const TEAMS_TOKEN_REFRESH_MARGIN_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------------------------------------
// Inbound: the Bot Framework JWT
// ---------------------------------------------------------------------------------------------------------

export type BotFrameworkJwtFailure =
  /** No Authorization header at all. */
  | 'missing-header'
  /** A scheme other than Bearer. */
  | 'not-bearer'
  /** `Bearer` with no token after it. */
  | 'missing-token'
  /** Not three base64url parts, unparseable JSON, or a required claim of the wrong type. */
  | 'malformed'
  /** Header `alg` other than RS256. */
  | 'unsupported-algorithm'
  /** The metadata or JWKS could not be fetched and nothing usable is cached. */
  | 'keys-unavailable'
  /** No key with the header's `kid`, even after a refetch. */
  | 'unknown-key'
  /** The key does not endorse the activity's channel. */
  | 'channel-not-endorsed'
  | 'bad-signature'
  | 'wrong-issuer'
  | 'wrong-audience'
  | 'not-yet-valid'
  | 'expired'
  | 'service-url-mismatch';

export interface BotFrameworkClaims {
  iss: string;
  aud: string;
  exp: number;
  nbf?: number;
  serviceUrl: string;
  /** The calling app (the Bot Connector), when the token carries it. */
  appid?: string;
  /** Every claim as decoded. */
  raw: Readonly<Record<string, unknown>>;
}

export type BotFrameworkJwtResult = { ok: true; claims: BotFrameworkClaims } | { ok: false; reason: BotFrameworkJwtFailure };

/** A JWKS entry: the RSA public key plus the channels it is endorsed for (absent means no restriction). */
export interface BotFrameworkSigningKey {
  key: KeyObject;
  endorsements: readonly string[] | undefined;
}

export type KeyLookup = { ok: true; key: BotFrameworkSigningKey } | { ok: false; reason: 'keys-unavailable' | 'unknown-key' };

/** The cached metadata and JWKS. One per process is enough; tests make their own. */
export interface BotFrameworkKeys {
  /** Resolves a `kid`, fetching on first use, after the TTL, and on an unknown `kid` at most once a minute. Never throws. */
  get(kid: string, nowMs: number): Promise<KeyLookup>;
}

export interface BotFrameworkKeysOptions {
  fetch?: typeof fetch;
  /** Default {@link BOT_FRAMEWORK_OPENID_METADATA_URL}. */
  metadataUrl?: string;
}

interface KeySet {
  keys: Map<string, BotFrameworkSigningKey>;
  fetchedAt: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function fetchJson(doFetch: typeof fetch, url: string): Promise<unknown> {
  const res = await doFetch(url, { headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`GET ${url}: ${res.status}`);
  return (await res.json()) as unknown;
}

function toSigningKeys(jwks: unknown): Map<string, BotFrameworkSigningKey> {
  const out = new Map<string, BotFrameworkSigningKey>();
  if (!isRecord(jwks) || !Array.isArray(jwks.keys)) throw new Error('JWKS has no keys array');
  for (const jwk of jwks.keys as unknown[]) {
    if (!isRecord(jwk) || typeof jwk.kid !== 'string' || jwk.kty !== 'RSA' || typeof jwk.n !== 'string' || typeof jwk.e !== 'string') continue;
    if (jwk.use !== undefined && jwk.use !== 'sig') continue;
    try {
      const key = createPublicKey({ key: { kty: 'RSA', n: jwk.n, e: jwk.e }, format: 'jwk' });
      const endorsements = Array.isArray(jwk.endorsements) ? jwk.endorsements.filter((e): e is string => typeof e === 'string') : undefined;
      out.set(jwk.kid, { key, endorsements });
    } catch {
      // A key node:crypto cannot read is a key no token can use; skip it.
    }
  }
  return out;
}

export function createBotFrameworkKeys(options: BotFrameworkKeysOptions = {}): BotFrameworkKeys {
  const doFetch = options.fetch ?? ((input, init) => fetch(input, init));
  const metadataUrl = options.metadataUrl ?? BOT_FRAMEWORK_OPENID_METADATA_URL;
  let current: KeySet | undefined;
  /** When the last fetch was attempted (success or not), for the once-a-minute limit. */
  let lastAttempt: number | undefined;
  let inflight: Promise<KeySet | undefined> | undefined;

  async function load(nowMs: number): Promise<KeySet> {
    const metadata = await fetchJson(doFetch, metadataUrl);
    if (!isRecord(metadata) || typeof metadata.jwks_uri !== 'string' || !metadata.jwks_uri.startsWith('https://')) {
      throw new Error('OpenID metadata has no https jwks_uri');
    }
    return { keys: toSigningKeys(await fetchJson(doFetch, metadata.jwks_uri)), fetchedAt: nowMs };
  }

  function refresh(nowMs: number): Promise<KeySet | undefined> {
    if (inflight !== undefined) return inflight;
    lastAttempt = nowMs;
    inflight = load(nowMs)
      .then((set) => {
        current = set;
        return set;
      })
      .catch(() => current)
      .finally(() => {
        inflight = undefined;
      });
    return inflight;
  }

  function mayRefetch(nowMs: number): boolean {
    return lastAttempt === undefined || nowMs - lastAttempt >= BOT_FRAMEWORK_KEYS_REFETCH_MS || nowMs < lastAttempt;
  }

  return {
    async get(kid, nowMs) {
      let set = current;
      if (set === undefined || nowMs - set.fetchedAt >= BOT_FRAMEWORK_KEYS_TTL_MS) {
        // First use or past the TTL: join a fetch in flight, or refresh, rate limited so a dead endpoint is not
        // hammered by every request; when the refresh fails, stale keys stay usable.
        if (inflight !== undefined) set = await inflight;
        else if (mayRefetch(nowMs)) set = await refresh(nowMs);
      }
      if (set === undefined) return { ok: false, reason: 'keys-unavailable' };
      const hit = set.keys.get(kid);
      if (hit !== undefined) return { ok: true, key: hit };
      if (inflight === undefined && !mayRefetch(nowMs)) return { ok: false, reason: 'unknown-key' };
      const fresh = await refresh(nowMs);
      const retry = fresh?.keys.get(kid);
      return retry !== undefined ? { ok: true, key: retry } : { ok: false, reason: 'unknown-key' };
    },
  };
}

let sharedKeys: BotFrameworkKeys | undefined;

export interface VerifyBotFrameworkJwtOptions {
  /** The bot's Microsoft app id: the required audience. */
  appId: string;
  /** The activity's `serviceUrl`; the token's `serviceUrl` claim must equal it. */
  serviceUrl: string;
  /** Default now. A Date or epoch milliseconds. */
  now?: Date | number;
  /** The activity's `channelId` (`msteams`); when given, a key with endorsements must endorse it. */
  channelId?: string;
  /** Default one process-wide cache over the public Bot Framework metadata. */
  keys?: BotFrameworkKeys;
}

function decodeSegment(segment: string): Record<string, unknown> | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) return undefined;
  try {
    const value: unknown = JSON.parse(Buffer.from(segment, 'base64url').toString('utf8'));
    return isRecord(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

function sameServiceUrl(a: string, b: string): boolean {
  return a.replace(/\/+$/, '') === b.replace(/\/+$/, '');
}

async function verifyInner(authorization: string | null | undefined, options: VerifyBotFrameworkJwtOptions): Promise<BotFrameworkJwtResult> {
  if (authorization === undefined || authorization === null || authorization.trim() === '') return { ok: false, reason: 'missing-header' };
  const match = /^(\S+)(?:\s+(.*))?$/.exec(authorization.trim());
  if (match === null || match[1]?.toLowerCase() !== 'bearer') return { ok: false, reason: 'not-bearer' };
  const token = match[2]?.trim() ?? '';
  if (token === '') return { ok: false, reason: 'missing-token' };

  const parts = token.split('.');
  const [h, p, s] = parts;
  if (parts.length !== 3 || h === undefined || p === undefined || s === undefined || !/^[A-Za-z0-9_-]+$/.test(s)) return { ok: false, reason: 'malformed' };
  const header = decodeSegment(h);
  const claims = decodeSegment(p);
  if (header === undefined || claims === undefined) return { ok: false, reason: 'malformed' };
  if (header.alg !== 'RS256') return { ok: false, reason: 'unsupported-algorithm' };
  if (typeof header.kid !== 'string' || header.kid === '') return { ok: false, reason: 'malformed' };

  const nowMs = options.now === undefined ? Date.now() : typeof options.now === 'number' ? options.now : options.now.getTime();
  const keys = options.keys ?? (sharedKeys ??= createBotFrameworkKeys());
  const lookup = await keys.get(header.kid, nowMs);
  if (!lookup.ok) return { ok: false, reason: lookup.reason };
  if (!verifySignature('RSA-SHA256', Buffer.from(`${h}.${p}`, 'utf8'), lookup.key.key, Buffer.from(s, 'base64url'))) {
    return { ok: false, reason: 'bad-signature' };
  }
  const { endorsements } = lookup.key;
  if (options.channelId !== undefined && endorsements !== undefined && !endorsements.includes(options.channelId)) {
    return { ok: false, reason: 'channel-not-endorsed' };
  }

  if (claims.iss !== BOT_FRAMEWORK_ISSUER) return { ok: false, reason: 'wrong-issuer' };
  const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (options.appId === '' || !audiences.includes(options.appId)) return { ok: false, reason: 'wrong-audience' };
  if (typeof claims.exp !== 'number' || (claims.nbf !== undefined && typeof claims.nbf !== 'number')) return { ok: false, reason: 'malformed' };
  if (typeof claims.nbf === 'number' && claims.nbf * 1000 > nowMs + BOT_FRAMEWORK_CLOCK_SKEW_MS) return { ok: false, reason: 'not-yet-valid' };
  if (claims.exp * 1000 < nowMs - BOT_FRAMEWORK_CLOCK_SKEW_MS) return { ok: false, reason: 'expired' };
  if (typeof claims.serviceUrl !== 'string' || !sameServiceUrl(claims.serviceUrl, options.serviceUrl)) {
    return { ok: false, reason: 'service-url-mismatch' };
  }

  return {
    ok: true,
    claims: {
      iss: claims.iss,
      aud: options.appId,
      exp: claims.exp,
      ...(typeof claims.nbf === 'number' ? { nbf: claims.nbf } : {}),
      serviceUrl: claims.serviceUrl,
      ...(typeof claims.appid === 'string' ? { appid: claims.appid } : {}),
      raw: claims,
    },
  };
}

/**
 * Authenticates a Bot Framework request from its Authorization header. Returns the claims or a typed reason;
 * never throws. A bare Bearer prefix is not authentication (main 15.2).
 */
export async function verifyBotFrameworkJwt(
  authorization: string | null | undefined,
  options: VerifyBotFrameworkJwtOptions,
): Promise<BotFrameworkJwtResult> {
  try {
    return await verifyInner(authorization, options);
  } catch {
    // Defensive: anything unforeseen (a key type node:crypto rejects at verify time) is a rejection, not a 500.
    return { ok: false, reason: 'malformed' };
  }
}

// ---------------------------------------------------------------------------------------------------------
// Outbound: client credentials for the Bot Connector and Graph
// ---------------------------------------------------------------------------------------------------------

/** A token endpoint call failed. Carries the status and Entra's error code, never a credential. */
export class TeamsAuthError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined) {
    super(`Microsoft token endpoint ${status}${code === undefined ? '' : `: ${code}`}`);
    this.name = 'TeamsAuthError';
    this.status = status;
    this.code = code;
  }
}

export interface TeamsTokenSource {
  /** A bearer token, cached until 5 minutes before it expires; concurrent callers share one request. */
  token(): Promise<string>;
}

export interface TeamsCredentials {
  /** `TEAMS_APP_ID`. */
  appId: string;
  /** `TEAMS_APP_PASSWORD`. */
  password: string;
  /** `TEAMS_TENANT_ID`: the authority for a single-tenant registration (the default for new bots). */
  tenantId?: string;
  fetch?: typeof fetch;
  now?: () => Date;
  /** Default {@link MICROSOFT_LOGIN_HOST}. */
  loginHost?: string;
}

export interface BotTokenSourceOptions extends TeamsCredentials {
  /** A multi-tenant registration: authority `botframework.com` instead of the tenant. */
  multiTenant?: boolean;
}

interface CachedToken {
  token: string;
  expiresAt: number;
}

function clientCredentialsSource(credentials: TeamsCredentials, authority: string, scope: string): TeamsTokenSource {
  const doFetch = credentials.fetch ?? ((input, init) => fetch(input, init));
  const now = credentials.now ?? (() => new Date());
  const host = (credentials.loginHost ?? MICROSOFT_LOGIN_HOST).replace(/\/+$/, '');
  const url = `${host}/${encodeURIComponent(authority)}/oauth2/v2.0/token`;
  let cached: CachedToken | undefined;
  let inflight: Promise<string> | undefined;

  async function mint(): Promise<string> {
    const requestedAt = now().getTime();
    const res = await doFetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: credentials.appId,
        client_secret: credentials.password,
        scope,
      }).toString(),
    });
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      body = undefined;
    }
    if (!res.ok) throw new TeamsAuthError(res.status, isRecord(body) && typeof body.error === 'string' ? body.error : undefined);
    if (!isRecord(body) || typeof body.access_token !== 'string' || body.access_token === '') {
      throw new TeamsAuthError(res.status, 'no_access_token');
    }
    const expiresIn = typeof body.expires_in === 'number' ? body.expires_in : Number(body.expires_in);
    if (!Number.isFinite(expiresIn) || expiresIn <= 0) throw new TeamsAuthError(res.status, 'no_expires_in');
    cached = { token: body.access_token, expiresAt: requestedAt + expiresIn * 1000 };
    return body.access_token;
  }

  return {
    async token() {
      if (cached !== undefined && cached.expiresAt - now().getTime() > TEAMS_TOKEN_REFRESH_MARGIN_MS) return cached.token;
      if (inflight !== undefined) return inflight;
      inflight = mint().finally(() => {
        inflight = undefined;
      });
      return inflight;
    },
  };
}

function requireTenant(tenantId: string | undefined, what: string): string {
  if (tenantId === undefined || tenantId.trim() === '') {
    throw new Error(`${what} needs a tenant id (TEAMS_TENANT_ID); new Bot Framework registrations are single-tenant`);
  }
  return tenantId.trim();
}

/**
 * Bot Connector tokens (scope `https://api.botframework.com/.default`) by client credentials. The authority is
 * the tenant (single-tenant, the default) or `botframework.com` when `multiTenant` is set.
 */
export function createBotTokenSource(options: BotTokenSourceOptions): TeamsTokenSource {
  const authority = options.multiTenant === true ? BOT_FRAMEWORK_MULTI_TENANT : requireTenant(options.tenantId, 'createBotTokenSource');
  return clientCredentialsSource(options, authority, BOT_CONNECTOR_SCOPE);
}

/** Microsoft Graph application tokens (scope `https://graph.microsoft.com/.default`) from the tenant's authority. */
export function createGraphTokenSource(options: TeamsCredentials): TeamsTokenSource {
  return clientCredentialsSource(options, requireTenant(options.tenantId, 'createGraphTokenSource'), GRAPH_SCOPE);
}
