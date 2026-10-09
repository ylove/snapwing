// Who wrote a Slack message event: Snapwing itself, another bot, or a person.
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
//
// Who a person is to the workspace, for the reactors who count toward a trigger (#170), in order:
//
//   external  a bot user (a bot is never a member, #272).
//   external  `users.info` fails or was not given (fail closed), or its `team_id` is not the
//             workspace's (someone from another organization in a Slack Connect channel). On
//             Enterprise Grid, a user from another workspace of the same organization (same
//             enterprise id as `auth.test`) is not external; one from another organization is.
//   guest     `is_restricted` or `is_ultra_restricted` (a multi-channel or single-channel guest).
//   member    anyone else.
//
// Both questions read one remembered `users.info` answer per user.

import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { Membership } from '@snapwing/pipeline/policy/autonomy.ts';

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
  /** Member, guest, or external, from `users.info` (see the file header). */
  membership(user: string): Promise<Membership>;
  /** True when `users.info` says the user is a bot; false when it fails or was not given (#272: a bot is no reactor). */
  isBot?(user: string): Promise<boolean>;
}

/** The `users.info` fields authorship reads. */
export interface SlackUserFacts {
  is_bot?: boolean;
  is_restricted?: boolean;
  is_ultra_restricted?: boolean;
  team_id?: string;
  /** Enterprise Grid: the user's organization, in either shape `users.info` returns. */
  enterprise_id?: string;
  enterprise_user?: { enterprise_id?: string };
}

export interface SlackAuthorshipOptions {
  /** Snapwing's bot user id (`auth.test` `user_id`). */
  botUserId: string;
  /** Snapwing's bot id (`auth.test` `bot_id`); absent: only the user id marks its own messages. */
  botId?: string;
  /** The workspace's team id (`auth.test` `team_id`); a user with another is external. Absent: not compared. */
  teamId?: string;
  /** The workspace's enterprise id (`auth.test` `enterprise_id`, Enterprise Grid only); a user of the same organization is not external. */
  enterpriseId?: string;
  /**
   * `users.info` for a user the map does not name, and for a trigger's reactors. Absent: such a user's
   * message with `bot_id` is a bot's, and every reactor is external.
   */
  usersInfo?: (user: string) => Promise<SlackUserFacts>;
}

/** Remembered `users.info` answers; a user's bot flag, guest flags, and team do not change. */
const MAX_REMEMBERED = 1000;

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

export function createSlackAuthorOf(options: SlackAuthorshipOptions): SlackAuthorOf {
  const known = new Map<string, Promise<SlackUserFacts | undefined>>();

  /** The user's `users.info` answer, or undefined when it failed or there is no lookup. */
  function factsOf(user: string): Promise<SlackUserFacts | undefined> {
    const lookup = options.usersInfo;
    if (lookup === undefined) return Promise.resolve(undefined);
    let answer = known.get(user);
    if (answer === undefined) {
      answer = lookup(user).then(
        (u) => u,
        () => {
          // Not remembered: the next message asks again.
          known.delete(user);
          return undefined;
        },
      );
      known.set(user, answer);
      if (known.size > MAX_REMEMBERED) known.delete(known.keys().next().value as string);
    }
    return answer;
  }

  async function isBotUser(user: string): Promise<boolean> {
    const facts = await factsOf(user);
    return facts === undefined || facts.is_bot === true;
  }

  /** Enterprise Grid: another workspace of the same organization. */
  function sameOrganization(facts: SlackUserFacts): boolean {
    const mine = options.enterpriseId;
    if (mine === undefined || mine === '') return false;
    return (facts.enterprise_user?.enterprise_id ?? facts.enterprise_id) === mine;
  }

  async function membership(user: string): Promise<Membership> {
    const facts = await factsOf(user);
    if (facts === undefined || facts.is_bot === true) return 'external';
    if (options.teamId !== undefined && options.teamId !== '' && facts.team_id !== options.teamId && !sameOrganization(facts)) return 'external';
    return facts.is_restricted === true || facts.is_ultra_restricted === true ? 'guest' : 'member';
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
  const isBot = async (user: string): Promise<boolean> => (await factsOf(user))?.is_bot === true;
  return Object.assign(authorOf, { plainly, membership, isBot });
}
