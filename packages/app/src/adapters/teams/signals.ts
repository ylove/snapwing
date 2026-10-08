// Teams signals (A 1.1 to 1.4, A 1.6, A 3; main 15.1, 15.2; #392): reactions and thread replies, the
// Teams side of `adapters/slack/signals.ts`, handed to the same signal handler (`handleSignal`).
//
// The transport (#390, `TeamsSignalsRoute`) calls `onNotifications`, `observes`, and `onActivity`. Two
// sources, because Bot Framework reports a reaction only on a message the bot sent (main 15.2):
//
// - A Graph change notification on a channel message (`chatMessage`, #379's subscription), already
//   authenticated by its `clientState` (`TeamsSubscriptions.verifyNotification`). The message is read
//   from the notification when the caller decrypted its resource data, else fetched from Graph
//   (`GET .../messages/{id}` or `.../replies/{id}`). An `updated` message has its `reactions` diffed
//   against the last set seen; a `created` reply by a person is a thread reply (below).
// - Bot Framework activities, already authenticated by the transport: a `messageReaction`
//   (`reactionsAdded`, `reactionsRemoved`) on one of the bot's own messages, and a person's channel
//   thread reply (`observes`; RSC delivers every channel message to the bot). A reply that arrives both
//   ways is read once (the activity id is the Graph message id). In reduced mode (no RSC grant, so no
//   notifications, ADR 0005) reactions on the bot's own messages are the only ones that count.
//
// The last set seen lives in kv `teams-reactions:{messageId}` (JSON, 7-day TTL): one entry per person
// and reaction name, with when it was added. Both sources apply their change to the same set and
// emit only what changed it, so a reaction on a bot's card that arrives both ways counts once, and a
// redelivered notification emits nothing. The first notification for a message the set has never
// seen emits the reactions added inside the TTL; older ones are taken as already seen. Changes to one
// message are applied one at a time in this process.
//
// Each added or removed reaction is mapped to the playbook's `teams` names (`reactions.ts`; an unknown
// `reactionType` is ignored) and then, in this order:
//
// - The trigger (main 15.1, the map's `<emoji teams=...>`, a channel's override, `minReactors`): a
//   reaction on a person's channel message whose name is a trigger emoji there is handed to
//   `handleInbound('teams', { transport: 'graph', trigger })`, which normalizes it (`normalizeTeams`
//   applies the emoji, the override, and `minReactors` again) and captures it. The current reactors of
//   that emoji go with it, so the second of two people reaching `minReactors` files it (the first only
//   counted). The bot's own messages are never captured.
// - A removed trigger within 60 s of its reaction is a Stop for the incident that reaction filed,
//   through the injected `stopIncident`, when the remover is one of the trigger's reactors (as Slack's
//   interactivity does, #148). The handler records the removal without stopping (`viaAdapter`).
// - Every reaction the playbook classifies (`classifyReaction` with the platform `teams`, scoped by the
//   channel's id or map name) goes to `handleSignal` as `reaction` or `reaction-removed`, the trigger
//   included (A 1.4 counts it), and a claim the handler applied goes to `acceptHandoff` (A 3).
//
// A thread reply (a `created` reply in a channel) by a person goes through the standing watch, the
// lexicon, and then the model, exactly as a Slack reply does: the target is the thread's root, a reply
// that mentions the bot is the status query's, and with `text` every reply also goes to
// `handleTextSignal` after the intent path. Teams has no ephemeral messages, so a standing watch is
// confirmed through the injected `confirmStanding` (the personal chat, wired by compose), if any.
//
// People are their AAD object ids (the map's `teamsId`, ADR 0019); the bot's own reactions and messages
// (its app id, or any application identity) are ignored. Channel-message notifications may need
// Microsoft's protected-API or metered-API settings even with RSC, which only a live tenant can settle;
// until the live tier does, the contract tier is the proof.

