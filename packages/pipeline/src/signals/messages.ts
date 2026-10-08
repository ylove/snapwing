// Recording what Snapwing posts (A 1.3). The code that posts a card or the status message
// calls `recordBotMessage` right after the post, so a later reaction on that message resolves to its
// role (`signals/target.ts`). The event is `bot-message-posted`; the projection is `bot_messages`.
//
// The append passes `expectedSeq` from a fresh read and retries a conflict from a fresh read. An
// incident with no log yet records nothing: there is no incident to resolve the reaction to.

import type { BotMessageRole, NewEvent } from '../contracts/events.ts';
import type { InteractiveCard } from '../contracts/adapters.ts';
import { isExpectedSeqConflict } from '../contracts/state.ts';
import type { StatePort } from '../ports/state.ts';

/** Tries before `recordBotMessage` gives up on a log that keeps moving. */
export const RECORD_APPEND_TRIES = 5;

/** A posted message, as the platform answered the post. */
export interface PostedMessage {
  platform: 'slack' | 'teams';
  channel: string;
  messageId: string;
  role: BotMessageRole;
}

/** The target role of a card Snapwing posts. A clarify question is `other`: A 1.3 gives it no meaning. */
export function roleOfCard(kind: InteractiveCard['kind']): BotMessageRole {
  switch (kind) {
    case 'scope-preview':
    case 'dedupe':
    case 'fix-preview':
      return kind;
    case 'claimed':
      // The claimed card replaces the fix preview when an engineer claims (A 2.1), so a reaction on it
      // means what it would on the fix preview (A 1.3).
      return 'fix-preview';
    case 'pr-ready':
      return 'pr';
    // `file-confirm` is held for a capture's client, never posted in chat.
    case 'clarify':
    case 'file-confirm':
      return 'other';
  }
}

/** The event `recordBotMessage` appends, for callers that append it with events of their own. */
export function botMessagePosted(workspaceId: string, incidentId: string, posted: PostedMessage, occurredAt: string): NewEvent<'bot-message-posted'> {
  return {
    workspaceId,
    incidentId,
    type: 'bot-message-posted',
    v: 1,
    source: posted.platform,
    occurredAt,
    payload: { platform: posted.platform, channel: posted.channel, messageId: posted.messageId, role: posted.role },
  };
}

/**
 * Appends `bot-message-posted` for `posted` to the incident's log. Resolves false (nothing recorded)
 * when the incident has no log. Rejects when the log keeps conflicting after `RECORD_APPEND_TRIES`.
 */
export async function recordBotMessage(
  state: Pick<StatePort, 'read' | 'append'>,
  incidentId: string,
  posted: PostedMessage,
  now: () => Date = () => new Date(),
): Promise<boolean> {
  for (let i = 0; i < RECORD_APPEND_TRIES; i++) {
    const log = await state.read(incidentId);
    const first = log[0];
    if (first === undefined) return false;
    try {
      await state.append(incidentId, [botMessagePosted(first.workspaceId, incidentId, posted, now().toISOString())], log.at(-1)?.seq ?? 0);
      return true;
    } catch (err) {
      if (!isExpectedSeqConflict(err)) throw err;
    }
  }
  throw new Error(`bot-message-posted for ${incidentId} kept conflicting after ${RECORD_APPEND_TRIES} tries`);
}

/** Events that record what the bot posted. They are never a decision's input. */
export const BOT_RECORDS: ReadonlySet<string> = new Set(['bot-message-posted', 'status-message-posted']);

/**
 * For a writer whose append at `expectedSeq` conflicted: the incident's new last seq when every event
 * after `expectedSeq` only records what the bot posted (`bot-message-posted`, `status-message-posted`),
 * so the writer's decision still stands and it may append after them; undefined when anything else
 * moved the log, and the writer must re-read and decide again. The engine needs this because a step
 * posts a card through the adapter, which records it, before the step appends.
 */
export async function lastSeqPastBotRecords(
  state: Pick<StatePort, 'read'>,
  incidentId: string,
  expectedSeq: number,
  /** The event types that leave the writer's decision standing; bot records by default. */
  harmless: ReadonlySet<string> = BOT_RECORDS,
): Promise<number | undefined> {
  const newer = await state.read(incidentId, expectedSeq + 1);
  if (newer.length === 0 || !newer.every((e) => harmless.has(e.type))) return undefined;
  return newer.at(-1)?.seq;
}
