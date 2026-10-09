// The Teams chat surface (#10): Teams' side of the chat seam (`server/chat.ts`), the outbound effects
// compose performs outside the adapter's own inbound path, as `adapters/slack/chat-surface.ts` does for
// Slack. Thread posts, channel posts, and personal posts through the Bot Connector; `<at>` mentions from
// the map; the PR card and the GitHub link prompt (`createTeamsPrReadyChat`); the text-signal cards; the
// mid-flight card; channel members in kv (`createTeamsChannelMembers`, A 4.4); and the GitHub link check
// through the OAuth store, keyed `chat: 'teams'`.
//
// The router records thread posts; this file only posts.
//
// Where things go:
// - A thread post goes to the incident's channel thread (`replyToActivity` with the thread root), or to
//   the chat itself for a personal or group chat, where threads do not apply. The Connector needs the
//   conversation's `serviceUrl`: kv `teams-conversation:{channelId}` (the adapter refreshes it on every
//   authenticated activity), else `options.serviceUrl`.
// - A channel is a map channel by name or id (`#web-bugs-teams`, or `19:...@thread.tacv2`).
// - A person is reached in their personal chat with the bot, which Teams opens only where the app is
//   installed for them (`createPersonalConversation`; main 15.2). Without it, a person post is
//   dropped with an info log (it has no thread to mention them in), and a card meant for one person goes to the thread with a
//   mention (a link prompt says so without the link: see `pr-ready.ts`).
// - Opening a personal chat sends the user's `29:` Teams id in `members[].id` when an inbound activity
//   gave one (kv `teams-user:{aadObjectId}`, written by `rememberUser`), the AAD object id in
//   `aadObjectId`, and the bot's app id as `botId`. Real Teams may want that `29:` id; there is no
//   tenant to confirm it on in this build.
// - A mention is `<at>handle</at>` text plus a `mention` entity keyed by the AAD object id (`teamsId`);
//   a person the map does not list is `<at>` the name Teams gave them (`from.name`, kept in their user
//   record by `rememberUser`), never a raw id. Only the mentions this surface emits become one:
//   `mention` and `mentionUser` return a mark (`adapters/shared/mention-marks.ts`), and a text post
//   turns those marks into `<at>` tags with entities and escapes `<` and `>` everywhere else. An `<at>...</at>` inside user text (an incident
//   summary, a digest line, a task summary) is shown as text, with no entity, and notifies nobody.
// - Teams reads a message's text as Markdown, so the same escape also turns the link and emphasis
//   characters (`[`, `]`, `*`, `_`, `~`, a backtick, a backslash) into character references (#269): user text
//   cannot add a link or restyle the bot's words. The mention tags this surface emits are never escaped.