import type { ActorRole, IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import type { Intent } from '@snapwing/pipeline/contracts/signals.ts';
import type { Playbook } from '@snapwing/pipeline/config/playbook.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import { isTerminalStatus } from '@snapwing/pipeline/lifecycle/machine.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { ModelPort } from '@snapwing/pipeline/ports/model.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { classifyLexicon, classifyReaction } from '@snapwing/pipeline/signals/classify.ts';
import { handleSignal, type SignalDeps, type SignalInput, type SignalOutcome } from '@snapwing/pipeline/signals/handler.ts';
import { classifyLlm, type SignalMessage } from '@snapwing/pipeline/signals/llm.ts';
import { applyStandingWatch, parseStandingWatch, resolveWatchTarget } from '@snapwing/pipeline/signals/standing.ts';
import { resolveTarget } from '@snapwing/pipeline/signals/target.ts';
import {
  acceptHandoff,
  classifyTextLexicon,
  handleTextSignal,
  type TextMessage,
  type TextSignalDeps,
  type TextSignalOutcome,
} from '@snapwing/pipeline/signals/text.ts';
import { TeamsIgnoredError, type TeamsInbound } from './adapter.ts';
import { splitConversationId } from './conversations.ts';
import { GraphApiError, type GraphIdentity, type GraphMessage, type TeamsGraph } from './graph.ts';
import { teamsHtmlToText, teamsTriggerEmoji, type TeamsReactionTrigger } from './normalize.ts';
import { teamsReactionNames } from './reactions.ts';
import type { VerifiedNotification } from './subscriptions.ts';

/** How long the last set of reactions seen on a message is kept. */
export const REACTIONS_TTL_SEC = 7 * 24 * 60 * 60;

/** How long after the trigger reaction its removal is a Stop (main 15.1). */
export const TRIGGER_STOP_WINDOW_MS = 60_000;

/** A trigger stamped slightly after its removal (clock skew between Graph and us) still matches. */
const CLOCK_SKEW_MS = 5_000;

/** Incidents scanned for the one a removed trigger filed (newest first). */
const TRIGGER_SCAN_LIMIT = 200;

/** How long a handled reply id is remembered (Graph redelivers within minutes). */
const SEEN_TTL_SEC = 60 * 60;

/** Most earlier thread messages the model sees as context. */
const THREAD_CONTEXT_LIMIT = 30;

export const teamsReactionsKey = (messageId: string): string => `teams-reactions:${messageId}`;

export interface TeamsSignalsOptions {
  /** The handler's dependencies (compose builds them once). */
  deps: SignalDeps;
  /** The current workspace map: roles by `teamsId`, channel names for scoped emoji, the trigger emoji. */
  getMap: () => Promise<WorkspaceMap>;
  /** The bot's Microsoft app id: its own reactions and messages are ignored. */
  botAppId: string;
  /** Graph, to read a notified message and a thread's earlier replies. Absent: notifications need `message`. */
  graph?: Pick<TeamsGraph, 'message' | 'channelReplies'>;
  /** `IncidentOrchestrator.handleInbound`, for a trigger reaction. Absent: a trigger is only counted. */
  handleInbound?: (source: 'teams', raw: TeamsInbound) => Promise<unknown>;
  /** The Stop for a trigger removed within 60 s (main 15.1). Default `deps.stopIncident`. */
  stopIncident?: (input: StopInput) => Promise<StopOutcome>;
  /** The person (AAD object id) has a linked GitHub identity (main 11.2). Absent: nobody is linked. */
  githubLinked?: (aadObjectId: string) => Promise<boolean>;
  /** The LLM pass (A 1.2). Absent: a reply the lexicon misses is not a signal. */
  model?: ModelPort;
  /** Writes standing subscriptions (A 4.4). Absent: a surface watch in a thread is not intercepted. */
  standing?: Pick<StatePort, 'subscribe' | 'unsubscribe'>;
  /** Tells the person their standing watch was applied (Teams has no ephemerals). Absent: nothing is said. */
  confirmStanding?: (input: { aadObjectId: string; text: string; teamId: string; channelId: string; rootId: string }) => Promise<void>;
  /** Text signals after filing (A 3, `signals/text.ts`). Absent: a thread reply is an intent signal only. */
  text?: TextSignalDeps;
  /** Called with what each notification or activity did (logs, tests). */
  onOutcome?: (outcomes: TeamsSignalOutcome[]) => void;
  onError?: (error: unknown) => void;
}

export type TeamsSignalIgnoreReason =
  | 'not-a-reaction-activity'
  | 'not-a-channel-message'
  | 'no-graph'
  | 'message-gone'
  | 'deleted-message'
  | 'not-a-thread-reply'
  | 'duplicate'
  | 'own-reaction'
  | 'bot-message'
  | 'mentions-bot'
  | 'empty-message'
  | 'no-change'
  | 'unknown-reaction'
  | 'no-intent';

export type TeamsSignalOutcome = (
  | { kind: 'ignored'; reason: TeamsSignalIgnoreReason }
  /** A trigger emoji on a person's message: handed to `handleInbound`, or short of `minReactors`. */
  | { kind: 'trigger'; reaction: string; reactor: string; captured: boolean; reactors: string[] }
  /** A trigger removed within 60 s by one of its reactors: the incident's Stop. */
  | { kind: 'stopped'; incidentId: string; outcome: StopOutcome }
  /** A standing surface subscription asked for in a thread (A 4.4). */
  | { kind: 'standing'; changed: boolean }
  /** Classified and handed to `handleSignal`; `outcome` is what it did. */
  | { kind: 'signal'; intent: Exclude<Intent, 'none'>; source: SignalInput['source']; outcome: SignalOutcome }
) & {
  /** With `text`: what `handleTextSignal` did with a reply, or `acceptHandoff` with a claim reaction. */
  text?: TextSignalOutcome;
};

/**
 * The module as the Teams transport (#390, `TeamsSignalsRoute`) calls it: `observes` and `onActivity` for
 * Bot Framework activities, `onNotifications` for change notifications whose `clientState` matched.
 */
export interface TeamsSignals {
  /** One verified Graph change notification; `message` is its decrypted resource data, when there is one. */
  handleNotification(notification: VerifiedNotification, message?: GraphMessage): Promise<TeamsSignalOutcome[]>;
  /** A batch of verified change notifications (lifecycle events skipped); one failing never drops the rest. */
  handleNotifications(notifications: readonly VerifiedNotification[]): Promise<TeamsSignalOutcome[]>;
  /** True for a `message` activity this module reads: a person's channel thread reply (RSC). */
  observes(activity: unknown): boolean;
  /** One authenticated activity: `messageReaction` (the bot's own messages), or a thread reply `observes` accepted. */
  handleActivity(activity: unknown): Promise<TeamsSignalOutcome[]>;
  /** `handleNotifications`, with the outcomes passed to `onOutcome`; failures go to `onError`. */
  onNotifications(notifications: readonly VerifiedNotification[]): Promise<void>;
  /** `handleActivity`, with the outcomes passed to `onOutcome`; failures go to `onError`. */
  onActivity(activity: unknown): Promise<void>;
  /** Resolves when the `on*` calls started so far have settled (tests, shutdown). */
  idle(): Promise<void>;
}

/** One person's reaction as the set remembers it. */
export interface SeenReaction {
  /** AAD object id. */
  user: string;
  /** The playbook's `teams` name (`reactions.ts`). */
  name: string;
  /** Every name the playbook may use for it, the A 1.1 name first. */
  names: readonly string[];
  /** The `reactionType` as Graph or Bot Framework sent it. */
  type: string;
  /** ISO 8601: when it was added. */
  at: string;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

const ignored = (reason: TeamsSignalIgnoreReason): TeamsSignalOutcome => ({ kind: 'ignored', reason });
const keyOf = (r: Pick<SeenReaction, 'user' | 'name'>): string => `${r.user}\u0000${r.name}`;

function iso(value: string | null | undefined, fallback: Date): string {
  const ms = value === undefined || value === null ? Number.NaN : Date.parse(value);
  return new Date(Number.isFinite(ms) ? ms : fallback.getTime()).toISOString();
}

/** The reactions of a Graph message as the set keeps them: known types by people other than the bot. */
export function reactionsOf(message: Pick<GraphMessage, 'reactions'>, botAppId: string, now: Date): SeenReaction[] {
  const out = new Map<string, SeenReaction>();
  for (const r of message.reactions ?? []) {
    const user = personId(r.user, botAppId);
    const names = teamsReactionNames(r.reactionType);
    const name = names[0];
    if (user === undefined || name === undefined) continue;
    const seen: SeenReaction = { user, name, names, type: r.reactionType, at: iso(r.createdDateTime, now) };
    if (!out.has(keyOf(seen))) out.set(keyOf(seen), seen);
  }
  return [...out.values()];
}

/** What changed between the set seen last and the set now. */
export function diffReactions(before: readonly SeenReaction[], now: readonly SeenReaction[]): { added: SeenReaction[]; removed: SeenReaction[] } {
  const was = new Set(before.map(keyOf));
  const is = new Set(now.map(keyOf));
  return { added: now.filter((r) => !was.has(keyOf(r))), removed: before.filter((r) => !is.has(keyOf(r))) };
}

/** The AAD object id of a person, or undefined for the bot, another app, or a missing id. */
function personId(identity: GraphIdentity | null | undefined, botAppId: string): string | undefined {
  if (identity === null || identity === undefined) return undefined;
  if (identity.application !== undefined && identity.application !== null) return undefined;
  const user = identity.user ?? undefined;
  if (user === undefined || user === null || user.id === '' || user.id === botAppId) return undefined;
  if (user.userIdentityType === 'bot' || user.userIdentityType === 'application') return undefined;
  return user.id;
}

function parseSeen(raw: string | null): SeenReaction[] | undefined {
  if (raw === null || raw === '') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const list = rec(parsed)['reactions'];
  if (!Array.isArray(list)) return undefined;
  return list.flatMap((v): SeenReaction[] => {
    const r = rec(v);
    const user = str(r['user']);
    const type = str(r['type']);
    const names = teamsReactionNames(type);
    const name = str(r['name']) || names[0];
    if (user === '' || name === undefined || name === '') return [];
    return [{ user, name, names: names.length > 0 ? names : [name], type, at: str(r['at']) }];
  });
}

function serializeSeen(reactions: readonly SeenReaction[]): string {
  return JSON.stringify({ v: 1, reactions: reactions.map(({ user, name, type, at }) => ({ user, name, type, at })) });
}

/** A channel message's link when Graph gave none (the shape `normalize.ts` builds). */
export function teamsMessageLink(channelId: string, messageId: string, teamId?: string, rootId?: string): string {
  const q = new URLSearchParams();
  if (teamId !== undefined && teamId !== '') q.set('groupId', teamId);
  if (rootId !== undefined && rootId !== '' && rootId !== messageId) q.set('parentMessageId', rootId);
  const query = q.toString();
  return `https://teams.microsoft.com/l/message/${encodeURIComponent(channelId)}/${encodeURIComponent(messageId)}${query === '' ? '' : `?${query}`}`;
}

/** Where a reaction landed and what it was on. */
interface ReactionSite {
  teamId?: string;
  /** The channel's id, or the chat's conversation id (the `bot_messages` key). */
  channelId: string;
  messageId: string;
  /** A channel reply's thread root. */
  rootId?: string;
  /** The message as Graph returned it (notifications only). */
  message?: GraphMessage;
  /** The message is the bot's (or another app's): never a capture. */
  byBot: boolean;
  /** Every reaction on the message now, by people (notifications only): the trigger's reactors. */
  current?: readonly SeenReaction[];
  deepLink?: string;
}

export function createTeamsSignals(options: TeamsSignalsOptions): TeamsSignals {
  const { deps, botAppId } = options;
  const onError = options.onError ?? (() => undefined);
  const stopIncident = options.stopIncident ?? deps.stopIncident;
  const chains = new Map<string, Promise<unknown>>();

  const playbook = async (): Promise<Playbook> => (typeof deps.playbook === 'function' ? deps.playbook() : deps.playbook);

  function actorOf(map: WorkspaceMap, aadObjectId: string): IncidentActor {
    const person = map.people.find((p) => p.teamsId === aadObjectId);
    const role: ActorRole = person?.role ?? 'unknown';
    return { id: aadObjectId, name: person?.handle ?? '', ...(person?.email === undefined ? {} : { email: person.email }), role };
  }

  async function linked(aadObjectId: string): Promise<boolean> {
    if (options.githubLinked === undefined) return false;
    return options.githubLinked(aadObjectId).catch((e: unknown) => {
      onError(e);
      return false;
    });
  }

  /** Runs `fn` after every earlier change to the same message in this process. */
  function serial<T>(messageId: string, fn: () => Promise<T>): Promise<T> {
    const prior = chains.get(messageId) ?? Promise.resolve();
    const next = prior.then(fn, fn);
    chains.set(messageId, next);
    void next.then(
      () => (chains.get(messageId) === next ? chains.delete(messageId) : undefined),
      () => (chains.get(messageId) === next ? chains.delete(messageId) : undefined),
    );
    return next;
  }

  async function hand(input: SignalInput): Promise<TeamsSignalOutcome> {
    if (input.intent === 'none') return ignored('no-intent');
    const outcome = await handleSignal(deps, input);
    return { kind: 'signal', intent: input.intent, source: input.source, outcome };
  }

  // Reactions ---------------------------------------------------------------------------------------

  /** Applies `change` to the set of `messageId` and returns what it changed. */
  async function applyToSet(
    messageId: string,
    change: (before: SeenReaction[] | undefined) => SeenReaction[],
  ): Promise<{ added: SeenReaction[]; removed: SeenReaction[] }> {
    const key = teamsReactionsKey(messageId);
    const before = parseSeen(await deps.cache.get(key));
    const now = change(before);
    const diff = diffReactions(before ?? [], now);
    if (before === undefined || diff.added.length > 0 || diff.removed.length > 0) await deps.cache.set(key, serializeSeen(now), REACTIONS_TTL_SEC);
    return diff;
  }

  /** One added or removed reaction (see the file header for the order). */
  async function reactionChange(site: ReactionSite, reaction: SeenReaction, removed: boolean, at: string): Promise<TeamsSignalOutcome[]> {
    const map = await options.getMap();
    const out: TeamsSignalOutcome[] = [];
    const triggers = teamsTriggerEmoji(map, site.channelId);
    const triggerName = site.byBot || site.teamId === undefined ? undefined : reaction.names.find((n) => triggers.has(n));

    if (triggerName !== undefined && !removed && site.message !== undefined && site.teamId !== undefined) {
      out.push(await trigger(site as ReactionSite & { message: GraphMessage; teamId: string }, reaction, triggerName, triggers.get(triggerName) ?? 1));
    } else if (triggerName !== undefined && removed) {
      const stopped = await stopTrigger(map, site, reaction, triggerName, at);
      if (stopped !== undefined) out.push(stopped);
    }

    const channelName = map.channels.find((c) => c.id === site.channelId)?.name;
    const signals = (await playbook()).signals;
    const scope = { channel: channelName === undefined ? site.channelId : [site.channelId, channelName] };
    let raw = reaction.name;
    let classified: ReturnType<typeof classifyReaction> = { intent: 'none' };
    for (const name of reaction.names) {
      classified = classifyReaction(signals, 'teams', name, scope);
      if (classified.intent !== 'none') {
        raw = name;
        break;
      }
    }
    if (classified.intent === 'none') {
      if (out.length === 0) out.push(ignored('no-intent'));
      return out;
    }
    const actor = actorOf(map, reaction.user);
    const outcome = await hand({
      intent: classified.intent,
      confidence: classified.confidence,
      source: removed ? 'reaction-removed' : 'reaction',
      platform: 'teams',
      actor,
      target: { channel: site.channelId, messageId: site.messageId },
      raw,
      timestamp: at,
      ...(site.deepLink === undefined ? {} : { deepLink: site.deepLink }),
      githubLinked: await linked(reaction.user),
    });
    // A 3: a claim reaction anywhere on the incident takes a handoff that named the reactor.
    const text = options.text;
    if (text !== undefined && !removed && classified.intent === 'claim' && outcome.kind === 'signal' && outcome.outcome.handled) {
      const handoff = await acceptHandoff(text, { incidentId: outcome.outcome.incidentId, actor, at, via: 'reaction' }).catch((e: unknown) => {
        onError(e);
        return undefined;
      });
      out.push(handoff === undefined ? outcome : { ...outcome, text: handoff });
    } else {
      out.push(outcome);
    }
    return out;
  }

  /**
   * `reactionChange` that never ends its diff: the new set is already saved, so a change that is not
   * handled now is never notified again. A failure is reported and the rest of the diff goes on.
   */
  async function guardedChange(site: ReactionSite, reaction: SeenReaction, removed: boolean, at: string): Promise<TeamsSignalOutcome[]> {
    try {
      return await reactionChange(site, reaction, removed, at);
    } catch (e) {
      onError(e);
      return [];
    }
  }

  /** main 15.1: a trigger emoji on a person's message, captured through the adapter once `minReactors` agree. */
  async function trigger(
    site: ReactionSite & { message: GraphMessage; teamId: string },
    reaction: SeenReaction,
    name: string,
    minReactors: number,
  ): Promise<TeamsSignalOutcome> {
    const reactors = [...new Set([reaction.user, ...(site.current ?? []).filter((r) => r.names.includes(name)).map((r) => r.user)])];
    const base = { kind: 'trigger' as const, reaction: name, reactor: reaction.user, reactors };
    if (reactors.length < minReactors || options.handleInbound === undefined) return { ...base, captured: false };
    const trig: TeamsReactionTrigger = {
      teamId: site.teamId,
      channelId: site.channelId,
      message: site.message,
      reaction: name,
      reactorAadId: reaction.user,
      reactors,
      at: reaction.at,
    };
    try {
      await options.handleInbound('teams', { transport: 'graph', trigger: trig });
    } catch (e) {
      // The adapter's normalizer had the last word (a deleted message, a bot's post).
      if (e instanceof TeamsIgnoredError) return { ...base, captured: false };
      throw e;
    }
    return { ...base, captured: true };
  }

  /** main 15.1: the trigger removed within 60 s by one of its reactors stops the incident it filed. */
  async function stopTrigger(map: WorkspaceMap, site: ReactionSite, reaction: SeenReaction, name: string, at: string): Promise<TeamsSignalOutcome | undefined> {
    const removedAt = Date.parse(at);
    const key = `teams-${site.channelId}-${site.messageId}-${name}`;
    for (const incident of await deps.state.findIncidents({ limit: TRIGGER_SCAN_LIMIT })) {
      if (incident.source !== 'teams' || incident.channelId !== site.channelId) continue;
      const sinceTrigger = removedAt - Date.parse(incident.openedAt);
      if (sinceTrigger < -CLOCK_SKEW_MS || sinceTrigger > TRIGGER_STOP_WINDOW_MS) continue;
      const captured = (await deps.state.read(incident.id)).find((e) => e.type === 'captured');
      if (captured?.type !== 'captured' || captured.payload.idempotencyKey !== key) continue;
      const reactors = rec(captured.payload.rawPayloadSnapshot)['reactors'];
      const by = new Set<string>([captured.payload.reporter.id, ...(Array.isArray(reactors) ? reactors.map(str) : [])]);
      if (!by.has(reaction.user)) return undefined;
      const actor = actorOf(map, reaction.user);
      const outcome = await stopIncident({
        incidentId: incident.id,
        actor: { id: actor.id, role: actor.role, ...(actor.name === '' ? {} : { name: actor.name }) },
        source: 'teams',
        reason: 'trigger reaction removed',
      });
      return { kind: 'stopped', incidentId: incident.id, outcome };
    }
    return undefined;
  }

  /** The Graph diff of one notified message. */
  async function diffMessage(site: ReactionSite & { message: GraphMessage }): Promise<TeamsSignalOutcome[]> {
    const now = deps.clock();
    const current = reactionsOf(site.message, botAppId, now);
    const floor = now.getTime() - REACTIONS_TTL_SEC * 1000;
    const { added, removed } = await applyToSet(site.messageId, () => current);
    const out: TeamsSignalOutcome[] = [];
    const withCurrent = { ...site, current };
    for (const r of added) {
      // An add older than the TTL is one the set forgot (first sight, or expired): taken as seen.
      if (Date.parse(r.at) < floor) continue;
      out.push(...(await guardedChange(withCurrent, r, false, r.at)));
    }
    for (const r of removed) out.push(...(await guardedChange(withCurrent, r, true, now.toISOString())));
    return out.length === 0 ? [ignored('no-change')] : out;
  }

  // Thread replies ------------------------------------------------------------------------------------

  /** The earlier messages of the thread, oldest first, for the model; empty when Graph cannot say. */
  async function threadContext(teamId: string, channelId: string, rootId: string, message: GraphMessage): Promise<SignalMessage[]> {
    const graph = options.graph;
    if (graph === undefined || teamId === '') return [];
    const before = Date.parse(message.createdDateTime);
    const [root, replies] = await Promise.all([
      graph.message(teamId, channelId, rootId).catch((e: unknown) => {
        onError(e);
        return undefined;
      }),
      graph.channelReplies(teamId, channelId, rootId).catch((e: unknown) => {
        onError(e);
        return [] as GraphMessage[];
      }),
    ]);
    return [...(root === undefined ? [] : [root]), ...replies]
      .filter((m) => m.id !== message.id && Date.parse(m.createdDateTime) < before && (m.deletedDateTime ?? null) === null)
      .sort((a, b) => Date.parse(a.createdDateTime) - Date.parse(b.createdDateTime))
      .slice(-THREAD_CONTEXT_LIMIT)
      .map((m) => ({ id: m.id, authorId: m.from?.user?.id ?? m.from?.application?.id ?? '', text: plainText(m), timestamp: iso(m.createdDateTime, new Date(0)) }));
  }

  async function reply(teamId: string, channelId: string, rootId: string, message: GraphMessage): Promise<TeamsSignalOutcome> {
    const user = personId(message.from, botAppId);
    if (user === undefined) return ignored('bot-message');
    if ((message.mentions ?? []).some((m) => (m.mentioned.application ?? null) !== null || m.mentioned.user?.id === botAppId)) return ignored('mentions-bot');
    const text = plainText(message);
    if (text === '') return ignored('empty-message');
    if (!(await deps.cache.setIfAbsent(`signals:teams-message:${channelId}:${message.id}`, '1', SEEN_TTL_SEC))) return ignored('duplicate');

    const ref = { platform: 'teams' as const, channel: channelId, messageId: rootId };
    const map = await options.getMap();
    const signals = (await playbook()).signals;
    const timestamp = iso(message.createdDateTime, deps.clock());

    // A standing watch names a surface (A 4.4); only inside an incident's thread.
    const standing = options.standing;
    const request = standing === undefined ? undefined : parseStandingWatch(text);
    if (standing !== undefined && request !== undefined && resolveWatchTarget(map, request.target) !== undefined) {
      if ((await resolveTarget(deps.state, ref)) === null) return ignored('no-intent');
      const outcome = await applyStandingWatch(standing, map, { workspaceId: deps.workspaceId, userId: user, text, channel: 'thread', platform: 'teams', now: deps.clock() });
      if (!outcome.handled) return ignored('no-intent');
      await options.confirmStanding?.({ aadObjectId: user, text: outcome.reply, teamId, channelId, rootId }).catch(onError);
      return { kind: 'standing', changed: outcome.changed };
    }

    let earlier: Promise<SignalMessage[]> | undefined;
    const thread = (): Promise<SignalMessage[]> => (earlier ??= threadContext(teamId, channelId, rootId, message));
    const actor = actorOf(map, user);
    const deepLink = message.webUrl ?? teamsMessageLink(channelId, message.id, teamId, rootId);

    const activeIncident = async (filed: boolean): Promise<boolean> => {
      const target = await resolveTarget(deps.state, ref);
      const incident = target === null ? null : await deps.state.getIncident(target.incidentId);
      return incident !== null && !isTerminalStatus(incident.status) && (!filed || incident.jiraKey !== undefined);
    };

    const intentSignal = async (): Promise<TeamsSignalOutcome> => {
      let classified: { intent: Intent; confidence: number } = { intent: 'none', confidence: 0 };
      const lexicon = classifyLexicon(signals, text);
      if (lexicon.intent !== 'none') {
        classified = lexicon;
      } else if (options.model !== undefined) {
        // The model reads only replies in an active incident's thread (A 1.2).
        if (!(await activeIncident(false))) return ignored('no-intent');
        const answer = await classifyLlm(signals, { id: message.id, authorId: user, text, timestamp }, await thread(), options.model).catch((e: unknown) => {
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
        platform: 'teams',
        actor,
        target: { channel: channelId, messageId: rootId },
        raw: text,
        timestamp,
        deepLink,
        githubLinked: await linked(user),
      });
    };

    const outcome = await intentSignal();
    const textDeps = options.text;
    if (textDeps === undefined) return outcome;
    const mentions = (message.mentions ?? []).map((m) => m.mentioned.user?.id ?? '').filter((id) => id !== '' && id !== user);
    const textMessage: TextMessage = { id: message.id, authorId: user, text, timestamp, ...(mentions.length === 0 ? {} : { mentions }) };
    const read = await (async (): Promise<TextSignalOutcome> => {
      const modelReads = textDeps.model !== undefined && classifyTextLexicon({ signals }, textMessage).kind === 'none';
      const context = modelReads && (await activeIncident(true)) ? await thread() : [];
      return handleTextSignal(textDeps, {
        platform: 'teams',
        thread: { channel: channelId, rootId },
        message: textMessage,
        actor,
        ...(context.length === 0 ? {} : { context }),
      });
    })().catch((e: unknown) => {
      onError(e);
      return undefined;
    });
    return read === undefined ? outcome : { ...outcome, text: read };
  }

  // Entry points --------------------------------------------------------------------------------------

  async function handleNotification(n: VerifiedNotification, given?: GraphMessage): Promise<TeamsSignalOutcome[]> {
    const { teamId, channelId, messageId } = n;
    if (teamId === undefined || channelId === undefined || messageId === undefined) return [ignored('not-a-channel-message')];
    const id = n.replyId ?? messageId;
    // A reaction notification fetches, diffs and applies as one step per message: a fetch outside the
    // chain could be stale by the time it is applied (a removal applied in between would be re-added).
    // The chain is per process; several replicas still race on the kv set.
    if (n.changeType === 'created') return notified(n, given);
    return serial(id, () => notified(n, given));
  }

  async function notified(n: VerifiedNotification, given: GraphMessage | undefined): Promise<TeamsSignalOutcome[]> {
    const { teamId, channelId, messageId } = n;
    if (teamId === undefined || channelId === undefined || messageId === undefined) return [ignored('not-a-channel-message')];
    const id = n.replyId ?? messageId;
    let message = given;
    if (message === undefined) {
      if (options.graph === undefined) return [ignored('no-graph')];
      try {
        message = await options.graph.message(teamId, channelId, messageId, n.replyId);
      } catch (e) {
        if (e instanceof GraphApiError && e.status === 404) return [ignored('message-gone')];
        throw e;
      }
    }
    if ((message.deletedDateTime ?? null) !== null) return [ignored('deleted-message')];
    const rootId = n.replyId === undefined ? (message.replyToId ?? undefined) : messageId;

    if (n.changeType === 'created') {
      if (rootId === undefined || rootId === id) return [ignored('not-a-thread-reply')];
      return [await reply(teamId, channelId, rootId, message)];
    }
    const site: ReactionSite & { message: GraphMessage } = {
      teamId,
      channelId,
      messageId: id,
      ...(rootId === undefined ? {} : { rootId }),
      message,
      byBot: personId(message.from, botAppId) === undefined,
      deepLink: message.webUrl ?? teamsMessageLink(channelId, id, teamId, rootId),
    };
    return diffMessage(site);
  }

  async function handleNotifications(notifications: readonly VerifiedNotification[]): Promise<TeamsSignalOutcome[]> {
    const out: TeamsSignalOutcome[] = [];
    for (const n of notifications) {
      // Lifecycle events go to the subscriptions (`handleLifecycle`), not here.
      if (n.lifecycleEvent !== undefined) continue;
      try {
        out.push(...(await handleNotification(n)));
      } catch (e) {
        // One notification failing never drops the rest of the batch.
        onError(e);
      }
    }
    return out;
  }

  /** A person's channel thread reply as Bot Framework delivers it under the RSC grant. */
  function threadReply(a: Rec): { teamChannel: string; rootId: string } | undefined {
    if (str(a['type']) !== 'message') return undefined;
    const from = rec(a['from']);
    const fromId = str(from['id']);
    if (str(from['aadObjectId']) === '' || fromId.startsWith('28:') || str(from['role']) === 'bot') return undefined;
    const conversation = rec(a['conversation']);
    const channelData = rec(a['channelData']);
    const inChannel = str(conversation['conversationType']) === 'channel' || str(rec(channelData['channel'])['id']) !== '';
    if (!inChannel) return undefined;
    const split = splitConversationId(str(conversation['id']));
    const id = str(a['id']);
    const rootId = split.threadRootId ?? str(a['replyToId']);
    if (id === '' || rootId === '' || rootId === id) return undefined;
    return { teamChannel: str(rec(channelData['channel'])['id']) || split.channelId, rootId };
  }

  /**
   * True for an activity the transport hands to the signals from its `message` path: a person's channel
   * thread reply (RSC delivers every channel message to the bot). `messageReaction` activities are read
   * too, without asking.
   */
  function observes(activity: unknown): boolean {
    return threadReply(rec(activity)) !== undefined;
  }

  /** A thread reply activity, as the Graph message it is (the same id, so the two sources dedupe). */
  async function replyActivity(a: Rec): Promise<TeamsSignalOutcome[]> {
    const thread = threadReply(a);
    if (thread === undefined) return [ignored('not-a-thread-reply')];
    const from = rec(a['from']);
    const channelData = rec(a['channelData']);
    const map = await options.getMap();
    const teamId = str(rec(channelData['team'])['aadGroupId']) || map.channels.find((c) => c.id === thread.teamChannel)?.teamId || '';
    const mentions = (Array.isArray(a['entities']) ? (a['entities'] as unknown[]) : [])
      .map(rec)
      .filter((e) => str(e['type']) === 'mention')
      .map((e) => rec(e['mentioned']));
    const message: GraphMessage = {
      id: str(a['id']),
      replyToId: thread.rootId,
      createdDateTime: iso(str(a['timestamp']), deps.clock()),
      from: { user: { id: str(from['aadObjectId']), displayName: str(from['name']), userIdentityType: 'aadUser' } },
      body: { contentType: 'html', content: str(a['text']) },
      mentions: mentions.map((m, i) => {
        const id = str(m['id']);
        const isBot = id === botAppId || id === `28:${botAppId}`;
        const aad = str(m['aadObjectId']);
        return {
          id: i,
          mentionText: str(m['name']),
          mentioned: isBot ? { application: { id: botAppId } } : aad === '' ? {} : { user: { id: aad } },
        };
      }),
    };
    return [await reply(teamId, thread.teamChannel, thread.rootId, message)];
  }

  async function handleActivity(activity: unknown): Promise<TeamsSignalOutcome[]> {
    const a = rec(activity);
    if (str(a['type']) === 'message') return replyActivity(a);
    if (str(a['type']) !== 'messageReaction') return [ignored('not-a-reaction-activity')];
    const from = rec(a['from']);
    const fromId = str(from['id']);
    const user = str(from['aadObjectId']);
    if (fromId === botAppId || fromId === `28:${botAppId}` || user === botAppId) return [ignored('own-reaction')];
    if (user === '' || fromId.startsWith('28:')) return [ignored('bot-message')];
    const messageId = str(a['replyToId']);
    const conversation = rec(a['conversation']);
    const conversationId = str(conversation['id']);
    if (messageId === '' || conversationId === '') return [ignored('not-a-channel-message')];
    const channelData = rec(a['channelData']);
    const split = splitConversationId(conversationId);
    const inChannel = str(conversation['conversationType']) === 'channel' || str(rec(channelData['channel'])['id']) !== '';
    const channelId = inChannel ? str(rec(channelData['channel'])['id']) || split.channelId : conversationId;
    const map = await options.getMap();
    const teamId = inChannel ? str(rec(channelData['team'])['aadGroupId']) || map.channels.find((c) => c.id === channelId)?.teamId || undefined : undefined;
    const rootId = inChannel ? split.threadRootId : undefined;
    const at = iso(str(a['timestamp']), deps.clock());
    const types = (key: string): SeenReaction[] =>
      (Array.isArray(a[key]) ? (a[key] as unknown[]) : []).flatMap((r): SeenReaction[] => {
        const type = str(rec(r)['type']);
        const names = teamsReactionNames(type);
        const name = names[0];
        return name === undefined ? [] : [{ user, name, names, type, at }];
      });
    const adds = types('reactionsAdded');
    const removes = types('reactionsRemoved');
    if (adds.length === 0 && removes.length === 0) return [ignored('unknown-reaction')];

    const site: ReactionSite = {
      ...(teamId === undefined ? {} : { teamId }),
      channelId,
      messageId,
      ...(rootId === undefined ? {} : { rootId }),
      byBot: true,
      ...(inChannel ? { deepLink: teamsMessageLink(channelId, messageId, teamId, rootId) } : {}),
    };
    return serial(messageId, async () => {
      const { added, removed } = await applyToSet(messageId, (before) => {
        const next = new Map((before ?? []).map((r) => [keyOf(r), r]));
        for (const r of removes) next.delete(keyOf(r));
        for (const r of adds) if (!next.has(keyOf(r))) next.set(keyOf(r), r);
        return [...next.values()];
      });
      const out: TeamsSignalOutcome[] = [];
      for (const r of added) out.push(...(await guardedChange(site, r, false, at)));
      for (const r of removed) out.push(...(await guardedChange(site, r, true, at)));
      return out.length === 0 ? [ignored('no-change')] : out;
    });
  }

  const onOutcome = options.onOutcome ?? (() => undefined);
  const inFlight = new Set<Promise<void>>();
  const track = (work: Promise<TeamsSignalOutcome[]>): Promise<void> => {
    const task = work
      .then(onOutcome, onError)
      .finally(() => inFlight.delete(task));
    inFlight.add(task);
    return task;
  };
  return {
    handleNotification,
    handleNotifications,
    observes,
    handleActivity,
    onNotifications: (notifications) => track(handleNotifications(notifications)),
    onActivity: (activity) => track(handleActivity(activity)),
    async idle() {
      while (inFlight.size > 0) await Promise.allSettled([...inFlight]);
    },
  };
}

/** A Graph message body as plain text. */
function plainText(message: Pick<GraphMessage, 'body'>): string {
  const content = message.body?.content ?? '';
  return message.body?.contentType === 'text' ? content.trim() : teamsHtmlToText(content);
}
