// Teams interactivity (main 8.2, 11.2, 15.2, 16; A 2.1, A 2.2; B 5 awaitInteractive): what a tap on an
// Adaptive Card button does. Every button is an `Action.Execute` (Universal Actions, #372), so a tap
// arrives as an `invoke` activity named `adaptiveCard/action` carrying the action's `verb` and `data`
// (`{ incidentId }` plus what a Slack block id would carry). The transport (#390) authenticates it and
// hands it to `onInvoke`, whose result is the invoke's HTTP answer.
//
// The rules are Slack's, from `../shared/taps.ts`: card choices to `orchestrator.handleTap` with the
// tapper resolved by AAD object id (`teamsId` in the map); a reporter's `Fix it` reposts the card in the
// thread mentioning the owner (recorded as role `fix-preview`); `stop` and `dismiss` at levels 2 and 3
// through `stopIncident` (plus the Won't Do close); merge, request changes, and revert through the PR
// actions with the tapper's Teams-linked GitHub identity; the mid-flight card (`data.runId`,
// `data.claimerId`) through `answerMidFlight`.
//
// The card a tap belongs to comes from the verb: each card's verbs are its own, except `dismiss`, which
// the fix preview and the claim card share (the incident's pending card decides), and a clarify card,
// whose verbs are its options (any verb no other card uses). A tap whose data names a `messageId` is a
// text-signal card's (A 3), which this module leaves to the signals.
//
// Teams has no ephemeral message, so the invoke answer carries the outcome: `onAction` resolves to the
// card refreshed with who chose what in place of its buttons, or, for a refused tap, the same card with a
// one-line reason, and the transport (#390, `TeamsInteractivity.onAction`) answers the invoke with it. An
// invoke does not carry the card it came from, so `rememberTeamsCards` wraps the Bot Connector client and
// keeps every card with an `Action.Execute` button it posts or edits in kv
// `teams-card:{conversation}:{activityId}` (30 days); compose wraps the connector the adapter and the
// chat surface post through. With no remembered card, an accepted tap answers with a card of the line
// alone and a refused one with no card (the card stays as it was; the reason is lost).
//
// Teams waits 5 s for an invoke, and the transport answers "Working on it" past its 4 s budget. A tap
// that took longer than `editAfterMs` (3 s) therefore also edits its card in place (`updateActivity`)
// once it is done; an edit the answer made unnecessary is harmless.

import type { CardKind } from '@snapwing/pipeline/engine/cursor.ts';
import { foldCursor, nextPhase, pendingCard } from '@snapwing/pipeline/engine/cursor.ts';
import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { MidFlightAnswer, MidFlightAnswerInput } from '@snapwing/pipeline/fixer/claims.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import { mentionToken, statusTextParts } from '@snapwing/pipeline/status/copy.ts';
import {
  askedOwnerText,
  askOwnerLead,
  createTapCore,
  type ChatTap,
  type InteractivityOutcome,
  type LineFormat,
  type PrActions,
  type TapCard,
  type TapReply,
} from '../shared/taps.ts';
import { ADAPTIVE_CARD_CONTENT_TYPE, cardActivity } from './adapter.ts';
import {
  assertLimits,
  card as buildCard,
  mentionsFromMap,
  refreshed,
  renderText,
  textBlock,
  type AdaptiveCard,
  type MentionEntity,
  type MentionFor,
} from './cards/elements.ts';
import { midFlightChoiceOf } from './cards/mid-flight.ts';
import type { TeamsConnector, TeamsOutgoingActivity, TeamsResourceResponse } from './connector.ts';
import { splitConversationId } from './conversations.ts';

export type { InteractivityOutcome, PrActionInput, PrActions } from '../shared/taps.ts';

/** The invoke `name` of a Universal Actions tap. */
export const CARD_ACTION_INVOKE = 'adaptiveCard/action';
/** A tap slower than this also edits its card in place: the transport may have answered without it. */
export const EDIT_AFTER_MS = 3_000;
/** Remembered cards outlive every button on them (the 72 h revert window, a status message's Stop). */
export const TEAMS_CARD_TTL_SEC = 30 * 24 * 60 * 60;

export const teamsCardKey = (conversationId: string, activityId: string): string =>
  `teams-card:${splitConversationId(conversationId).channelId}:${activityId}`;

/** The cards Snapwing posted, by conversation (a channel thread counts as its channel) and activity id. */
export interface TeamsCardStore {
  get(conversationId: string, activityId: string): Promise<AdaptiveCard | undefined>;
  set(conversationId: string, activityId: string, card: AdaptiveCard): Promise<void>;
}

