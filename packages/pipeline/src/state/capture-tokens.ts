// `capture_tokens` (main 15.3, 15.4, 16, ADR 0007, #374): the per-user bearer tokens Raycast and the
// CLI send. A token is `CAPTURE_TOKEN_PREFIX` plus 32 random bytes in base64url. The store keeps its
// SHA-256 (lowercase hex) and never the token, so a database dump identifies no one's credential;
// the plaintext exists only in `issueCaptureToken`'s result. A leaked token identifies one person and
// is revoked alone by id. Not derived from events, so `state rebuild` never touches the table.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { CaptureTokenInfo, IssuedCaptureToken, NewCaptureToken, VerifiedCaptureToken } from '../ports/state.ts';
import { ulid } from '../util/ulid.ts';
import type { StateContext } from './context.ts';

/** The fixed prefix every capture token starts with, so a scanner (or a person) can tell what leaked. */
export const CAPTURE_TOKEN_PREFIX = 'swc_';

const SECRET_BYTES = 32;
/** 32 bytes in unpadded base64url. */
const TOKEN_SHAPE = new RegExp(`^${CAPTURE_TOKEN_PREFIX}[A-Za-z0-9_-]{43}$`);

/** The SHA-256 of the whole token, prefix included, as lowercase hex: what `token_hash` holds. */
export function hashCaptureToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** True when `token` has a capture token's shape (prefix and length); says nothing about whether it is live. */
export function isCaptureTokenShape(token: string): boolean {
  return TOKEN_SHAPE.test(token);
}

type Row = {
  id: string;
  workspace_id: string;
  person: string;
  label: string | null;
  issued_at: unknown;
  last_used_at: unknown;
  revoked_at: unknown;
};

function info(ctx: StateContext, row: Row): CaptureTokenInfo {
  const lastUsedAt = ctx.codec.fromTimestampOpt(row.last_used_at);
  const revokedAt = ctx.codec.fromTimestampOpt(row.revoked_at);
  return {
    id: row.id,
    workspaceId: row.workspace_id,
    person: row.person,
    ...(row.label === null ? {} : { label: row.label }),
    issuedAt: ctx.codec.fromTimestamp(row.issued_at),
    ...(lastUsedAt === undefined ? {} : { lastUsedAt }),
    ...(revokedAt === undefined ? {} : { revokedAt }),
  };
}

/** The columns a listing reads: everything but `token_hash`. */
const INFO_COLUMNS = ['id', 'workspace_id', 'person', 'label', 'issued_at', 'last_used_at', 'revoked_at'] as const;

/** See `StatePort.issueCaptureToken`. */
export async function issueCaptureToken(ctx: StateContext, input: NewCaptureToken): Promise<IssuedCaptureToken> {
  if (input.workspaceId === '' || input.person === '') {
    throw new TypeError('issueCaptureToken: workspaceId and person are required');
  }
  const now = ctx.now();
  const token = CAPTURE_TOKEN_PREFIX + randomBytes(SECRET_BYTES).toString('base64url');
  const id = ulid(now.getTime());
  const issuedAt = ctx.codec.timestamp(now);
  await ctx.db
    .insertInto('capture_tokens')
    .values({
      id,
      workspace_id: input.workspaceId,
      person: input.person,
      label: input.label ?? null,
      token_hash: hashCaptureToken(token),
      issued_at: issuedAt,
    })
    .execute();
  return {
    id,
    workspaceId: input.workspaceId,
    person: input.person,
    ...(input.label === undefined ? {} : { label: input.label }),
    issuedAt,
    token,
  };
}

/** See `StatePort.verifyCaptureToken`. */
export async function verifyCaptureToken(ctx: StateContext, token: string): Promise<VerifiedCaptureToken | null> {
  if (!isCaptureTokenShape(token)) {
    return null;
  }
  const presented = Buffer.from(hashCaptureToken(token), 'hex');
  const row = await ctx.db
    .selectFrom('capture_tokens')
    .select(['id', 'workspace_id', 'person', 'token_hash', 'revoked_at'])
    .where('token_hash', '=', presented.toString('hex'))
    .executeTakeFirst();
  if (row === undefined || row.revoked_at !== null) {
    return null;
  }
  // The lookup is by hash, so a match is already equal; the constant-time compare makes the check
  // independent of how the database compares strings.
  const stored = Buffer.from(row.token_hash, 'hex');
  if (stored.length !== presented.length || !timingSafeEqual(stored, presented)) {
    return null;
  }
  // Stamp only while still live, so a revoke that lands between the read and here wins.
  const stamped = await ctx.db
    .updateTable('capture_tokens')
    .set({ last_used_at: ctx.codec.timestamp(ctx.now()) })
    .where('id', '=', row.id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (Number(stamped.numUpdatedRows) === 0) {
    return null;
  }
  return { workspaceId: row.workspace_id, person: row.person, tokenId: row.id };
}

/** See `StatePort.revokeCaptureToken`. */
export async function revokeCaptureToken(ctx: StateContext, id: string): Promise<boolean> {
  const result = await ctx.db
    .updateTable('capture_tokens')
    .set({ revoked_at: ctx.codec.timestamp(ctx.now()) })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return Number(result.numUpdatedRows) > 0;
}

/** See `StatePort.listCaptureTokens`. */
export async function listCaptureTokens(ctx: StateContext, workspaceId: string): Promise<CaptureTokenInfo[]> {
  const rows = await ctx.db
    .selectFrom('capture_tokens')
    .select(INFO_COLUMNS)
    .where('workspace_id', '=', workspaceId)
    .orderBy('issued_at')
    .orderBy('id')
    .execute();
  return rows.map((r) => info(ctx, r));
}
