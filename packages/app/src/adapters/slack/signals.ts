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
//   query answers those, A 4.3) are ignored.
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
import { applyStandingWatch, parseStandingWatch, resolveWatchTarget } from '@snapwing/pipeline/signals/standing.ts';
import { resolveTarget } from '@snapwing/pipeline/signals/target.ts';
import type { Playbook } from '@snapwing/pipeline/config/playbook.ts';
import { parsedBodyOf, type SlackAdapter } from './adapter.ts';
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
  /** The Slack subdomain for permalinks (`<domain>.slack.com`). Absent: no deep link. */
  workspaceDomain?: string;
  /** The user has a linked GitHub identity (main 11.2). Absent: nobody is linked. */
  githubLinked?: (userId: string) => Promise<boolean>;
  /** Thread context for the model pass, and the standing watch's ephemeral confirmation. */
  web?: Pick<SlackWeb, 'conversationsReplies' | 'postEphemeral'>;
  /** The LLM pass (A 1.2). Absent: a reply the lexicon misses is not a signal. */
  model?: ModelPort;
  /** Writes standing subscriptions (A 4.4). Absent: a surface watch in a thread is not intercepted. */
  standing?: Pick<StatePort, 'subscribe' | 'unsubscribe'>;
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

export type SlackSignalOutcome =
  | { kind: 'ignored'; reason: SlackSignalIgnoreReason }
  /** A standing surface subscription asked for in a thread (A 4.4). */
  | { kind: 'standing'; changed: boolean }
  /** Classified and handed to `handleSignal`; `outcome` is what it did. */
  | { kind: 'signal'; intent: Exclude<Intent, 'none'>; source: SignalInput['source']; outcome: SignalOutcome };

export interface SlackSignals {
  /** True when the Events API body is an event this module reads (a reaction or a message). */
  observes(body: unknown): boolean;
  /** One Events API body; resolves to what it did. Throws only when the handler does. */
  handleEvent(body: unknown): Promise<SlackSignalOutcome>;
  /** `handleEvent`, with the outcome passed to `onOutcome`. */
  onEvent(body: unknown): Promise<void>;
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
    return hand({
      intent: classified.intent,
      confidence: classified.confidence,
      source: removed ? 'reaction-removed' : 'reaction',
      platform: 'slack',
      actor: actorOf(map, user),
      target: { channel, messageId: ts },
      raw: name,
      timestamp: isoFromTs(str(event['event_ts']) || ts),
      ...link(channel, ts),
      githubLinked: await linked(user),
    });
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
    if (subtype === 'bot_message' || event['bot_id'] !== undefined || (user !== '' && user === options.botUserId)) return ignored('bot-message');
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
      const outcome = await applyStandingWatch(standing, map, { workspaceId: deps.workspaceId, userId: user, text, channel: 'thread', now: deps.clock() });
      if (!outcome.handled) return ignored('no-intent');
      await options.web?.postEphemeral({ channel, user, text: outcome.reply, thread_ts: threadTs }).catch(onError);
      return { kind: 'standing', changed: outcome.changed };
    }

    let classified: { intent: Intent; confidence: number } = { intent: 'none', confidence: 0 };
    const lexicon = classifyLexicon(signals, text);
    if (lexicon.intent !== 'none') {
      classified = lexicon;
    } else if (options.model !== undefined) {
      // The model reads only replies in an active incident's thread (A 1.2).
      const target = await resolveTarget(deps.state, ref);
      const incident = target === null ? null : await deps.state.getIncident(target.incidentId);
      if (incident === null || isTerminalStatus(incident.status)) return ignored('no-intent');
      const thread = await threadContext(channel, threadTs, ts);
      const answer = await classifyLlm(signals, { id: ts, authorId: user, text, timestamp }, thread, options.model).catch((e: unknown) => {
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
      actor: actorOf(map, user),
      target: { channel, messageId: threadTs },
      raw: text,
      timestamp,
      ...link(channel, ts, threadTs),
      githubLinked: await linked(user),
    });
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

  const onOutcome = options.onOutcome ?? (() => undefined);
  const inFlight = new Set<Promise<void>>();
  return {
    observes,
    handleEvent,
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
