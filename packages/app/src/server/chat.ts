// The chat seam (#368, main 15.2 parity rule): every outbound chat effect compose performs outside an
// adapter's own inbound path and the status projectors, named once per platform, and a router that picks
// the platform for each effect. Compose builds one `ChatSurface` per configured chat platform (Slack in
// `adapters/slack/chat-surface.ts`; Teams plugs in the same way) and reaches chat only through the router.
//
// How the router picks a surface:
//   - an incident's effects (thread posts, the escalation and heartbeat posts in its thread, the PR card,
//     the text-signal cards, the mid-flight card) go to the surface of `incident.source` (`chatFor`); an
//     incident whose source has no surface (a CLI capture on an install without one) is logged and skipped,
//     as is one with no thread to post in;
//   - a channel (`#name`, a name, or an id: a digest, a ladder step's channel, the ux-friction post) goes
//     to the platform of that map channel; until the map names a channel's platform (#367), the default
//     surface, which is Slack whenever Slack is configured;
//   - a person (`@handle`, an email, or a chat user id: a digest) goes to the first surface, in configured
//     order, on which the map gives them an id, else the default surface.
//
// The router records every thread post (thread posts, escalation thread posts, the mid-flight card) as
// `bot-message-posted` role `other` (A 1.3), best effort, so a reaction on it resolves to the incident and
// counts as activity; the surface only posts. The PR card and the scope card are recorded by their own
// ports, as before.

