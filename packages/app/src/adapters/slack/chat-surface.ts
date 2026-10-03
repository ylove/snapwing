// The Slack chat surface (#368): Slack's side of the chat seam (`server/chat.ts`), the outbound effects
// compose used to perform inline. Thread, channel, and direct posts through `chat.postMessage` (a user
// id as the channel opens the app's DM); mentions as `<@U...>`; the PR card (`createSlackPrReadyChat`,
// recorded as role `pr`); the text-signal cards (`createSlackTextCards`); the mid-flight card
// (`buildMidFlightCard`); channel members in kv (`createSlackChannelMembers`, A 4.4); and the GitHub
// link check through the OAuth store, keyed `chat: 'slack'`.
//
// The router records thread posts; this file only posts. Map lookups here are Slack's: a channel by its
// name or Slack id, a person by handle or email to their `slackId`.

import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { IdentityLinks, PrReadyChat } from '@snapwing/pipeline/merge/human.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { parseDuration } from '@snapwing/pipeline/util/duration.ts';
import type { ChatSurface } from '../../server/chat.ts';
import { buildMidFlightCard } from './cards/mid-flight.ts';
import { createSlackChannelMembers, type SlackChannelMembers } from './channel-members.ts';
import { createSlackPrReadyChat } from './pr-ready.ts';
import { createSlackTextCards } from './signals.ts';
import type { SlackWeb } from './web.ts';

export interface SlackChatSurfaceOptions {
  web: SlackWeb;
  state: Pick<StatePort, 'getIncident' | 'read' | 'append'>;
  cache: CachePort;
  /** The current workspace map (channel members read every map channel). */
  getMap: () => Promise<WorkspaceMap>;
  identity: Pick<IdentityLinks, 'isLinked'>;
  /** Replaces the PR card's Slack side (a test seam). Default `createSlackPrReadyChat`. */
  prReady?: PrReadyChat;
  log: { info(line: string): void; error(line: string): void };
}

/** The Slack surface, plus the channel members the inbound path updates on membership events. */
export interface SlackChatSurface extends ChatSurface {
  readonly platform: 'slack';
  readonly channelMembers: SlackChannelMembers;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * A person reference from a ladder step or the owner (a Slack user id, a map handle, or an email) as a
 * Slack mention; a reference the map does not know stays `@name`.
 */
export function slackMention(map: WorkspaceMap, ref: string): string {
  const r = ref.trim().replace(/^@/, '');
  const person = map.people.find((p) => p.slackId === r || p.handle === r || (p.email !== undefined && p.email === r));
  if (person?.slackId !== undefined) return `<@${person.slackId}>`;
  return /^[UW][A-Z0-9]{2,}$/.test(r) ? `<@${r}>` : `@${r}`;
}

/** A channel reference (`#name`, a name, or an id) as the Slack channel to post to; unknown stays as given. */
export function slackChannel(map: WorkspaceMap, ref: string): string {
  const named = ref.trim().replace(/^#/, '');
  return map.channels.find((c) => c.name === named || c.id === named)?.id ?? ref;
}

/** A person reference (`@handle` or an email) as their Slack id; anything else (a Slack id) stays as given. */
export function slackPerson(map: WorkspaceMap, ref: string): string {
  const t = ref.trim();
  const person = map.people.find((p) => (t.startsWith('@') ? p.handle === t.slice(1) : p.email === t));
  return person?.slackId ?? t;
}

export function createSlackChatSurface(options: SlackChatSurfaceOptions): SlackChatSurface {
  const { web, state, log } = options;
  const channelMembers = createSlackChannelMembers({
    web,
    cache: options.cache,
    getMap: options.getMap,
    onSkip: (channel, error) => log.info(`channel members of ${channel} unknown (${error}): watchers there are mentioned in the thread`),
    onError: (e) => log.error(`channel members: ${message(e)}`),
  });
  return {
    platform: 'slack',
    channelMembers,

    async threadPost(target, text) {
      const posted = await web.postMessage({ channel: target.channel, text, ...(target.threadId === undefined ? {} : { thread_ts: target.threadId }) });
      return { channel: posted.channel, messageId: posted.ts };
    },

    async channelPost(channel, text) {
      await web.postMessage({ channel: slackChannel(await options.getMap(), channel), text });
    },

    async personPost(person, text) {
      await web.postMessage({ channel: slackPerson(await options.getMap(), person), text });
    },

    mention: slackMention,
    mentionUser: (userId) => `<@${userId}>`,

    prReady: options.prReady ?? createSlackPrReadyChat({ web, state, onError: (e) => log.error(`pr card record: ${message(e)}`) }),
    textCards: createSlackTextCards({ web, state }),

    async postMidFlightCard(target, incidentId, card) {
      const built = buildMidFlightCard(incidentId, card, parseDuration(card.grace));
      const posted = await web.postMessage({
        channel: target.channel,
        text: built.text,
        blocks: [...built.blocks],
        ...(target.threadId === undefined ? {} : { thread_ts: target.threadId }),
      });
      return { channel: posted.channel, messageId: posted.ts };
    },

    async refreshChannelMembers() {
      await channelMembers.refreshAll();
    },

    githubLinked: (userId) => options.identity.isLinked({ chat: 'slack', userId }),
  };
}