function isCard(v: unknown): v is AdaptiveCard {
  const c = rec(v);
  return c['type'] === 'AdaptiveCard' && Array.isArray(c['body']);
}

/** The default card store: kv `teams-card:{conversation}:{activityId}`, 30 days. */
export function createKvTeamsCardStore(cache: Pick<CachePort, 'get' | 'set'>): TeamsCardStore {
  return {
    async get(conversationId, activityId) {
      const raw = await cache.get(teamsCardKey(conversationId, activityId));
      if (raw === null) return undefined;
      try {
        const parsed: unknown = JSON.parse(raw);
        return isCard(parsed) ? parsed : undefined;
      } catch {
        return undefined;
      }
    },
    set: (conversationId, activityId, card) => cache.set(teamsCardKey(conversationId, activityId), JSON.stringify(card), TEAMS_CARD_TTL_SEC),
  };
}

/** The Adaptive Card an outgoing activity carries, if any. */
function cardOf(activity: TeamsOutgoingActivity): AdaptiveCard | undefined {
  for (const a of activity.attachments ?? []) {
    const att = rec(a);
    if (att['contentType'] === ADAPTIVE_CARD_CONTENT_TYPE && isCard(att['content'])) return att['content'];
  }
  return undefined;
}

const hasExecute = (c: AdaptiveCard): boolean => (c.actions ?? []).some((a) => a.type === 'Action.Execute');

/**
 * The connector, remembering each card with an `Action.Execute` button it posts, and each card it edits
 * in place, so a tap on it can be answered with the same card. Remembering is best effort (`onError`).
 */
export function rememberTeamsCards<C extends Pick<TeamsConnector, 'sendToConversation' | 'replyToActivity' | 'updateActivity'>>(
  connector: C,
  store: TeamsCardStore,
  onError: (error: unknown) => void = () => undefined,
): C {
  const remember = async (conversationId: string, out: TeamsResourceResponse, activity: TeamsOutgoingActivity, edit: boolean) => {
    const card = cardOf(activity);
    if (card === undefined || (!edit && !hasExecute(card)) || out.id === '') return;
    await store.set(conversationId, out.id, card).catch(onError);
  };
  return {
    ...connector,
    async sendToConversation(ref, activity) {
      const out = await connector.sendToConversation(ref, activity);
      await remember(ref.conversationId, out, activity, false);
      return out;
    },
    async replyToActivity(args, activity) {
      const out = await connector.replyToActivity(args, activity);
      await remember(args.conversationId, out, activity, false);
      return out;
    },
    async updateActivity(ref, activity) {
      const out = await connector.updateActivity(ref, activity);
      await remember(ref.conversationId, { id: ref.activityId }, activity, true);
      return out;
    },
  };
}

/** What a tap did, and the card to answer it with (undefined: leave the tapped card as it is). */
export interface TeamsTapResult {
  outcome: InteractivityOutcome;
  card?: AdaptiveCard;
}

export interface TeamsInteractivityOptions {
  /** The Bot Connector client, for the owner repost and a slow tap's edit in place. */
  connector: Pick<TeamsConnector, 'sendToConversation' | 'replyToActivity' | 'updateActivity'>;
  /** kv for the default card store. */
  cache: Pick<CachePort, 'get' | 'set'>;
  /** Default: kv `teams-card:{conversation}:{activityId}` over `cache`. */
  cardStore?: TeamsCardStore;
  state: StatePort;
  /** The install's workspace, stamped on the events this module appends. */
  workspaceId: string;
  orchestrator: { handleTap(tap: TapInput): Promise<TapOutcome> };
  /** `stopIncident` from `@snapwing/pipeline/fixer/stop.ts`, bound to its FixerDeps. */
  stopIncident: (input: StopInput) => Promise<StopOutcome>;
  /** The PR actions for Teams (compose's `prActionsFor('teams')`), acting as the tapper's linked identity. */
  prActions: PrActions;
  /** The mid-flight card's taps (`answerMidFlight`, A 2.2). Absent: those taps are ignored. */
  midFlight?: (input: MidFlightAnswerInput) => Promise<MidFlightAnswer>;
  /** The current workspace map; read per tap so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** True when the AAD object id has a linked GitHub identity (ADR 0007, chat `teams`). Default: nobody. */
  githubLinked?: (aadObjectId: string) => boolean | Promise<boolean>;
  clock?: () => Date;
  /** A tap slower than this also edits its card in place. Default `EDIT_AFTER_MS`. */
  editAfterMs?: number;
  /** Called with what each `onAction` did (logs, metrics). */
  onOutcome?: (outcome: InteractivityOutcome) => void;
  /** Errors from best-effort work (the repost, remembering cards, a slow tap's edit). */
  onError?: (error: unknown) => void;
}

