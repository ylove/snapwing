// Slack signals (A 1.2, A 1.3, A 1.4; #335): reactions and short thread replies, classified and handed
// to the signal handler (`handleSignal`, pipeline/src/signals/handler.ts, #288).
//
// - `reaction_added` and `reaction_removed` by anyone but the bot are looked up with `classifyReaction`
//   (the playbook's Slack emoji, a channel-scoped emoji matching the channel's id or map name) and
//   handed over as `reaction` or `reaction-removed`, the target being the message reacted to. The
//   trigger path is untouched: a trigger emoji still normalizes to an incident and reaches
//   `handleInbound`, and a removed trigger reaction is still the interactivity's Stop (#148); the
//   handler also counts that reaction as a `trigger` signal (A 1.4).
// - A message in a channel (`message.channels`, `message.groups`) is never a capture. Only a thread
//   reply by a person is read, with the thread root as the target; the handler drops it unless that
//   root is an incident's anchor or a message Snapwing posted. A top-level message, a bot's message
//   (Snapwing's own included), an edit or deletion, and a message that mentions the bot (the status
//   query answers those, A 4.3) are ignored. A person posting through an app (`bot_id` on a person's
//   message) is a person (`authorship.ts`, #360).
// - A reply goes through the lexicon (`classifyLexicon`) first. One that misses it and sits in an
//   active incident's thread (the root resolves and the incident is not terminal) goes to the model
//   (`classifyLlm`, task `segmentation`) with the earlier thread messages as context, when `model` is
//   given.
// - A reply that asks for a standing subscription by naming a surface ("keep me posted on the
//   website", "stop updating me on web") is a standing watch (`applyStandingWatch`, A 4.4), not a
//   signal on the incident, and is confirmed to the asker ephemerally in the thread. It is checked
//   before the lexicon, so "stop notifying me on web" never reads as a Stop. Only inside an incident's
//   thread, like every message signal; "keep me posted" with no surface is the incident's `watch`.
//
// - Text signals beyond the intents (A 3, #294, wired in #348), when `text` is given: every thread reply
//   a person posts (the standing watch aside) also goes to `handleTextSignal`, after the intent path,
//   since one message can be both ("works now" is an `accept` and a resolution). A `claim` reaction the
//   handler applied goes to `acceptHandoff` (the person a handoff named took it). The two cards are
//   built here: the resolution question is ephemeral, shown only to the person who said it
//   (`buildResolutionPrompt`, block `text_resolution:<messageId>`), and the scope-change card is posted
//   in the thread (`buildScopeChangeCard`, block `scope_change:<messageId>`). `onAction` answers their
//   taps (`answerResolution`, `answerScopeChange`) and resolves to false for any other payload, which
//   the caller hands to the interactivity. The scope card is posted before its proposal is recorded (the
//   record carries the card's message id), so a tap can land first: `answerScopeChange` waits for the
//   proposal for a bounded time (`TextSignalDeps.proposalWait`, #354) instead of refusing. The resolution
//   question is recorded before it is shown, and the mid-flight and interactivity cards read no record
//   on a tap, so only the scope card has the gap.
//
// The actor's role is the workspace map's (`people[].slackId`; unmapped is `unknown`), the deep link
// is a permalink built from the workspace subdomain, and `githubLinked` comes from the OAuth store.
// Slack redelivers an event it thinks was missed, so each `event_id` is handled once (a cache
// `setIfAbsent`). `observeSignals` wraps the adapter given to `createSlackTransport` the way
// `observeReactionRemoval` does: the transport calls `normalizeResult` once per authenticated request,
// so every reaction and message event is seen once, whatever the trigger path made of it. Not awaited;
// failures go to `onError`.