import type { MidFlightCard } from '@snapwing/pipeline/fixer/claims.ts';
import type { MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { channelPlatform } from '@snapwing/pipeline/map/types.ts';
import type { ChatTarget, IdentityLinks, PrReadyChat } from '@snapwing/pipeline/merge/human.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import type { PostedMessage } from '@snapwing/pipeline/signals/messages.ts';
import { parseDuration } from '@snapwing/pipeline/util/duration.ts';
import type { ChatPosted, ChatSurface, ChatTextCards } from '../../server/chat.ts';
import { createMentionMarks, type MentionMarks } from '../shared/mention-marks.ts';
import { buildMidFlightCard } from './cards/mid-flight.ts';
import { renderText, mentionsFromMap, mentionsOr, textBlock, type AdaptiveCard, type MentionEntity } from './cards/elements.ts';
import { buildResolutionPrompt, buildScopeChangeCard } from './cards/signals.ts';
import { createTeamsChannelMembers, type TeamsChannelMembers } from './channel-members.ts';
import {
  readTeamsConversation,
  readTeamsMode,
  readTeamsUser,
  rememberedNames,
  teamsUserKey,
  userFromActivity,
  type TeamsConversationType,
} from './conversations.ts';
import {
  TeamsApiError,
  TeamsError,
  TeamsForbiddenError,
  TeamsNotFoundError,
  type TeamsConnector,
  type TeamsOutgoingActivity,
} from './connector.ts';
import type { TeamsGraph } from './graph.ts';
import { cardMessage, createTeamsPrReadyChat, type TeamsDelivery } from './pr-ready.ts';

export interface TeamsChatSurfaceOptions {
  connector: Pick<TeamsConnector, 'sendToConversation' | 'replyToActivity' | 'createPersonalConversation'>;
  graph: Pick<TeamsGraph, 'channelMembers'>;
  state: Pick<StatePort, 'getIncident' | 'read' | 'append'>;
  /** kv: conversation records, team modes, user records, channel members. */
  cache: CachePort;
  /** The current workspace map (channels, people, channel members for every Teams channel). */
  getMap: () => Promise<WorkspaceMap>;
  identity: Pick<IdentityLinks, 'isLinked'>;
  /** The bot's app id, passed as `botId` when opening a personal chat. */
  botId?: string;
  /** The tenant, for a person no inbound activity has named one for. */
  tenantId?: string;
  /** The Connector endpoint for a conversation with no kv record (Bot Framework regional URL). */
  serviceUrl?: string;
  /** Replaces the PR card's Teams side (a test seam). Default `createTeamsPrReadyChat`. */
  prReady?: PrReadyChat;
  now?: () => Date;
  log: { info(line: string): void; error(line: string): void };
}

/** The Teams surface, plus the user record the inbound path keeps and the channel members. */
export interface TeamsChatSurface extends ChatSurface {
  readonly platform: 'teams';
  readonly channelMembers: TeamsChannelMembers;
  /** Remembers who an inbound activity's sender is (`29:` id, name, serviceUrl, tenant): their personal chat, their name. */
  rememberUser(activity: unknown): Promise<void>;
}

export { teamsUserKey, userFromActivity, type TeamsUserRecord } from './conversations.ts';

function message(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The map person a reference names: `@handle`, an email, or a user id (AAD object id, Slack id). */
function personOf(map: Pick<WorkspaceMap, 'people'>, ref: string): MapPerson | undefined {
  const t = ref.trim();
  if (t.startsWith('@')) return map.people.find((p) => p.handle === t.slice(1));
  return map.people.find((p) => p.teamsId === t || p.handle === t || (p.email !== undefined && p.email === t) || p.slackId === t);
}

/**
 * A person reference from a ladder step or the owner (a Teams id, a map handle, or an email) as a Teams
 * mention: the mark of their AAD object id, which a post turns into `<at>handle</at>` and an entity; a
 * reference the map has no Teams id for stays `@name`.
 */
export function teamsMention(marks: Pick<MentionMarks, 'mark'>, map: WorkspaceMap, ref: string): string {
  const r = ref.trim().replace(/^@/, '');
  const person = personOf(map, r);
  if (person?.teamsId !== undefined && person.teamsId !== '') return marks.mark(person.teamsId);
  return `@${r}`;
}

/** A channel reference (`#name`, a name, or an id) as the Teams channel id to post to; unknown stays as given. */
export function teamsChannel(map: WorkspaceMap, ref: string): string {
  const named = ref.trim().replace(/^#/, '');
  return map.channels.find((c) => channelPlatform(c) === 'teams' && (c.name === named || c.id === named))?.id ?? ref;
}

/** A person reference (`@handle` or an email) as their AAD object id; anything else (an id) stays as given. */
export function teamsPerson(map: WorkspaceMap, ref: string): string {
  const t = ref.trim();
  const person = t.includes('@') ?personOf(map, t) : undefined;
  return person?.teamsId ?? t;
}

const AT_TAG = /<at>([^<]*)<\/at>/g;

/** The Markdown link and emphasis characters, as the character references Teams shows as themselves. */
const MARKDOWN_REFS: Readonly<Record<string, string>> = { '[': '&#91;', ']': '&#93;', '*': '&#42;', _: '&#95;', '~': '&#126;', '`': '&#96;', '\\': '&#92;' };

/**
 * Escapes what Teams reads as markup in a message's text: user text can never open an `<at>` tag, and
 * never add a Markdown link or emphasis.
 */
function escapeText(text: string): string {
  return text.replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/[[\]*_~`\\]/g, (c) => MARKDOWN_REFS[c] ?? c);
}

/**
 * Text as a message activity: each mark whose ref is a map handle or a Teams id becomes `<at>handle</at>`
 * with a mention entity keyed by the AAD object id, a mark whose ref is an AAD object id in `names` (a
 * person outside the map) `<at>` the name Teams gave them, any other mark `@ref`; everything else is
 * escaped, so no other `<at>` reaches Teams.
 */
export function mentionActivity(
  marks: Pick<MentionMarks, 'render'>,
  map: WorkspaceMap,
  text: string,
  names: ReadonlyMap<string, string> = new Map(),
): TeamsOutgoingActivity {
  const entities: MentionEntity[] = [];
  const out = marks.render(text, escapeText, (name) => {
    const person = personOf(map, name);
    const id = person?.teamsId !== undefined && person.teamsId !== '' ? person.teamsId : names.has(name) ? name : undefined;
    if (id === undefined) return escapeText(`@${name}`);
    const shown = (person?.teamsId === id ? person.handle : (names.get(name) ?? name)).replace(/[<>]/g, '');
    const tag = `<at>${shown}</at>`;
    if (!entities.some((e) => e.mentioned.id === id)) entities.push({ type: 'mention', text: tag, mentioned: { id, name: shown } });
    return tag;
  });
  return { type: 'message', text: out, ...(entities.length === 0 ? {} : { entities }) };
}

/** A failure that means the bot cannot open or reach this person's personal chat, rather than a fault. */
function noPersonalChat(e: unknown): boolean {
  return e instanceof TeamsForbiddenError || e instanceof TeamsNotFoundError || (e instanceof TeamsApiError && e.status === 400);
}

/** The card with a line of mention text first, for a card that goes to a thread instead of one person. */
function withLead(card: AdaptiveCard, leadText: string, map: WorkspaceMap, names: ReadonlyMap<string, string>): AdaptiveCard {
  const lead = renderText(leadText, mentionsOr(mentionsFromMap(map.people), names));
  const entities = [...(card.msteams?.entities ?? [])];
  for (const e of lead.entities) if (!entities.some((x) => x.mentioned.id === e.mentioned.id)) entities.push(e);
  return { ...card, body: [textBlock(lead.text), ...card.body], ...(entities.length === 0 ? {} : { msteams: { entities } }) };
}

export function createTeamsChatSurface(options: TeamsChatSurfaceOptions): TeamsChatSurface {
  const { connector, cache, state, log } = options;
  const clock = options.now ?? (() => new Date());
  const onError = (what: string) => (e: unknown) => log.error(`${what}: ${message(e)}`);
  const marks = createMentionMarks();
  const channelMembers = createTeamsChannelMembers({
    graph: options.graph,
    cache,
    getMap: options.getMap,
    onSkip: (channel, reason) => log.info(`channel members of ${channel} unknown (${reason}): watchers there are mentioned in the thread`),
    onError: (e) => log.error(`channel members: ${message(e)}`),
  });

  /** Where a conversation is: its Connector endpoint, its kind, and its team. */
  async function locate(channelId: string): Promise<{ serviceUrl: string; type: TeamsConversationType; teamId?: string }> {
    const record = await readTeamsConversation(cache, channelId).catch(() => undefined);
    const serviceUrl = record?.serviceUrl ?? options.serviceUrl;
    if (serviceUrl === undefined) throw new TeamsError(`no serviceUrl known for conversation ${channelId}`);
    const mapChannel = (await options.getMap()).channels.find((c) => channelPlatform(c) === 'teams' && c.id === channelId);
    // With no record, a channel is a `@thread.tacv2` id or any id the map lists as a Teams channel (older `@thread.skype` ids).
    const type = record?.conversationType ?? (channelId.includes('@thread.tacv2') || mapChannel !== undefined ? 'channel' : 'personal');
    const teamId = record?.teamId ?? mapChannel?.teamId;
    return { serviceUrl, type, ...(teamId === undefined ? {} : { teamId }) };
  }

  async function post(target: ChatTarget, activity: TeamsOutgoingActivity): Promise<ChatPosted> {
    const at = await locate(target.channel);
    const root = target.threadId === undefined || target.threadId === '' ? undefined : target.threadId;
    if (at.type === 'channel' && root !== undefined) {
      const out = await connector.replyToActivity({ serviceUrl: at.serviceUrl, conversationId: target.channel, activityId: root, threadRootId: root }, activity);
      return { channel: target.channel, messageId: out.id };
    }
    const out = await connector.sendToConversation({ serviceUrl: at.serviceUrl, conversationId: target.channel }, activity);
    return { channel: target.channel, messageId: out.id };
  }

  /** The names Teams gave the people `text` mentions whom the map does not list (their user records). */
  function namesIn(map: WorkspaceMap, text: string): Promise<Map<string, string>> {
    return rememberedNames(cache, text, (id) => map.people.some((p) => p.teamsId === id));
  }

  /** `text` as a message activity, a person outside the map named as Teams names them. */
  async function textActivity(map: WorkspaceMap, text: string): Promise<TeamsOutgoingActivity> {
    return mentionActivity(marks, map, text, await namesIn(map, text));
  }

  /** Text a caller composed (this surface's marks, its own words, user text) in `target`'s thread. */
  async function postText(target: ChatTarget, text: string): Promise<ChatPosted> {
    return post(target, await textActivity(await options.getMap(), text));
  }

  /** Delivers to a person's personal chat; false (logged) when the bot cannot reach them there. */
  async function postPersonal(userId: string, activity: TeamsOutgoingActivity): Promise<boolean> {
    const aadObjectId = teamsPerson(await options.getMap(), userId);
    const user = await readTeamsUser(cache, aadObjectId).catch(() => undefined);
    const serviceUrl = user?.serviceUrl ?? options.serviceUrl;
    const tenantId = user?.tenantId ?? options.tenantId;
    if (serviceUrl === undefined || tenantId === undefined) {
      log.info(`personal message to ${aadObjectId} skipped: no serviceUrl or tenant known for them yet`);
      return false;
    }
    let chat: Awaited<ReturnType<typeof connector.createPersonalConversation>>;
    try {
      chat = await connector.createPersonalConversation({
        serviceUrl,
        tenantId,
        aadObjectId,
        ...(user?.teamsUserId === undefined ? {} : { userId: user.teamsUserId }),
        ...(options.botId === undefined ? {} : { botId: options.botId }),
      });
    } catch (e) {
      if (!noPersonalChat(e)) throw e;
      log.info(`personal message to ${aadObjectId} not delivered (${message(e)}): the app is not installed for them`);
      return false;
    }
    // A failure to send into a chat that opened is a fault, never "not installed": it must not go public.
    await connector.sendToConversation({ serviceUrl: chat.serviceUrl ?? serviceUrl, conversationId: chat.id }, activity);
    return true;
  }

  async function reducedAt(channelId: string): Promise<boolean> {
    try {
      const { teamId } = await locate(channelId);
      return teamId !== undefined && (await readTeamsMode(cache, teamId)) === 'reduced';
    } catch (e) {
      onError('teams mode')(e);
      return false;
    }
  }

  const delivery: TeamsDelivery = {
    post,
    postPersonal,
    // The PR card's own text, never user text: its `<at>x</at>` tags are mentions.
    postText: (target, text) => postText(target, text.replace(AT_TAG, (_m, ref: string) => marks.mark(ref))),
    async cardOptions(target) {
      return { mentions: mentionsFromMap((await options.getMap()).people), reduced: await reducedAt(target.channel) };
    },
  };

  /** The incident's Teams thread, or nothing when it has none. */
  async function threadOf(incidentId: string): Promise<ChatTarget | undefined> {
    const incident = await state.getIncident(incidentId);
    if (incident === null || incident.source !== 'teams' || incident.channelId === undefined) return undefined;
    // The thread root saved at capture, else the anchor (a reported reply's own id is not a root).
    let threadId = incident.anchorId;
    for (const e of await state.read(incidentId)) if (e.type === 'captured' && e.payload.threadId !== undefined && e.payload.threadId !== '') threadId = e.payload.threadId;
    return { channel: incident.channelId, ...(threadId === undefined || threadId === '' ? {} : { threadId }) };
  }

  const textCards: ChatTextCards = {
    async askResolution(incidentId, prompt) {
      const where = await threadOf(incidentId);
      if (where === undefined) return;
      const opts = await delivery.cardOptions(where);
      const built = buildResolutionPrompt(incidentId, prompt, opts);
      // Teams has no ephemeral message: the asker's personal chat, else the thread with a mention.
      if (await postPersonal(prompt.userId, cardMessage(built))) return;
      const map = await options.getMap();
      const lead = `<@${prompt.userId}> this one is for you:`;
      await post(where, cardMessage(withLead(built, lead, map, await namesIn(map, lead))));
    },
    async postScopeCard(incidentId, card): Promise<PostedMessage | undefined> {
      const where = await threadOf(incidentId);
      if (where === undefined) return undefined;
      const built = buildScopeChangeCard(incidentId, card, await delivery.cardOptions(where));
      const posted = await post(where, cardMessage(built));
      return { platform: 'teams', channel: posted.channel, messageId: posted.messageId, role: 'other' };
    },
  };

  return {
    platform: 'teams',
    channelMembers,

    async threadPost(target, text) {
      return postText(target, text);
    },

    async channelPost(channel, text) {
      const map = await options.getMap();
      await post({ channel: teamsChannel(map, channel) }, await textActivity(map, text));
    },

    async personPost(person, text) {
      const map = await options.getMap();
      const activity = await textActivity(map, text);
      if (await postPersonal(person, activity)) return;
      // No thread here to mention them in, and a channel chosen by map order is unrelated to them: say so and stop.
      log.info(`personal message to ${teamsPerson(map, person)} dropped: no personal install, and nowhere else to post it`);
    },

    mention: (map, ref) => teamsMention(marks, map, ref),
    mentionUser: (userId) => marks.mark(userId),

    prReady: options.prReady ?? createTeamsPrReadyChat({ delivery, state, onError: onError('pr card record') }),
    textCards,

    async postMidFlightCard(target, incidentId, card: MidFlightCard) {
      const opts = await delivery.cardOptions(target);
      const built = buildMidFlightCard(incidentId, card, parseDuration(card.grace), opts);
      return post(target, cardMessage(built));
    },

    async refreshChannelMembers() {
      await channelMembers.refreshAll();
    },

    githubLinked: (userId) => options.identity.isLinked({ chat: 'teams', userId }),

    async rememberUser(activity) {
      const user = userFromActivity(activity, clock());
      if (user !== undefined) await cache.set(teamsUserKey(user.aadObjectId), JSON.stringify(user));
    },
  };
}