/** The transport's `TeamsInteractivity` (#390) plus `handleInvoke` for tests. */
export interface TeamsInteractivity {
  /** One invoke activity; resolves to what it did and the answer card. Rejects when the tap's work failed. */
  handleInvoke(activity: unknown): Promise<TeamsTapResult>;
  /**
   * The transport's handler: the card the invoke is answered with (undefined leaves the tapped card), the
   * outcome passed to `onOutcome`, and the card edited in place when the tap was slow. Rejects when the
   * tap's work failed; the transport answers that with an error.
   */
  onAction(activity: unknown): Promise<AdaptiveCard | undefined>;
}


type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}

/** The parts of an `adaptiveCard/action` invoke this module reads. */
interface Invoke {
  serviceUrl: string;
  /** The conversation as the activity names it (a channel thread is `{channel};messageid={root}`). */
  conversationId: string;
  channelId: string;
  threadRootId?: string;
  /** The message the card is in. */
  cardActivityId?: string;
  /** The tapper's AAD object id and display name. */
  userId: string;
  userName?: string;
  verb: string;
  title?: string;
  data: Readonly<Record<string, string>>;
  incidentId: string;
}

type Parsed = { ok: true; invoke: Invoke } | { ok: false; reason: string };

function parseInvoke(activity: unknown): Parsed {
  const a = rec(activity);
  if (a['type'] !== 'invoke' || a['name'] !== CARD_ACTION_INVOKE) return { ok: false, reason: 'not-a-card-action' };
  const action = rec(rec(a['value'])['action']);
  if (action['type'] !== 'Action.Execute') return { ok: false, reason: 'not-execute' };
  const data: Record<string, string> = {};
  for (const [k, v] of Object.entries(rec(action['data']))) if (typeof v === 'string') data[k] = v;
  const from = rec(a['from']);
  const userId = str(from['aadObjectId']);
  const verb = str(action['verb']);
  const incidentId = data['incidentId'] ?? '';
  const serviceUrl = str(a['serviceUrl']);
  const conversationId = str(rec(a['conversation'])['id']);
  if (userId === '' || verb === '' || incidentId === '' || serviceUrl === '' || conversationId === '') return { ok: false, reason: 'malformed' };
  const split = splitConversationId(conversationId);
  const cardActivityId = str(a['replyToId']);
  const title = str(action['title']);
  const userName = str(from['name']);
  return {
    ok: true,
    invoke: {
      serviceUrl,
      conversationId,
      channelId: str(rec(rec(a['channelData'])['channel'])['id']) || split.channelId,
      ...(split.threadRootId === undefined ? {} : { threadRootId: split.threadRootId }),
      ...(cardActivityId === '' ? {} : { cardActivityId }),
      userId,
      ...(userName === '' ? {} : { userName }),
      verb,
      ...(title === '' ? {} : { title }),
      data,
      incidentId,
    },
  };
}

/** The card each verb belongs to; `dismiss` and clarify options are decided per tap. */
const VERB_CARDS: Readonly<Record<string, CardKind>> = {
  'looks-right': 'scope-preview',
  widen: 'scope-preview',
  narrow: 'scope-preview',
  link: 'dedupe',
  'create-anyway': 'dedupe',
  'not-related': 'dedupe',
  approve_fix: 'fix-preview',
  ticket_only: 'fix-preview',
  'let-agent-take': 'claimed',
  'file-it': 'file-confirm',
  'not-this-surface': 'file-confirm',
  cancel: 'file-confirm',
};

/** The verbs the shared rules route before the card matters (status message, PR card, fix preview at levels 2 and 3). */
const ROUTED_VERBS: ReadonlySet<string> = new Set(['stop', 'merge', 'request_changes', 'revert']);

/** The shared tap lines as neutral text: mention tokens, rendered as `<at>` by `renderText`, and plain words. */
const TEAMS_FORMAT: LineFormat = { who: mentionToken, bold: (text) => text };

/** Neutral text as plain text (a message answer, a card's fallback): a mention as `@name`. */
function plainText(neutral: string, mentions: MentionFor): string {
  return statusTextParts(neutral)
    .map((p) => (p.kind === 'text' ? p.text : `@${mentions(p.ref)?.name ?? p.ref}`))
    .join('');
}