import type { ChannelSource } from '@snapwing/pipeline/contracts/incident.ts';
import type { IncidentView } from '@snapwing/pipeline/contracts/state.ts';
import type { MidFlightCard } from '@snapwing/pipeline/fixer/claims.ts';
import type { MapChannel, MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { ChatTarget, PrReadyChat } from '@snapwing/pipeline/merge/human.ts';
import type { EscalationChat, EscalationPost } from '@snapwing/pipeline/monitor/ladder.ts';
import type { ChatPlatform, StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage, type PostedMessage } from '@snapwing/pipeline/signals/messages.ts';
import type { TextSignalPorts } from '@snapwing/pipeline/signals/text.ts';

/** A message a surface posted: where it landed and its id on the platform. */
export interface ChatPosted {
  channel: string;
  messageId: string;
}

/** The text-signal cards (A 3): the resolution question and the scope-change card. */
export type ChatTextCards = Pick<TextSignalPorts, 'askResolution' | 'postScopeCard'>;

/** One chat platform's outbound effects. Ids are the platform's own (channel, thread, user). */
export interface ChatSurface {
  readonly platform: ChatPlatform;
  /** Posts `text` in `target`'s thread (or the channel when it has none). The router records it. */
  threadPost(target: ChatTarget, text: string): Promise<ChatPosted>;
  /** Posts to a channel: `#name` or a name from the map, or a channel id. */
  channelPost(channel: string, text: string): Promise<void>;
  /** Posts to a person directly: `@handle` or an email from the map, or a user id on this platform. */
  personPost(person: string, text: string): Promise<void>;
  /** A person reference (a user id, a map handle, or an email) as this platform's mention. */
  mention(map: WorkspaceMap, ref: string): string;
  /** A user id on this platform as its mention. */
  mentionUser(userId: string): string;
  /** The PR-ready card and the private link prompt (main 11.2). */
  readonly prReady: PrReadyChat;
  /** The text-signal cards (A 3). */
  readonly textCards: ChatTextCards;
  /** Posts the mid-flight claim card (A 2.2) in `target`'s thread. The router records it. */
  postMidFlightCard(target: ChatTarget, incidentId: string, card: MidFlightCard): Promise<ChatPosted>;
  /** Refreshes the cached members of every map channel on this platform (A 4.4). */
  refreshChannelMembers(): Promise<void>;
  /** True when this platform's user has a usable linked GitHub identity (main 11.2). */
  githubLinked(userId: string): Promise<boolean>;
}

/** A thread post: the text, and the person it addresses (named in the text as `@handle`) when there is one. */
export interface ChatThreadMessage {
  text: string;
  /** A chat user id on the incident's platform; its `@handle` in the text becomes a real mention. */
  mentionUserId?: string;
}

export interface ChatRouter {
  /** The configured platforms, the default first. */
  readonly platforms: readonly ChatPlatform[];
  surface(platform: ChatPlatform): ChatSurface | undefined;
  /** The incident's surface, by `incident.source`; none (logged, naming `what`) when its source has none. */
  chatFor(incident: IncidentView | null, what?: string): ChatSurface | undefined;
  /** The platform an incident's people are named on: its source's when that is a configured surface, else the default. */
  platformFor(incident: IncidentView | null): ChatPlatform;
  /** Posts in the incident's thread and records it (role `other`). */
  threadPost(incidentId: string, message: ChatThreadMessage): Promise<void>;
  /** Posts to a channel (`#name`, a name, or an id) on that channel's platform. */
  channelPost(channel: string, text: string): Promise<void>;
  /** Posts to a channel (`#name`) or a person (`@handle`, an email, or a chat user id): a digest's `to`. */
  postTo(to: string, text: string): Promise<void>;
  /** Ladder steps, reaction ladder notes, and heartbeats (A 1.4, A 4.5, A 6.2). */
  readonly escalation: EscalationChat;
  /** The PR-ready card, on the incident's surface. */
  readonly prReady: PrReadyChat;
  /** The text-signal cards, on the incident's surface. */
  readonly textCards: ChatTextCards;
  /** The mid-flight card in the incident's thread, recorded (role `other`). */
  postMidFlightCard(incidentId: string, card: MidFlightCard): Promise<void>;
  /** Every surface's channel members; one platform failing does not stop the rest. */
  refreshChannelMembers(): Promise<void>;
}

export interface ChatRouterOptions {
  /** One per configured platform; the first is the default. */
  surfaces: readonly ChatSurface[];
  state: Pick<StatePort, 'getIncident' | 'read' | 'append'>;
  /** The current workspace map. */
  map: () => Promise<WorkspaceMap>;
  clock: () => Date;
  log: { info(line: string): void; error(line: string): void };
}

/** A person's user id on `platform`. */
export function chatUserIdOf(person: MapPerson, platform: ChatPlatform): string | undefined {
  const id = platform === 'slack' ? person.slackId : person.teamsId;
  return id === undefined || id === '' ? undefined : id;
}

/** The map person with this chat user id on any platform. */
export function personByChatId(map: Pick<WorkspaceMap, 'people'>, userId: string): MapPerson | undefined {
  return map.people.find((p) => p.slackId === userId || p.teamsId === userId);
}

function isChatPlatform(source: ChannelSource | string): source is ChatPlatform {
  return source === 'slack' || source === 'teams';
}

/** The map channel a reference names: `#name`, a name, or an id. */
function mapChannel(map: WorkspaceMap, ref: string): MapChannel | undefined {
  const named = ref.trim().replace(/^#/, '');
  return map.channels.find((c) => c.name === named || c.id === named);
}

/**
 * The platform a map channel lives on. The map names it once #367 lands (`platform`); until then every
 * channel belongs to the default surface.
 */
function channelPlatform(channel: MapChannel | undefined): ChatPlatform | undefined {
  if (channel === undefined || !('platform' in channel)) return undefined;
  const platform: unknown = channel.platform;
  return platform === 'slack' || platform === 'teams' ? platform : undefined;
}

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

export function createChatRouter(options: ChatRouterOptions): ChatRouter {
  const { surfaces, state, log } = options;
  const first = surfaces[0];
  if (first === undefined) throw new Error('the chat router needs at least one chat surface');
  const defaultSurface: ChatSurface = first;
  const byPlatform = new Map<ChatPlatform, ChatSurface>();
  for (const s of surfaces) {
    if (byPlatform.has(s.platform)) throw new Error(`two chat surfaces for ${s.platform}`);
    byPlatform.set(s.platform, s);
  }

  function chatFor(incident: IncidentView | null, what = 'chat post'): ChatSurface | undefined {
    if (incident === null) return undefined;
    const surface = isChatPlatform(incident.source) ? byPlatform.get(incident.source) : undefined;
    if (surface === undefined) log.info(`${what} for incident ${incident.id} skipped: its source ${incident.source} has no chat surface`);
    return surface;
  }

  /** The incident's surface and thread, or nothing (logged) when either is missing. */
  async function threadOf(incidentId: string, what: string): Promise<{ surface: ChatSurface; target: ChatTarget } | undefined> {
    const incident = await state.getIncident(incidentId);
    if (incident === null) {
      log.info(`${what} for incident ${incidentId} skipped: no such incident`);
      return undefined;
    }
    const surface = chatFor(incident, what);
    if (surface === undefined) return undefined;
    if (incident.channelId === undefined) {
      log.info(`${what} for incident ${incidentId} skipped: it has no ${surface.platform} thread`);
      return undefined;
    }
    return { surface, target: { channel: incident.channelId, ...(incident.anchorId === undefined ? {} : { threadId: incident.anchorId }) } };
  }

  async function record(incidentId: string, platform: ChatPlatform, posted: ChatPosted, what: string): Promise<void> {
    const ref: PostedMessage = { platform, channel: posted.channel, messageId: posted.messageId, role: 'other' };
    await recordBotMessage(state, incidentId, ref, options.clock).catch((e: unknown) => log.error(`${what} record: ${message(e)}`));
  }

  async function surfaceForChannel(channel: string): Promise<ChatSurface> {
    const platform = channelPlatform(mapChannel(await options.map(), channel));
    return (platform === undefined ? undefined : byPlatform.get(platform)) ?? defaultSurface;
  }

  async function incidentSurface(incidentId: string, what: string): Promise<ChatSurface | undefined> {
    const incident = await state.getIncident(incidentId);
    if (incident === null) log.info(`${what} for incident ${incidentId} skipped: no such incident`);
    return chatFor(incident, what);
  }

  const escalation: EscalationChat = {
    async post(post: EscalationPost): Promise<void> {
      const map = await options.map();
      if (post.where.kind === 'channel') {
        const surface = await surfaceForChannel(post.where.channel);
        await surface.channelPost(post.where.channel, withMention(surface, map, post));
        return;
      }
      const surface = await incidentSurface(post.incidentId, 'escalation post');
      if (surface === undefined) return;
      const target: ChatTarget = { channel: post.where.channel, ...(post.where.threadId === undefined ? {} : { threadId: post.where.threadId }) };
      const posted = await surface.threadPost(target, withMention(surface, map, post));
      // Recorded, so a reaction on it resolves to the incident (best effort: the post is out).
      await record(post.incidentId, surface.platform, posted, 'escalation post');
    },
  };

  const prReady: PrReadyChat = {
    async postPrReady(target, incidentId, card, opts) {
      const surface = await incidentSurface(incidentId, 'pr card');
      await surface?.prReady.postPrReady(target, incidentId, card, opts);
    },
    async postLinkPrompt(userId, target, incidentId, card, linkUrl) {
      const surface = await incidentSurface(incidentId, 'pr card link prompt');
      await surface?.prReady.postLinkPrompt(userId, target, incidentId, card, linkUrl);
    },
  };

  const textCards: ChatTextCards = {
    async askResolution(incidentId, prompt) {
      const surface = await incidentSurface(incidentId, 'resolution question');
      await surface?.textCards.askResolution(incidentId, prompt);
    },
    async postScopeCard(incidentId, card) {
      const surface = await incidentSurface(incidentId, 'scope card');
      return surface?.textCards.postScopeCard(incidentId, card);
    },
  };

  return {
    platforms: surfaces.map((s) => s.platform),
    surface: (platform) => byPlatform.get(platform),
    chatFor,
    platformFor: (incident) => (incident !== null && isChatPlatform(incident.source) && byPlatform.has(incident.source) ? incident.source : defaultSurface.platform),

    async threadPost(incidentId, msg) {
      const where = await threadOf(incidentId, 'thread post');
      if (where === undefined) return;
      const { surface, target } = where;
      let text = msg.text;
      const id = msg.mentionUserId;
      if (id !== undefined) {
        // The text names people as `@handle`; on the platform the one it addresses is a real mention.
        const handle = personByChatId(await options.map(), id)?.handle ?? id;
        text = text.split(`@${handle}`).join(surface.mentionUser(id));
      }
      const posted = await surface.threadPost(target, text);
      await record(incidentId, surface.platform, posted, 'thread post');
    },

    async channelPost(channel, text) {
      const surface = await surfaceForChannel(channel);
      await surface.channelPost(channel, text);
    },

    async postTo(to, text) {
      const t = to.trim();
      if (t.startsWith('#')) {
        const surface = await surfaceForChannel(t);
        await surface.channelPost(t, text);
        return;
      }
      const map = await options.map();
      const person = map.people.find((p) => (t.startsWith('@') ? p.handle === t.slice(1) : p.email === t || p.slackId === t || p.teamsId === t));
      const surface = (person === undefined ? undefined : surfaces.find((s) => chatUserIdOf(person, s.platform) !== undefined)) ?? defaultSurface;
      await surface.personPost(t, text);
    },

    escalation,
    prReady,
    textCards,

    async postMidFlightCard(incidentId, card) {
      const where = await threadOf(incidentId, 'mid-flight card');
      if (where === undefined) return;
      const posted = await where.surface.postMidFlightCard(where.target, incidentId, card);
      await record(incidentId, where.surface.platform, posted, 'thread post');
    },

    async refreshChannelMembers() {
      for (const s of surfaces) {
        try {
          await s.refreshChannelMembers();
        } catch (e) {
          log.error(`channel members (${s.platform}): ${message(e)}`);
        }
      }
    },
  };
}

/** A post's text with its mention (a user id, a map handle, or an email) rendered for `surface`. */
function withMention(surface: ChatSurface, map: WorkspaceMap, post: EscalationPost): string {
  const who = post.mention === undefined ? undefined : surface.mention(map, post.mention);
  return who === undefined ? post.text : `${who} ${post.text}`;
}
