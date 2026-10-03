// The Slack side of the e2e tier (main 14.4): the reporter and engineer act through their own user
// tokens (the test-driver app, #264), reads go through the bot token, and a card tap is a
// `block_actions` payload built from the real card. Slack has no API that presses a button for a user,
// so the harness hands that payload to the server's Socket Mode connection as an `interactive`
// envelope (see server.ts); everything else (the trigger reaction, every post and edit) is real.
//
// Safety: every post goes to SLACK_TEST_CHANNEL only and starts with `[snapwing-test]`; the engineer is
// the workspace owner's own account and only reacts. `cleanupThread` deletes everything the run left.

import { PREFIX } from './env.ts';

export type Rec = Record<string, unknown>;

export interface SlackMessage {
  ts: string;
  text?: string;
  user?: string;
  bot_id?: string;
  thread_ts?: string;
  edited?: { user?: string; ts?: string };
  blocks?: Rec[];
}

export interface SlackButton {
  action_id: string;
  value: string;
  text: { text: string };
}

export class SlackApiError extends Error {
  override readonly name = 'SlackApiError';
  constructor(
    readonly method: string,
    readonly error: string,
  ) {
    super(`slack ${method}: ${error}`);
  }
}

/** One Web API call; the token travels in the header only and never reaches an error message. */
export async function slackCall(token: string, method: string, params: Readonly<Record<string, string>>): Promise<Rec> {
  const res = await fetch(`https://slack.com/api/${method}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(params),
  });
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after') ?? '1');
    await new Promise((r) => setTimeout(r, Math.max(1, wait) * 1000));
    return slackCall(token, method, params);
  }
  const body = (await res.json().catch(() => ({}))) as Rec;
  if (body['ok'] !== true) throw new SlackApiError(method, typeof body['error'] === 'string' ? body['error'] : `http_${res.status}`);
  return body;
}

export interface SlackDriverOptions {
  botToken: string;
  channel: string;
  reporter: { token: string; id: string };
  engineer: { token: string; id: string };
}

export interface SlackDriver {
  /** Posts `[snapwing-test] <text>` in the test channel as the reporter; returns its ts. */
  reporterPosts(text: string): Promise<string>;
  /** Reacts with `emoji` on `ts` as the engineer. */
  engineerReacts(ts: string, emoji: string): Promise<void>;
  /** The anchor and every reply in its thread, read with the bot token. */
  thread(anchorTs: string): Promise<SlackMessage[]>;
  /** One message of the thread, or undefined once deleted. */
  message(anchorTs: string, ts: string): Promise<SlackMessage | undefined>;
  /** The bot's own user id (`auth.test`). */
  botUserId(): Promise<string>;
  /**
   * Deletes the run's thread: every bot reply (unpinned first), then the anchor with the reporter's
   * token. Returns what could not be deleted; a message already gone is not a failure.
   */
  cleanupThread(anchorTs: string): Promise<string[]>;
}

export function createSlackDriver(o: SlackDriverOptions): SlackDriver {
  let botId: string | undefined;
  const gone = (e: unknown): boolean => e instanceof SlackApiError && ['message_not_found', 'thread_not_found', 'no_pin', 'not_pinned', 'no_reaction'].includes(e.error);

  const driver: SlackDriver = {
    async reporterPosts(text) {
      const body = await slackCall(o.reporter.token, 'chat.postMessage', { channel: o.channel, text: `${PREFIX} ${text}` });
      return String(body['ts']);
    },
    async engineerReacts(ts, emoji) {
      await slackCall(o.engineer.token, 'reactions.add', { channel: o.channel, timestamp: ts, name: emoji });
    },
    async thread(anchorTs) {
      const out: SlackMessage[] = [];
      let cursor = '';
      do {
        const body = await slackCall(o.botToken, 'conversations.replies', { channel: o.channel, ts: anchorTs, limit: '200', ...(cursor === '' ? {} : { cursor }) });
        out.push(...((body['messages'] as SlackMessage[] | undefined) ?? []));
        cursor = String((body['response_metadata'] as Rec | undefined)?.['next_cursor'] ?? '');
      } while (cursor !== '');
      return out;
    },
    async message(anchorTs, ts) {
      try {
        return (await driver.thread(anchorTs)).find((m) => m.ts === ts);
      } catch (e) {
        if (gone(e)) return undefined;
        throw e;
      }
    },
    async botUserId() {
      botId ??= String((await slackCall(o.botToken, 'auth.test', {}))['user_id'] ?? '');
      return botId;
    },
    async cleanupThread(anchorTs) {
      const failures: string[] = [];
      let messages: SlackMessage[] = [];
      try {
        messages = await driver.thread(anchorTs);
      } catch (e) {
        if (!gone(e)) failures.push(`read thread ${anchorTs}: ${String(e)}`);
      }
      const bot = await driver.botUserId();
      const replies = messages.filter((m) => m.ts !== anchorTs && (m.user === bot || m.bot_id !== undefined));
      // Newest first; a pinned message is unpinned before it goes.
      for (const m of [...replies].reverse()) {
        await slackCall(o.botToken, 'pins.remove', { channel: o.channel, timestamp: m.ts }).catch(() => undefined);
        await slackCall(o.botToken, 'chat.delete', { channel: o.channel, ts: m.ts }).catch((e: unknown) => {
          if (!gone(e)) failures.push(`delete reply ${m.ts}: ${String(e)}`);
        });
      }
      const others = messages.filter((m) => m.ts !== anchorTs && !replies.includes(m));
      for (const m of others) {
        const token = m.user === o.reporter.id ? o.reporter.token : m.user === o.engineer.id ? o.engineer.token : undefined;
        if (token === undefined) {
          failures.push(`reply ${m.ts} by another user was left in place`);
          continue;
        }
        await slackCall(token, 'chat.delete', { channel: o.channel, ts: m.ts }).catch((e: unknown) => {
          if (!gone(e)) failures.push(`delete reply ${m.ts}: ${String(e)}`);
        });
      }
      await slackCall(o.reporter.token, 'chat.delete', { channel: o.channel, ts: anchorTs }).catch((e: unknown) => {
        if (!gone(e)) failures.push(`delete anchor ${anchorTs}: ${String(e)}`);
      });
      return failures;
    },
  };
  return driver;
}

/** The `block_id`s of a message's blocks. */
export function blockIdsOf(m: SlackMessage): string[] {
  return (m.blocks ?? []).flatMap((b) => (typeof b['block_id'] === 'string' ? [b['block_id']] : []));
}

/** The buttons of the actions block `blockId` (empty once the card was answered). */
export function buttonsOf(m: SlackMessage, blockId: string): SlackButton[] {
  const block = (m.blocks ?? []).find((b) => b['block_id'] === blockId);
  const elements = Array.isArray(block?.['elements']) ? (block['elements'] as Rec[]) : [];
  return elements.filter((e) => e['type'] === 'button' && typeof e['action_id'] === 'string') as unknown as SlackButton[];
}

/** The text a message shows: its section and context blocks, else its `text`. */
export function textOf(m: SlackMessage): string {
  const parts: string[] = [];
  for (const b of m.blocks ?? []) {
    const text = (b['text'] as { text?: unknown } | undefined)?.text;
    if (typeof text === 'string') parts.push(text);
    for (const e of Array.isArray(b['elements']) ? (b['elements'] as { text?: unknown }[]) : []) if (typeof e.text === 'string') parts.push(e.text);
  }
  return parts.length > 0 ? parts.join(' ') : (m.text ?? '');
}

/** A `block_actions` payload for a tap on `actionId` of the card `m` by `userId`, shaped like Slack's. */
export function blockActions(input: { userId: string; channel: string; anchorTs: string; card: SlackMessage; blockId: string; actionId: string }): Rec {
  const button = buttonsOf(input.card, input.blockId).find((b) => b.action_id === input.actionId);
  if (button === undefined) throw new Error(`no ${input.actionId} button on the ${input.blockId} card`);
  return {
    type: 'block_actions',
    user: { id: input.userId },
    channel: { id: input.channel },
    container: { type: 'message', channel_id: input.channel, message_ts: input.card.ts, is_ephemeral: false },
    message: { ts: input.card.ts, thread_ts: input.anchorTs, blocks: input.card.blocks ?? [] },
    actions: [{ type: 'button', action_id: input.actionId, block_id: input.blockId, value: button.value, text: { type: 'plain_text', text: button.text.text } }],
  };
}