function mergeEntities(into: MentionEntity[], more: readonly MentionEntity[]): MentionEntity[] {
  for (const e of more) if (!into.some((x) => x.mentioned.id === e.mentioned.id)) into.push(e);
  return into;
}

/** The same card, buttons kept, with one line below its body (a refused tap's reason). */
export function withReason(c: AdaptiveCard, line: string, mentions?: MentionFor): AdaptiveCard {
  const rendered = renderText(line, mentions);
  const entities = mergeEntities([...(c.msteams?.entities ?? [])], rendered.entities);
  const out: AdaptiveCard = {
    ...c,
    body: [...c.body, textBlock(rendered.text, { spacing: 'Small' })],
    ...(entities.length === 0 ? {} : { msteams: { entities } }),
  };
  assertLimits(out);
  return out;
}

/** The same card, buttons kept, led by `line` (the fix preview reposted for the owner, main 8.2). */
function withLead(c: AdaptiveCard, line: string, mentions: MentionFor): AdaptiveCard {
  const rendered = renderText(line, mentions);
  const entities = mergeEntities([...rendered.entities], c.msteams?.entities ?? []);
  const out: AdaptiveCard = {
    ...c,
    fallbackText: plainText(line, mentions),
    body: [textBlock(rendered.text), ...c.body],
    ...(entities.length === 0 ? {} : { msteams: { entities } }),
  };
  assertLimits(out);
  return out;
}

