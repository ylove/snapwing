// Who wrote a Slack message event: Snapwing itself, another bot, or a person (#360).
//
// A person who posts through an app with their own user token (a Shortcuts-style integration, the e2e
// "Snapwing Test Driver") gets `bot_id` and `app_id` on the message, and `user` is the person. A bot
// posting with its bot token looks the same: `user` is its bot user, plus `bot_id`. So `bot_id` alone
// cannot tell them apart, and dropping every message that carries it drops people. In order:
//
//   own     `user` is Snapwing's bot user, or `bot_id` is Snapwing's own (both from `auth.test`).
//   bot     `subtype: bot_message` (a legacy integration or an incoming webhook), or `bot_id` with no
//           `user`.
//   person  no `bot_id`.
//   person  `bot_id`, and the user is a person in the workspace map.
//   person  `bot_id`, and `users.info` says the user is not a bot (asked once per user per process).
//   bot     `bot_id`, and `users.info` says it is a bot, fails, or was not given.
//
// The inbound paths that read people's messages (the status query, direct-message capture, thread
// replies as signals) share one `SlackAuthorOf`, so they agree on who is a person.

import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';

export type MessageAuthor = 'own' | 'bot' | 'person';

type SlackEvent = Readonly<Record<string, unknown>>;

/** Classifies a message event (the Events API `event` object) against the current map. */
export interface SlackAuthorOf {
  (event: SlackEvent, map: WorkspaceMap): Promise<MessageAuthor>;
  /**
   * What the event alone says, for a synchronous routing decision: `own` or `bot` when no lookup could
   * change it, else undefined (a person, or a `bot_id` the map or `users.info` must settle).
   */
  plainly(event: SlackEvent): 'own' | 'bot' | undefined;
}

export interface SlackAuthorshipOptions {
  /** Snapwing's bot user id (`auth.test` `user_id`). */
  botUserId: string;
  /** Snapwing's bot id (`auth.test` `bot_id`); absent: only the user id marks its own messages. */
  botId?: string;
  /** `users.info` for a user the map does not name. Absent: such a user's message with `bot_id` is a bot's. */
  usersInfo?: (user: string) => Promise<{ is_bot?: boolean }>;
}

/** Remembered `users.info` answers; a user's bot flag does not change. */
const MAX_REMEMBERED = 1000;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createSlackAuthorOf(options: SlackAuthorshipOptions): SlackAuthorOf {
  const known = new Map<string, Promise<boolean>>();

  function isBotUser(user: string): Promise<boolean> {
    const lookup = options.usersInfo;
    if (lookup === undefined) return Promise.resolve(true);
    let answer = known.get(user);
    if (answer === undefined) {
      answer = lookup(user).then(
        (u) => u.is_bot === true,
        () => {
          // Not remembered: the next message asks again.
          known.delete(user);
          return true;
        },
      );
      known.set(user, answer);
      if (known.size > MAX_REMEMBERED) known.delete(known.keys().next().value as string);
    }
    return answer;
  }

  function plainly(event: SlackEvent): 'own' | 'bot' | undefined {
    const user = str(event['user']);
    const botId = str(event['bot_id']);
    if (user !== '' && user === options.botUserId) return 'own';
    if (botId !== '' && options.botId !== undefined && options.botId !== '' && botId === options.botId) return 'own';
    if (str(event['subtype']) === 'bot_message') return 'bot';
    if (botId !== '' && user === '') return 'bot';
    return undefined;
  }

  const authorOf = async (event: SlackEvent, map: WorkspaceMap): Promise<MessageAuthor> => {
    const plain = plainly(event);
    if (plain !== undefined) return plain;
    const user = str(event['user']);
    if (str(event['bot_id']) === '') return 'person';
    if (map.people.some((p) => p.slackId === user)) return 'person';
    return (await isBotUser(user)) ? 'bot' : 'person';
  };
  return Object.assign(authorOf, { plainly });
}