import type { ActorRole, IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import type { Intent } from '@snapwing/pipeline/contracts/signals.ts';
import { isTerminalStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { ModelPort } from '@snapwing/pipeline/ports/model.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { classifyLexicon, classifyReaction } from '@snapwing/pipeline/signals/classify.ts';
import { handleSignal, type SignalDeps, type SignalInput, type SignalOutcome } from '@snapwing/pipeline/signals/handler.ts';
import { classifyLlm, type SignalMessage } from '@snapwing/pipeline/signals/llm.ts';
import type { PostedMessage } from '@snapwing/pipeline/signals/messages.ts';
import { applyStandingWatch, parseStandingWatch, resolveWatchTarget } from '@snapwing/pipeline/signals/standing.ts';
import { resolveTarget } from '@snapwing/pipeline/signals/target.ts';
import {
  acceptHandoff,
  answerResolution,
  answerScopeChange,
  classifyTextLexicon,
  handleTextSignal,
  type ResolutionChoice,
  type ResolutionPrompt,
  type ScopeChangeCard,
  type ScopeChoice,
  type TextMessage,
  type TextSignalDeps,
  type TextSignalOutcome,
  type TextSignalPorts,
} from '@snapwing/pipeline/signals/text.ts';
import type { Playbook } from '@snapwing/pipeline/config/playbook.ts';
import { textSignalRefusal } from '../shared/taps.ts';
import { parsedBodyOf, type SlackAdapter } from './adapter.ts';
import { createSlackAuthorOf, type SlackAuthorOf } from './authorship.ts';
import { actions, context, esc, mention, section, type SlackMessage } from './cards/blocks.ts';
import type { SlackActionPayload } from './transport.ts';
import type { SlackWeb } from './web.ts';

/** Events API event types this module reads. */
const SIGNAL_EVENTS: ReadonlySet<string> = new Set(['reaction_added', 'reaction_removed', 'message']);

/** Channel types whose messages are signals (public and private channels; a DM is a capture). */
const CHANNEL_TYPES: ReadonlySet<string> = new Set(['channel', 'group']);

/** Message subtypes a person's thread reply arrives with. */
const REPLY_SUBTYPES: ReadonlySet<string> = new Set(['', 'thread_broadcast', 'file_share']);

/** How long a handled `event_id` is remembered (Slack retries within minutes). */
const SEEN_TTL_SEC = 60 * 60;

/** Most earlier thread messages the model sees as context. */
const THREAD_CONTEXT_LIMIT = 30;

export interface SlackSignalsOptions {
  /** The handler's dependencies (compose builds them once). */
  deps: SignalDeps;
  /** The current workspace map: the actor's role and a channel's name for scoped emoji. */
  getMap: () => Promise<WorkspaceMap>;
  /** The bot's own user id: its reactions and messages are ignored, and a mention of it is the status query's. */
  botUserId: string;
  /** Who wrote a thread reply (`authorship.ts`, #360). Default: the map and `botUserId` only. */
  authorOf?: SlackAuthorOf;
  /** The Slack subdomain for permalinks (`<domain>.slack.com`). Absent: no deep link. */
  workspaceDomain?: string;
  /** The user has a linked GitHub identity (main 11.2). Absent: nobody is linked. */
  githubLinked?: (userId: string) => Promise<boolean>;
  /**
   * Thread context for the model pass, the standing watch's ephemeral confirmation, and the answers to
   * the text-signal cards (`updateMessage` marks the scope-change card answered).
   */
  web?: Pick<SlackWeb, 'conversationsReplies' | 'postEphemeral'> & Partial<Pick<SlackWeb, 'updateMessage'>>;
  /** The LLM pass (A 1.2). Absent: a reply the lexicon misses is not a signal. */
  model?: ModelPort;
  /** Writes standing subscriptions (A 4.4). Absent: a surface watch in a thread is not intercepted. */
  standing?: Pick<StatePort, 'subscribe' | 'unsubscribe'>;
  /** Text signals after filing (A 3, `signals/text.ts`). Absent: a thread reply is an intent signal only. */
  text?: TextSignalDeps;
  /** Called with what each event did (logs, tests). */
  onOutcome?: (outcome: SlackSignalOutcome) => void;
  onError?: (error: unknown) => void;
}

export type SlackSignalIgnoreReason =
  | 'not-an-event'
  | 'not-a-signal-event'
  | 'duplicate'
  | 'own-reaction'
  | 'not-a-message-reaction'
  | 'not-a-channel-message'
  | 'bot-message'
  | 'unsupported-subtype'
  | 'not-a-thread-reply'
  | 'mentions-bot'
  | 'empty-message'
  | 'no-intent';

export type SlackSignalOutcome = (
  | { kind: 'ignored'; reason: SlackSignalIgnoreReason }
  /** A standing surface subscription asked for in a thread (A 4.4). */
  | { kind: 'standing'; changed: boolean }
  /** Classified and handed to `handleSignal`; `outcome` is what it did. */
  | { kind: 'signal'; intent: Exclude<Intent, 'none'>; source: SignalInput['source']; outcome: SignalOutcome }
) & {
  /** With `text`: what `handleTextSignal` did with a thread reply, or `acceptHandoff` with a claim reaction. */
  text?: TextSignalOutcome;
};

export interface SlackSignals {
  /** True when the Events API body is an event this module reads (a reaction or a message). */
  observes(body: unknown): boolean;
  /** One Events API body; resolves to what it did. Throws only when the handler does. */
  handleEvent(body: unknown): Promise<SlackSignalOutcome>;
  /** `handleEvent`, with the outcome passed to `onOutcome`. */
  onEvent(body: unknown): Promise<void>;
  /**
   * A tap on a text-signal card (the resolution question, the scope-change card). Resolves to false
   * for any other payload, which then belongs to the interactivity; never throws (`onError`).
   */
  onAction(payload: SlackActionPayload): Promise<boolean>;
  /** Resolves when the `onEvent` calls started so far have settled (tests, shutdown). */
  idle(): Promise<void>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

function isoFromTs(ts: string): string {
  const seconds = Number(ts);
  return new Date(Number.isFinite(seconds) ? Math.round(seconds * 1000) : 0).toISOString();
}

const ignored = (reason: SlackSignalIgnoreReason): SlackSignalOutcome => ({ kind: 'ignored', reason });

/** A Slack permalink to a message (a reply's carries its thread). */
export function slackPermalink(domain: string, channel: string, ts: string, threadTs?: string): string {
  const base = `https://${domain}.slack.com/archives/${channel}/p${ts.replace('.', '')}`;
  return threadTs === undefined || threadTs === ts ? base : `${base}?thread_ts=${threadTs}&cid=${channel}`;
}

export function createSlackSignals(options: SlackSignalsOptions): SlackSignals {
  const { deps } = options;
  const onError = options.onError ?? (() => undefined);
  const authorOf = options.authorOf ?? createSlackAuthorOf({ botUserId: options.botUserId });

  const playbook = async (): Promise<Playbook> => (typeof deps.playbook === 'function' ? deps.playbook() : deps.playbook);

  function actorOf(map: WorkspaceMap, userId: string): IncidentActor {
    const person = map.people.find((p) => p.slackId === userId);
    const role: ActorRole = person?.role ?? 'unknown';
    return { id: userId, name: person?.handle ?? '', ...(person?.email === undefined ? {} : { email: person.email }), role };
  }

  async function linked(userId: string): Promise<boolean> {
    if (options.githubLinked === undefined) return false;
    return options.githubLinked(userId).catch((e: unknown) => {
      onError(e);
      return false;
    });
  }

  const link = (channel: string, ts: string, threadTs?: string): { deepLink?: string } =>
    options.workspaceDomain === undefined ? {} : { deepLink: slackPermalink(options.workspaceDomain, channel, ts, threadTs) };

  async function hand(input: SignalInput): Promise<SlackSignalOutcome> {
    if (input.intent === 'none') return ignored('no-intent');
    const outcome = await handleSignal(deps, input);
    return { kind: 'signal', intent: input.intent, source: input.source, outcome };
  }

  async function reaction(event: Rec, removed: boolean): Promise<SlackSignalOutcome> {
    const user = str(event['user']);
    if (user !== '' && user === options.botUserId) return ignored('own-reaction');
    const item = rec(event['item']);
    const channel = str(item['channel']);
    const ts = str(item['ts']);
    const name = str(event['reaction']);
    if (item['type'] !== 'message' || user === '' || channel === '' || ts === '' || name === '') return ignored('not-a-message-reaction');
    const map = await options.getMap();
    const channelName = map.channels.find((c) => c.id === channel)?.name;
    const classified = classifyReaction((await playbook()).signals, 'slack', name, { channel: channelName === undefined ? channel : [channel, channelName] });
    if (classified.intent === 'none') return ignored('no-intent');
    const actor = actorOf(map, user);
    const timestamp = isoFromTs(str(event['event_ts']) || ts);
    const outcome = await hand({
      intent: classified.intent,
      confidence: classified.confidence,
      source: removed ? 'reaction-removed' : 'reaction',
      platform: 'slack',
      actor,
      target: { channel, messageId: ts },
      raw: name,
      timestamp,
      ...link(channel, ts),
      githubLinked: await linked(user),
    });
    // A 3: a claim reaction anywhere on the incident takes a handoff that named the reactor.
    const text = options.text;
    if (text === undefined || removed || classified.intent !== 'claim' || outcome.kind !== 'signal' || !outcome.outcome.handled) return outcome;
    const incidentId = outcome.outcome.incidentId;
    const handoff = await acceptHandoff(text, { incidentId, actor, at: timestamp, via: 'reaction' }).catch((e: unknown) => {
      onError(e);
      return undefined;
    });
    return handoff === undefined ? outcome : { ...outcome, text: handoff };
  }

  /** The earlier messages of the thread, oldest first, for the model; empty when Slack cannot say. */
  async function threadContext(channel: string, threadTs: string, ts: string): Promise<SignalMessage[]> {
    if (options.web === undefined) return [];
    const page = await options.web.conversationsReplies({ channel, ts: threadTs, latest: ts, inclusive: false, limit: THREAD_CONTEXT_LIMIT }).catch((e: unknown) => {
      onError(e);
      return { messages: [] };
    });
    return page.messages
      .filter((m) => m.ts !== ts && Number(m.ts) < Number(ts))
      .map((m) => ({ id: m.ts, authorId: m.user ?? m.bot_id ?? '', text: m.text ?? '', timestamp: isoFromTs(m.ts) }));
  }

  async function message(event: Rec): Promise<SlackSignalOutcome> {
    if (!CHANNEL_TYPES.has(str(event['channel_type']))) return ignored('not-a-channel-message');
    const subtype = str(event['subtype']);
    const user = str(event['user']);
    if ((await authorOf(event, await options.getMap())) !== 'person') return ignored('bot-message');
    if (!REPLY_SUBTYPES.has(subtype)) return ignored('unsupported-subtype');
    const channel = str(event['channel']);
    const ts = str(event['ts']);
    const threadTs = str(event['thread_ts']);
    if (user === '' || channel === '' || ts === '') return ignored('not-a-channel-message');
    if (threadTs === '' || threadTs === ts) return ignored('not-a-thread-reply');
    const text = str(event['text']);
    if (options.botUserId !== '' && text.includes(`<@${options.botUserId}>`)) return ignored('mentions-bot');
    if (text.trim() === '') return ignored('empty-message');

    const ref = { platform: 'slack' as const, channel, messageId: threadTs };
    const map = await options.getMap();
    const signals = (await playbook()).signals;
    const timestamp = isoFromTs(ts);

    // A standing watch names a surface (A 4.4); only inside an incident's thread.
    const standing = options.standing;
    const request = standing === undefined ? undefined : parseStandingWatch(text);
    if (standing !== undefined && request !== undefined && resolveWatchTarget(map, request.target) !== undefined) {
      if ((await resolveTarget(deps.state, ref)) === null) return ignored('no-intent');
      const outcome = await applyStandingWatch(standing, map, { workspaceId: deps.workspaceId, userId: user, text, channel: 'thread', platform: 'slack', now: deps.clock() });
      if (!outcome.handled) return ignored('no-intent');
      await options.web?.postEphemeral({ channel, user, text: outcome.reply, thread_ts: threadTs }).catch(onError);
      return { kind: 'standing', changed: outcome.changed };
    }

    // The earlier thread messages, read at most once for both model passes.
    let earlier: Promise<SignalMessage[]> | undefined;
    const thread = (): Promise<SignalMessage[]> => (earlier ??= threadContext(channel, threadTs, ts));
    const actor = actorOf(map, user);

    /** The thread's root is an open incident's (and, with `filed`, one with its own issue). */
    const activeIncident = async (filed: boolean): Promise<boolean> => {
      const target = await resolveTarget(deps.state, ref);
      const incident = target === null ? null : await deps.state.getIncident(target.incidentId);
      return incident !== null && !isTerminalStatus(incident.status) && (!filed || incident.jiraKey !== undefined);
    };

    const intentSignal = async (): Promise<SlackSignalOutcome> => {
      let classified: { intent: Intent; confidence: number } = { intent: 'none', confidence: 0 };
      const lexicon = classifyLexicon(signals, text);
      if (lexicon.intent !== 'none') {
        classified = lexicon;
      } else if (options.model !== undefined) {
        // The model reads only replies in an active incident's thread (A 1.2).
        if (!(await activeIncident(false))) return ignored('no-intent');
        const answer = await classifyLlm(signals, { id: ts, authorId: user, text, timestamp }, await thread(), options.model).catch((e: unknown) => {
          onError(e);
          return { intent: 'none' as const };
        });
        if (answer.intent !== 'none') classified = answer;
      }
      if (classified.intent === 'none') return ignored('no-intent');
      return hand({
        intent: classified.intent,
        confidence: classified.confidence,
        source: 'message',
        platform: 'slack',
        actor,
        target: { channel, messageId: threadTs },
        raw: text,
        timestamp,
        ...link(channel, ts, threadTs),
        githubLinked: await linked(user),
      });
    };

    /** A 3: the thread is read only when the model will see the message and the incident takes text signals. */
    const textSignal = async (textDeps: TextSignalDeps, message: TextMessage): Promise<TextSignalOutcome> => {
      const modelReads = textDeps.model !== undefined && classifyTextLexicon({ signals }, message).kind === 'none';
      const earlierMessages = modelReads && (await activeIncident(true)) ? await thread() : [];
      return handleTextSignal(textDeps, {
        platform: 'slack',
        thread: { channel, rootId: threadTs },
        message,
        actor,
        ...(earlierMessages.length === 0 ? {} : { context: earlierMessages }),
      });
    };

    const outcome = await intentSignal();
    const textDeps = options.text;
    if (textDeps === undefined) return outcome;
    const read = await textSignal(textDeps, { id: ts, authorId: user, text, timestamp }).catch((e: unknown) => {
      onError(e);
      return undefined;
    });
    return read === undefined ? outcome : { ...outcome, text: read };
  }

  function observes(body: unknown): boolean {
    const outer = rec(body);
    return outer['type'] === 'event_callback' && SIGNAL_EVENTS.has(str(rec(outer['event'])['type']));
  }

  async function handleEvent(body: unknown): Promise<SlackSignalOutcome> {
    const outer = rec(body);
    if (outer['type'] !== 'event_callback') return ignored('not-an-event');
    const event = rec(outer['event']);
    const type = str(event['type']);
    if (!SIGNAL_EVENTS.has(type)) return ignored('not-a-signal-event');
    const eventId = str(outer['event_id']);
    if (eventId !== '' && !(await deps.cache.setIfAbsent(`signals:slack-event:${eventId}`, '1', SEEN_TTL_SEC))) return ignored('duplicate');
    if (type === 'message') return message(event);
    return reaction(event, type === 'reaction_removed');
  }

  /** A tap on the resolution question or the scope-change card (see the file header). */
  async function onAction(payload: SlackActionPayload): Promise<boolean> {
    const action = rec((Array.isArray(payload['actions']) ? payload['actions'] : [])[0]);
    const block = parseTextSignalBlock(str(action['block_id']));
    if (block === undefined || options.text === undefined) return false;
    try {
      await answer(options.text, payload, action, block);
    } catch (e) {
      onError(e);
    }
    return true;
  }

  async function answer(textDeps: TextSignalDeps, payload: SlackActionPayload, action: Rec, block: TextSignalBlock): Promise<void> {
    const userId = str(rec(payload['user'])['id']);
    const incidentId = str(action['value']);
    const actionId = str(action['action_id']);
    if (userId === '' || incidentId === '') return;
    const actor = actorOf(await options.getMap(), userId);
    const at = deps.clock().toISOString();
    const incident = await deps.state.getIncident(incidentId);
    const container = rec(payload['container']);
    const message = rec(payload['message']);
    const channel = str(container['channel_id']) || str(rec(payload['channel'])['id']) || (incident?.channelId ?? '');
    const reply = async (text: string): Promise<void> => {
      if (channel === '') return;
      await options.web?.postEphemeral({ channel, user: userId, text, ...(incident?.anchorId === undefined ? {} : { thread_ts: incident.anchorId }) }).catch(onError);
    };

    if (block.kind === 'resolution') {
      const choice = RESOLUTION_ACTIONS.find((c) => c === actionId);
      if (choice === undefined) return;
      const outcome = await answerResolution(textDeps, { incidentId, messageId: block.messageId, actor, choice, at });
      const key = incident?.jiraKey ?? 'the ticket';
      await reply(outcome.handled ? (choice === 'close' ? `Closed ${key}.` : `Keeping ${key} open.`) : textSignalRefusal(outcome.reason));
      return;
    }
    const choice = SCOPE_ACTIONS.find((c) => c === actionId);
    if (choice === undefined) return;
    const outcome = await answerScopeChange(textDeps, { incidentId, messageId: block.messageId, actor, choice, at });
    if (!outcome.handled) {
      await reply(textSignalRefusal(outcome.reason));
      return;
    }
    // The card says who answered and loses its buttons.
    const messageTs = str(container['message_ts']) || str(message['ts']);
    const label = choice === 'yes' ? 'Yes, file it separately' : "It's the same bug";
    const kept = (Array.isArray(message['blocks']) ? (message['blocks'] as unknown[]) : []).filter((b) => rec(b)['type'] !== 'actions');
    if (channel !== '' && messageTs !== '' && options.web?.updateMessage !== undefined) {
      await options.web
        .updateMessage({ channel, ts: messageTs, text: `${mention(userId)} chose ${label}.`, blocks: [...kept, context(`${mention(userId)} chose *${esc(label)}*.`)] })
        .catch(onError);
    }
  }

  const onOutcome = options.onOutcome ?? (() => undefined);
  const inFlight = new Set<Promise<void>>();
  return {
    observes,
    handleEvent,
    onAction,
    onEvent(body) {
      const task = handleEvent(body)
        .then(onOutcome)
        .finally(() => inFlight.delete(task));
      inFlight.add(task);
      return task;
    },
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

// Text-signal cards (A 3) -------------------------------------------------------------------------

/** Block id prefix of the ephemeral resolution question (`text_resolution:<messageId>`). */
export const RESOLUTION_BLOCK = 'text_resolution';
/** Block id prefix of the scope-change card (`scope_change:<messageId>`). */
export const SCOPE_CHANGE_BLOCK = 'scope_change';

const RESOLUTION_ACTIONS: readonly ResolutionChoice[] = ['close', 'keep-open'];
const SCOPE_ACTIONS: readonly ScopeChoice[] = ['yes', 'same-bug'];

interface TextSignalBlock {
  kind: 'resolution' | 'scope-change';
  messageId: string;
}

/** The card and the message it is about, from a text-signal block id; undefined for any other block. */
export function parseTextSignalBlock(blockId: string): TextSignalBlock | undefined {
  const [prefix, messageId, ...rest] = blockId.split(':');
  if (messageId === undefined || messageId === '' || rest.length > 0) return undefined;
  if (prefix === RESOLUTION_BLOCK) return { kind: 'resolution', messageId };
  if (prefix === SCOPE_CHANGE_BLOCK) return { kind: 'scope-change', messageId };
  return undefined;
}

/** "Close WEB-1042 as Cannot Reproduce?" with **Close it** and **Keep it open**; only its asker sees it. */
export function buildResolutionPrompt(incidentId: string, prompt: ResolutionPrompt): SlackMessage {
  return {
    text: prompt.text,
    blocks: [
      section(esc(prompt.text)),
      actions(`${RESOLUTION_BLOCK}:${prompt.messageId}`, [
        { label: 'Close it', actionId: 'close', value: incidentId, style: 'primary' },
        { label: 'Keep it open', actionId: 'keep-open', value: incidentId },
      ]),
    ],
  };
}

/**
 * "Sounds like a second issue on the app. File it separately?" with **Yes** and **It's the same bug**.
 * "the app" is the reporter's own words, so the fallback text is escaped like the block.
 */
export function buildScopeChangeCard(incidentId: string, card: ScopeChangeCard): SlackMessage {
  return {
    text: esc(card.text),
    blocks: [
      section(esc(card.text)),
      actions(
        `${SCOPE_CHANGE_BLOCK}:${card.messageId}`,
        card.choices.map((c) => ({ label: c.label, actionId: c.id, value: incidentId })),
      ),
    ],
  };
}

/**
 * The two Slack-side text-signal ports: the resolution question as an ephemeral message in the
 * incident's thread, and the scope-change card posted there (`text.ts` records it as a bot message).
 */
export function createSlackTextCards(options: {
  web: Pick<SlackWeb, 'postMessage' | 'postEphemeral'>;
  state: Pick<StatePort, 'getIncident'>;
}): Pick<TextSignalPorts, 'askResolution' | 'postScopeCard'> {
  const threadOf = async (incidentId: string): Promise<{ channel: string; threadTs?: string } | undefined> => {
    const incident = await options.state.getIncident(incidentId);
    if (incident === null || incident.source !== 'slack' || incident.channelId === undefined) return undefined;
    return { channel: incident.channelId, ...(incident.anchorId === undefined ? {} : { threadTs: incident.anchorId }) };
  };
  return {
    async askResolution(incidentId, prompt) {
      const where = await threadOf(incidentId);
      if (where === undefined) return;
      const built = buildResolutionPrompt(incidentId, prompt);
      await options.web.postEphemeral({
        channel: where.channel,
        user: prompt.userId,
        text: built.text,
        blocks: built.blocks,
        ...(where.threadTs === undefined ? {} : { thread_ts: where.threadTs }),
      });
    },
    async postScopeCard(incidentId, card): Promise<PostedMessage | undefined> {
      const where = await threadOf(incidentId);
      if (where === undefined) return undefined;
      const built = buildScopeChangeCard(incidentId, card);
      const posted = await options.web.postMessage({
        channel: where.channel,
        text: built.text,
        blocks: built.blocks,
        ...(where.threadTs === undefined ? {} : { thread_ts: where.threadTs }),
      });
      return { platform: 'slack', channel: posted.channel, messageId: posted.ts, role: 'other' };
    },
  };
}

/**
 * The adapter for `createSlackTransport`, with every reaction and message event also handed to
 * `signals.onEvent`, whatever the adapter made of it (a trigger reaction still becomes an incident).
 * Not awaited; failures go to `onError`.
 */
export function observeSignals(adapter: SlackAdapter, signals: Pick<SlackSignals, 'observes' | 'onEvent'>, onError: (error: unknown) => void = () => undefined): SlackAdapter {
  return {
    ...adapter,
    async normalizeResult(raw) {
      const result = await adapter.normalizeResult(raw);
      const body = parsedBodyOf(raw);
      if (signals.observes(body)) void signals.onEvent(body).catch(onError);
      return result;
    },
  };
}
