// Config cache (B 1, B 3 `config_versions`): the map, playbook, and instructions as last loaded.
//
// Two gaps between B 1 and B 3, closed here (ADR 0011 left them open):
// - `putConfigVersion` takes no validity flag. Loaders validate before they put, so every row is
//   written `valid` true with null `errors`, and reads consider only valid rows.
// - `putConfigVersion` takes no workspace, but `config_versions.workspace_id` references
//   `workspaces`. The port is single-tenant for config: it uses the install's one workspace, and
//   when there is none yet, creates it with slug `default` (`DEFAULT_WORKSPACE_SLUG`). With more
//   than one workspace it rejects (`ConfigWorkspaceAmbiguousError`) rather than guess; a
//   multi-tenant install needs a workspace-scoped config port, which B 1 does not have yet.
//
// "Latest" is the row with the greatest `loaded_at`. Putting a hash that is already stored (a
// revert to an earlier config) refreshes its `loaded_at` and body, so it becomes the latest again.
// `loaded_at` is the app clock, bumped to 1 ms after the kind's current latest when the clock has
// not moved past it, so the last put always wins even within one millisecond.

import { StateNotFoundError, type ConfigKind, type ConfigVersion } from '../contracts/state.ts';
import { ulid } from '../util/ulid.ts';
import { inTransaction, type StateContext } from './context.ts';

/** Slug of the workspace `putConfigVersion` creates on an install that has none. */
export const DEFAULT_WORKSPACE_SLUG = 'default';

/** `putConfigVersion` or `getConfigVersion` found more than one workspace and cannot pick one. */
export class ConfigWorkspaceAmbiguousError extends Error {
  override readonly name = 'ConfigWorkspaceAmbiguousError';
  readonly code = 'CONFIG_WORKSPACE_AMBIGUOUS';

  constructor(count: number) {
    super(`config_versions: ${count} workspaces exist; the config cache is single-tenant and cannot pick one`);
  }
}

/** See `StatePort.putConfigVersion`. */
export async function putConfigVersion(ctx: StateContext, kind: ConfigKind, hash: string, body: string): Promise<void> {
  await inTransaction(ctx, async (tx) => {
    const workspaceId = (await installWorkspaceId(tx)) ?? (await createDefaultWorkspace(tx));
    const latest = await tx.db
      .selectFrom('config_versions')
      .select((eb) => eb.fn.max('loaded_at').as('at'))
      .where('workspace_id', '=', workspaceId)
      .where('kind', '=', kind)
      .executeTakeFirst();
    let loadedAt = tx.now();
    const latestAt = tx.codec.fromTimestampOpt(latest?.at);
    if (latestAt !== undefined && tx.codec.timestamp(loadedAt) <= latestAt) {
      loadedAt = new Date(new Date(latestAt).getTime() + 1);
    }
    const loaded = tx.codec.timestamp(loadedAt);
    await tx.db
      .insertInto('config_versions')
      .values({ workspace_id: workspaceId, kind, hash, body, valid: tx.codec.bool(true), errors: null, loaded_at: loaded })
      .onConflict((oc) =>
        oc.columns(['workspace_id', 'kind', 'hash']).doUpdateSet({ body, valid: tx.codec.bool(true), errors: null, loaded_at: loaded }),
      )
      .execute();
  });
}

/** See `StatePort.getConfigVersion`. The most recently loaded valid version; `StateNotFoundError` when none. */
export async function getConfigVersion(ctx: StateContext, kind: ConfigKind): Promise<ConfigVersion> {
  const workspaceId = await installWorkspaceId(ctx);
  const row =
    workspaceId === undefined
      ? undefined
      : await ctx.db
          .selectFrom('config_versions')
          .select(['hash', 'body'])
          .where('workspace_id', '=', workspaceId)
          .where('kind', '=', kind)
          .where('valid', '=', ctx.codec.bool(true))
          .orderBy('loaded_at', 'desc')
          .orderBy('hash', 'asc')
          .limit(1)
          .executeTakeFirst();
  if (row === undefined) {
    throw new StateNotFoundError('config-version', kind);
  }
  return { hash: row.hash, body: row.body };
}

/** The install's one workspace id, `undefined` when there is none; rejects when there are several. */
export async function installWorkspaceId(ctx: StateContext): Promise<string | undefined> {
  const rows = await ctx.db.selectFrom('workspaces').select('id').limit(2).execute();
  if (rows.length > 1) {
    const count = await ctx.db.selectFrom('workspaces').select((eb) => eb.fn.countAll().as('n')).executeTakeFirstOrThrow();
    throw new ConfigWorkspaceAmbiguousError(ctx.codec.fromNumber(count.n));
  }
  return rows[0]?.id;
}

/** Creates the `default` workspace, or returns its id when a concurrent put created it first. */
export async function createDefaultWorkspace(ctx: StateContext): Promise<string> {
  await ctx.db
    .insertInto('workspaces')
    .values({ id: ulid(ctx.now().getTime()), slug: DEFAULT_WORKSPACE_SLUG, created_at: ctx.codec.timestamp(ctx.now()) })
    .onConflict((oc) => oc.column('slug').doNothing())
    .execute();
  const row = await ctx.db.selectFrom('workspaces').select('id').where('slug', '=', DEFAULT_WORKSPACE_SLUG).executeTakeFirstOrThrow();
  return row.id;
}
