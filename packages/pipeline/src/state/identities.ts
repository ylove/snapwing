// `linked_identities` (main 11.2, ADR 0007): a chat user's linked GitHub account and its
// sealed GitHub App user-to-server and refresh tokens. One row per (workspace, chat, chat user).
// The store never sees a token: it stores the sealed strings the caller gives it (`util/seal.ts`)
// and refuses anything that is not sealed, so a caller that forgets to seal fails loudly instead of
// writing a token in the clear. One GitHub account links to one chat user of a workspace, at a time
// (main 11.2): `linkIdentity` refuses a second holder, and a unique index backs it. The OAuth flow and the refresh live in app/src/github/oauth.ts.

import { sql } from 'kysely';
import { LinkedIdentityConflictError } from '../contracts/state.ts';
import type { LinkedIdentity, LinkedIdentityKey, NewLinkedIdentity } from '../ports/state.ts';
import { isSealed } from '../util/seal.ts';
import type { StateContext } from './context.ts';

function assertSealed(field: string, value: string | undefined): void {
  if (value !== undefined && !isSealed(value)) {
    throw new TypeError(`linkIdentity: ${field} must be a sealed value (util/seal.ts), not a token`);
  }
}

/** See `StatePort.linkIdentity`. An upsert; `linked_at` is kept unless `github_user_id` changes. */
export async function linkIdentity(ctx: StateContext, identity: NewLinkedIdentity): Promise<void> {
  assertSealed('accessToken', identity.accessToken);
  assertSealed('refreshToken', identity.refreshToken);
  const holder = await getLinkedIdentityByGithubUser(ctx, identity.workspaceId, identity.githubUserId);
  if (holder !== null && (holder.chat !== identity.chat || holder.chatUserId !== identity.chatUserId)) throw new LinkedIdentityConflictError();
  const now = ctx.codec.timestamp(ctx.now());
  const tokens = {
    github_login: identity.githubLogin,
    github_user_id: identity.githubUserId,
    access_token: identity.accessToken,
    access_token_expires_at: identity.accessTokenExpiresAt === undefined ? null : ctx.codec.timestamp(identity.accessTokenExpiresAt),
    refresh_token: identity.refreshToken ?? null,
    refresh_token_expires_at: identity.refreshTokenExpiresAt === undefined ? null : ctx.codec.timestamp(identity.refreshTokenExpiresAt),
    updated_at: now,
  };
  await ctx.db
    .insertInto('linked_identities')
    .values({
      workspace_id: identity.workspaceId,
      chat: identity.chat,
      chat_user_id: identity.chatUserId,
      ...tokens,
      linked_at: now,
    })
    .onConflict((oc) =>
      oc.columns(['workspace_id', 'chat', 'chat_user_id']).doUpdateSet({
        ...tokens,
        linked_at: sql<string>`case when linked_identities.github_user_id = excluded.github_user_id then linked_identities.linked_at else excluded.linked_at end`,
      }),
    )
    .execute();
}

function selectLinked(ctx: StateContext) {
  return ctx.db.selectFrom('linked_identities').selectAll();
}

function identityOf(ctx: StateContext, row: Awaited<ReturnType<ReturnType<typeof selectLinked>['executeTakeFirstOrThrow']>>): LinkedIdentity {
  const accessTokenExpiresAt = ctx.codec.fromTimestampOpt(row.access_token_expires_at);
  const refreshTokenExpiresAt = ctx.codec.fromTimestampOpt(row.refresh_token_expires_at);
  return {
    workspaceId: row.workspace_id,
    chat: row.chat,
    chatUserId: row.chat_user_id,
    githubLogin: row.github_login,
    githubUserId: ctx.codec.fromNumber(row.github_user_id),
    accessToken: row.access_token,
    ...(accessTokenExpiresAt === undefined ? {} : { accessTokenExpiresAt }),
    ...(row.refresh_token === null ? {} : { refreshToken: row.refresh_token }),
    ...(refreshTokenExpiresAt === undefined ? {} : { refreshTokenExpiresAt }),
    linkedAt: ctx.codec.fromTimestamp(row.linked_at),
    updatedAt: ctx.codec.fromTimestamp(row.updated_at),
  };
}

/** See `StatePort.getLinkedIdentity`. */
export async function getLinkedIdentity(ctx: StateContext, key: LinkedIdentityKey): Promise<LinkedIdentity | null> {
  const row = await selectLinked(ctx)
    .where('workspace_id', '=', key.workspaceId)
    .where('chat', '=', key.chat)
    .where('chat_user_id', '=', key.chatUserId)
    .executeTakeFirst();
  return row === undefined ? null : identityOf(ctx, row);
}

/** See `StatePort.getLinkedIdentityByGithubUser`. */
export async function getLinkedIdentityByGithubUser(ctx: StateContext, workspaceId: string, githubUserId: number): Promise<LinkedIdentity | null> {
  const row = await selectLinked(ctx).where('workspace_id', '=', workspaceId).where('github_user_id', '=', githubUserId).executeTakeFirst();
  return row === undefined ? null : identityOf(ctx, row);
}

/** See `StatePort.unlinkIdentity`. */
export async function unlinkIdentity(ctx: StateContext, key: LinkedIdentityKey): Promise<boolean> {
  const result = await ctx.db
    .deleteFrom('linked_identities')
    .where('workspace_id', '=', key.workspaceId)
    .where('chat', '=', key.chat)
    .where('chat_user_id', '=', key.chatUserId)
    .executeTakeFirst();
  return Number(result.numDeletedRows) > 0;
}
