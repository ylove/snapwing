// The `bot_messages` projection (A 1.3, #287): every message Snapwing posted that a person can react
// to, with its target role and incident, keyed by platform, channel, and message id.
//
// - `bot-message-posted` writes one row. The same message recorded again (a retried append, a
//   repost under the same id) replaces the row, so a replay writes the same rows in log order.
// - Corrections do not refold this table, as for claims and escalation scores: it keeps what the
//   events as recorded gave it.
//
// `getMessageTarget` is the read target resolution needs: the bot message's role and incident, else
// `anchor` when the message is an incident's anchor (`incidents.channel_id`, `anchor_id`), else null.
// Not on the StatePort (B 1 has no reader for it); `signals/target.ts` wraps it for a store.

import type { IncidentEvent } from '../../contracts/events.ts';
import type { TargetRole } from '../../contracts/signals.ts';
import type { StateContext } from '../context.ts';

/** A message on a chat platform: a Slack `ts` is unique only within its channel. */
export interface MessageRef {
  platform: 'slack' | 'teams';
  channel: string;
  messageId: string;
}

/** What a message is to Snapwing: its target role and the incident it belongs to. */
export interface MessageTarget {
  incidentId: string;
  workspaceId: string;
  role: TargetRole;
}

const BOT_ROLES: ReadonlySet<string> = new Set<TargetRole>(['scope-preview', 'dedupe', 'fix-preview', 'pr', 'staging-check', 'status', 'other']);

/** Writes the row a `bot-message-posted` event implies; any other event writes nothing. */
export async function writeBotMessage(tx: StateContext, e: IncidentEvent): Promise<void> {
  if (e.type !== 'bot-message-posted') {
    return;
  }
  const { platform, channel, messageId, role } = e.payload;
  const row = {
    workspace_id: e.workspaceId,
    incident_id: e.incidentId,
    role,
    seq: e.seq,
    posted_at: tx.codec.timestamp(e.occurredAt),
  };
  await tx.db
    .insertInto('bot_messages')
    .values({ platform, channel, message_id: messageId, ...row })
    .onConflict((oc) => oc.columns(['platform', 'channel', 'message_id']).doUpdateSet(row))
    .execute();
}

/**
 * The target a reaction on `ref` lands on: a message Snapwing posted (its recorded role), else an
 * incident's anchor (`anchor`; a top-level incident before a child work item, then the newest), else
 * null for a message Snapwing knows nothing about.
 */
export async function getMessageTarget(ctx: StateContext, ref: MessageRef): Promise<MessageTarget | null> {
  const bot = await ctx.db
    .selectFrom('bot_messages')
    .select(['incident_id', 'workspace_id', 'role'])
    .where('platform', '=', ref.platform)
    .where('channel', '=', ref.channel)
    .where('message_id', '=', ref.messageId)
    .executeTakeFirst();
  if (bot !== undefined) {
    // A role this build does not know (a newer writer) is `other`: never a role with effects.
    const role = BOT_ROLES.has(bot.role) ? (bot.role as TargetRole) : 'other';
    return { incidentId: bot.incident_id, workspaceId: bot.workspace_id, role };
  }
  const anchors = await ctx.db
    .selectFrom('incidents')
    .select(['id', 'workspace_id', 'kind', 'opened_at'])
    .where('channel_id', '=', ref.channel)
    .where('anchor_id', '=', ref.messageId)
    .where('source', '=', ref.platform)
    .execute();
  const best = anchors
    .map((r) => ({ id: r.id, workspaceId: r.workspace_id, top: r.kind === 'incident', openedAt: ctx.codec.fromTimestamp(r.opened_at) }))
    .sort((a, b) => Number(b.top) - Number(a.top) || compareCode(b.openedAt, a.openedAt) || compareCode(b.id, a.id))[0];
  return best === undefined ? null : { incidentId: best.id, workspaceId: best.workspaceId, role: 'anchor' };
}

/** Code-unit order, the same on every dialect (journal 2026-10-02-projection-order). */
function compareCode(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