export function createTeamsInteractivity(options: TeamsInteractivityOptions): TeamsInteractivity {
  const { state, connector } = options;
  const clock = options.clock ?? (() => new Date());
  const onError = options.onError ?? (() => undefined);
  const onOutcome = options.onOutcome ?? (() => undefined);
  const editAfterMs = options.editAfterMs ?? EDIT_AFTER_MS;
  const cards = options.cardStore ?? createKvTeamsCardStore(options.cache);
  const core = createTapCore({
    platform: 'teams',
    state,
    workspaceId: options.workspaceId,
    orchestrator: options.orchestrator,
    stopIncident: options.stopIncident,
    prActions: options.prActions,
    ...(options.midFlight === undefined ? {} : { midFlight: options.midFlight }),
    getMap: options.getMap,
    ...(options.githubLinked === undefined ? {} : { githubLinked: options.githubLinked }),
    clock,
    format: TEAMS_FORMAT,
  });

  async function storedCard(inv: Invoke): Promise<AdaptiveCard | undefined> {
    if (inv.cardActivityId === undefined) return undefined;
    try {
      return await cards.get(inv.conversationId, inv.cardActivityId);
    } catch (err) {
      onError(err);
      return undefined;
    }
  }

  /** `dismiss` is the claim card's while the incident waits on it (A 2.1), else the fix preview's. */
  async function dismissCard(incidentId: string): Promise<CardKind> {
    const cursor = foldCursor(incidentId, await state.read(incidentId));
    if (cursor.captured === undefined) return 'fix-preview';
    return pendingCard(nextPhase(cursor, { scopePreview: false })) === 'claimed' ? 'claimed' : 'fix-preview';
  }

  async function cardFor(inv: Invoke): Promise<TapCard | 'text-signal'> {
    if (inv.data['runId'] !== undefined && inv.data['claimerId'] !== undefined) return 'mid-flight';
    if (inv.data['messageId'] !== undefined) return 'text-signal';
    if (ROUTED_VERBS.has(inv.verb)) return 'status';
    if (inv.verb === 'dismiss') return dismissCard(inv.incidentId);
    return VERB_CARDS[inv.verb] ?? 'clarify';
  }

  /** main 8.2: reposts the reporter's card in the thread, led by a line mentioning the owner. */
  async function repostForOwner(inv: Invoke, stored: AdaptiveCard, ownerId: string, mentions: MentionFor): Promise<void> {
    const repost = withLead(stored, askOwnerLead(TEAMS_FORMAT, ownerId, inv.userId), mentions);
    const activity = cardActivity(repost);
    const posted =
      inv.threadRootId === undefined
        ? await connector.sendToConversation({ serviceUrl: inv.serviceUrl, conversationId: inv.conversationId }, activity)
        : await connector.replyToActivity(
            { serviceUrl: inv.serviceUrl, conversationId: inv.channelId, activityId: inv.threadRootId, threadRootId: inv.threadRootId },
            activity,
          );
    await cards.set(inv.conversationId, posted.id, repost).catch(onError);
    const ref = { platform: 'teams', channel: inv.channelId, messageId: posted.id, role: 'fix-preview' } as const;
    await recordBotMessage(state, inv.incidentId, ref, clock).catch(onError);
  }

  /** A refused tap: the same card with the reason. With no remembered card there is nothing to show it on. */
  const refused = (stored: AdaptiveCard | undefined, line: string, mentions: MentionFor): AdaptiveCard | undefined =>
    stored === undefined ? undefined : withReason(stored, line, mentions);

  async function answer(inv: Invoke, stored: AdaptiveCard | undefined, reply: TapReply, mentions: MentionFor): Promise<AdaptiveCard | undefined> {
    switch (reply.kind) {
      case 'mark': {
        const next = stored === undefined ? buildCard(plainText(reply.line, mentions), [renderText(reply.line, mentions)]) : refreshed(stored, reply.line, { mentions });
        if (inv.cardActivityId !== undefined) await cards.set(inv.conversationId, inv.cardActivityId, next).catch(onError);
        return next;
      }
      case 'refuse':
        return refused(stored, reply.text, mentions);
      case 'refuse-pr':
        return refused(stored, reply.linkUrl === undefined ? reply.message : `${reply.message} Link your GitHub account: ${reply.linkUrl}`, mentions);
      case 'ask-owner':
        if (reply.ownerId !== undefined && stored !== undefined) await repostForOwner(inv, stored, reply.ownerId, mentions).catch(onError);
        return refused(stored, askedOwnerText(TEAMS_FORMAT, reply.ownerId), mentions);
      case 'none':
        return stored;
    }
  }

  /** A tap's result, with the invoke and, after a refusal shown on the card, the card to keep remembered. */
  type Handled = TeamsTapResult & { inv?: Invoke; original?: AdaptiveCard };

  async function handle(inv: Invoke): Promise<Handled> {
    const stored = await storedCard(inv);
    const card = await cardFor(inv);
    if (card === 'text-signal') return { outcome: { kind: 'ignored', reason: 'text-signal-card' }, ...(stored === undefined ? {} : { card: stored }) };
    const label = stored?.actions?.find((a) => a.type === 'Action.Execute' && a.verb === inv.verb)?.title ?? inv.title ?? inv.verb;
    const tap: ChatTap = {
      userId: inv.userId,
      incidentId: inv.incidentId,
      action: inv.verb,
      card,
      label,
      ...(card === 'mid-flight'
        ? { midFlight: { runId: inv.data['runId'] ?? '', claimerId: inv.data['claimerId'] ?? '', choice: midFlightChoiceOf(inv.verb) } }
        : {}),
    };
    const result = await core.run(tap);
    const fromMap = mentionsFromMap((await options.getMap()).people);
    // The tapper may be outside the map; the activity names them.
    const mentions: MentionFor = (ref) => fromMap(ref) ?? (ref === inv.userId && inv.userName !== undefined ? { id: ref, name: inv.userName } : undefined);
    const answered = await answer(inv, stored, result.reply, mentions);
    return {
      outcome: result.outcome,
      ...(answered === undefined ? {} : { card: answered }),
      inv,
      ...(result.reply.kind === 'mark' || stored === undefined ? {} : { original: stored }),
    };
  }

  async function run(activity: unknown): Promise<Handled> {
    const parsed = parseInvoke(activity);
    if (!parsed.ok) return { outcome: { kind: 'ignored', reason: parsed.reason } };
    return handle(parsed.invoke);
  }

  /** A slow tap: the answer card put in place of the tapped one, then the original remembered again after a refusal. */
  async function editInPlace(handled: Handled): Promise<void> {
    const { inv, card, original } = handled;
    const id = inv?.cardActivityId;
    if (inv === undefined || id === undefined || card === undefined) return;
    await connector.updateActivity({ serviceUrl: inv.serviceUrl, conversationId: inv.conversationId, activityId: id }, cardActivity(card));
    if (original !== undefined) await cards.set(inv.conversationId, id, original);
  }

  return {
    async handleInvoke(activity) {
      const { outcome, card } = await run(activity);
      return { outcome, ...(card === undefined ? {} : { card }) };
    },
    async onAction(activity) {
      const started = Date.now();
      const handled = await run(activity);
      onOutcome(handled.outcome);
      if (Date.now() - started >= editAfterMs) await editInPlace(handled).catch(onError);
      return handled.card;
    },
  };
}
