// Teams interactivity (main 8.2, 11.2, 15.2, 16; A 2.1, A 2.2; B 5 awaitInteractive): what a tap on an
// Adaptive Card button does. Every button is an `Action.Execute` (Universal Actions), so a tap
// arrives as an `invoke` activity named `adaptiveCard/action` carrying the action's `verb` and `data`
// (`{ incidentId }` plus what a Slack block id would carry). The transport authenticates it and
// hands it to `onAction`, whose card answers the invoke.
//
// The rules are Slack's, from `../shared/taps.ts`: card choices to `orchestrator.handleTap` with the
// tapper resolved by AAD object id (`teamsId` in the map); a reporter's `Fix it` reposts the card in the
// thread mentioning the owner (recorded as role `fix-preview`); `stop` and `dismiss` at levels 2 and 3
// through `stopIncident` (plus the Won't Do close); merge, request changes, and revert through the PR
// actions with the tapper's Teams-linked GitHub identity; the mid-flight card (`data.runId`,
// `data.claimerId`) through `answerMidFlight`.
//
// The card a tap belongs to comes from the verb: each card's verbs are its own, except `dismiss`, which
// the fix preview and the claim card share, and a clarify card, whose verbs are its options. A clarify
// option is free text and may equal any other card's verb (`stop`, `merge`, `link`), so the clarify card
// says what it is in its action data (`card: 'clarify'`) and such a tap never reaches that verb's path.
// `dismiss` is the claim card's when the tapped card (as remembered, below) has `Let the agent take it`,
// else the fix preview's; only with no remembered card does the incident's pending card decide. A card
// choice whose button the remembered card no longer has was already answered (an accepted tap takes the
// buttons away) and is told "This card already has an answer", as on Slack.
//
// A tap whose data names a `messageId` is a text-signal card's (A 3): the resolution question (`close`,
// `keep-open`) goes to `answerResolution` and the scope-change card (`yes`, `same-bug`) to
// `answerScopeChange`, as Slack's signals answer them (`SlackSignals.onAction`), when `text` is given.
// An answer marks the card; a refusal tells the tapper why (`textSignalRefusal`).
//
// Teams has no ephemeral message, and the card in an invoke answer updates only the tapper's view. So an
// accepted tap edits its card in place for everyone (`updateActivity`, who chose what in place of the
// buttons, as Slack's edited message) and answers the invoke with the same card. A refused tap answers
// the invoke alone, with the same card and a one-line reason, and never touches the shared message. A
// refusal that carries a GitHub link (`/auth/github/start?state=...`, single use and bound to the
// tapper) never puts the link on a card: it goes to the tapper's personal chat with the bot as an
// `Action.OpenUrl` button, and the reason on the card says so. The transport
// (`TeamsInteractivity.onAction`) answers the invoke with `onAction`'s card, or with "Working on it" past
// its 4 s budget; an accepted tap's edit has landed either way, and a refusal that lands past the budget
// (the transport says so, `TeamsInvokeBudget`) goes to the tapper's personal chat, since its card is
// never shown.
//
// An invoke does not carry the card it came from, so `rememberTeamsCards` wraps the Bot Connector client
// and keeps every card with an `Action.Execute` button it posts or edits in kv
// `teams-card:{conversation}:{activityId}` (30 days); compose wraps the connector the adapter and the
// chat surface post through. With no remembered card, an accepted tap answers with a card of the line
// alone and edits nothing (there is no card body to keep), a refused one answers with no card (the card
// stays as it was; the reason is lost), and a reporter's `Fix it` still reaches the owner: the thread gets
// the line that mentions them, without the card.

import type { IncidentActor } from '@snapwing/pipeline/contracts/incident.ts';
import type { CardKind } from '@snapwing/pipeline/engine/cursor.ts';
import { foldCursor, nextPhase, pendingCard } from '@snapwing/pipeline/engine/cursor.ts';
import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { MidFlightAnswer, MidFlightAnswerInput } from '@snapwing/pipeline/fixer/claims.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { CachePort } from '@snapwing/pipeline/ports/cache.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import {
  answerResolution,
  answerScopeChange,
  type ResolutionChoice,
  type ScopeChoice,
  type TextSignalDeps,
  type TextSignalOutcome,
} from '@snapwing/pipeline/signals/text.ts';
import { mentionToken, statusTextParts } from '@snapwing/pipeline/status/copy.ts';
import {
  askedOwnerText,
  askOwnerLead,
  createTapCore,
  NOT_PENDING_TEXT,
  textSignalRefusal,
  type ChatTap,
  type InteractivityOutcome,
  type LineFormat,
  type PrActions,
  type TapCard,
  type TapReply,
} from '../shared/taps.ts';
import { pinFromData } from '../shared/pr-pin.ts';
import { ADAPTIVE_CARD_CONTENT_TYPE, cardActivity } from './adapter.ts';
import {
  assertLimits,
  card as buildCard,
  esc,
  mentionsFromMap,
  refreshed,
  renderText,
  textBlock,
  type AdaptiveCard,
  type MentionEntity,
  type MentionFor,
} from './cards/elements.ts';
import { CLARIFY_DATA } from './cards/cards.ts';
import { midFlightChoiceOf } from './cards/mid-flight.ts';
import type { TeamsConnector, TeamsConversationRef, TeamsOutgoingActivity, TeamsResourceResponse } from './connector.ts';
import { splitConversationId } from './conversations.ts';
import type { TeamsInvokeBudget } from './transport.ts';

export type { InteractivityOutcome, PrActionInput, PrActions } from '../shared/taps.ts';

/** The invoke `name` of a Universal Actions tap. */
export const CARD_ACTION_INVOKE = 'adaptiveCard/action';
/** The button, in the tapper's personal chat, that opens the GitHub link. */
export const LINK_GITHUB_LABEL = 'Link your GitHub account';
/** Said on a refused card when the GitHub link went to the tapper's personal chat. */
export const LINK_SENT_TEXT = "I've sent you the link in our personal chat.";
/** Said on a refused card when the tapper's personal chat could not be opened (no personal install). */
export const LINK_NOT_SENT_TEXT = "I can't message you directly yet. Add Snapwing as a personal app in Teams, then tap again for the link.";
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

/** What a tap did: the shared outcomes, or an answer to a text-signal card (A 3). */
export type TeamsTapOutcome = InteractivityOutcome | { kind: 'text-signal'; incidentId: string; choice: string; outcome: TextSignalOutcome };

/** What a tap did, and the card to answer it with (undefined: leave the tapped card as it is). */
export interface TeamsTapResult {
  outcome: TeamsTapOutcome;
  card?: AdaptiveCard;
}

export interface TeamsInteractivityOptions {
  /** The Bot Connector client: the owner repost, an accepted tap's edit in place, the tapper's personal chat. */
  connector: Pick<TeamsConnector, 'sendToConversation' | 'replyToActivity' | 'updateActivity' | 'createPersonalConversation'>;
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
  /** The text-signal cards' taps (A 3: the resolution question, the scope-change card). Absent: those taps are ignored. */
  text?: TextSignalDeps;
  /** The current workspace map; read per tap so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** True when the AAD object id has a linked GitHub identity (ADR 0007, chat `teams`). Default: nobody. */
  githubLinked?: (aadObjectId: string) => boolean | Promise<boolean>;
  clock?: () => Date;
  /** Called with what each `onAction` did (logs, metrics). */
  onOutcome?: (outcome: TeamsTapOutcome) => void;
  /** Errors from best-effort work (the repost, remembering cards, an accepted tap's edit, the personal chat). */
  onError?: (error: unknown) => void;
}

/** The transport's `TeamsInteractivity` plus `handleInvoke` for tests. */
export interface TeamsInteractivity {
  /** One invoke activity; resolves to what it did and the answer card. Rejects when the tap's work failed. */
  handleInvoke(activity: unknown): Promise<TeamsTapResult>;
  /**
   * The transport's handler: the card the invoke is answered with (undefined leaves the tapped card), with
   * the outcome passed to `onOutcome`. Once `budget` has expired that card is never shown, so a refusal also
   * goes to the tapper's personal chat. Rejects when the tap's work failed; the transport answers that with
   * an error.
   */
  onAction(activity: unknown, budget?: TeamsInvokeBudget): Promise<AdaptiveCard | undefined>;
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
  /** The card is in the tapper's personal chat with the bot. */
  personal: boolean;
  /** The tenant, for opening the tapper's personal chat. */
  tenantId?: string;
  /** The tapper's AAD object id and display name. */
  userId: string;
  userName?: string;
  /** The tapper's `29:` Teams id, preferred when opening their personal chat. */
  teamsUserId?: string;
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
  const conversation = rec(a['conversation']);
  const conversationId = str(conversation['id']);
  if (userId === '' || verb === '' || incidentId === '' || serviceUrl === '' || conversationId === '') return { ok: false, reason: 'malformed' };
  const split = splitConversationId(conversationId);
  const channelData = rec(a['channelData']);
  const cardActivityId = str(a['replyToId']);
  const tenantId = str(rec(channelData['tenant'])['id']) || str(conversation['tenantId']);
  const title = str(action['title']);
  const userName = str(from['name']);
  const fromId = str(from['id']);
  return {
    ok: true,
    invoke: {
      serviceUrl,
      conversationId,
      channelId: str(rec(channelData['channel'])['id']) || split.channelId,
      ...(split.threadRootId === undefined ? {} : { threadRootId: split.threadRootId }),
      ...(cardActivityId === '' ? {} : { cardActivityId }),
      personal: str(conversation['conversationType']) === 'personal',
      ...(tenantId === '' ? {} : { tenantId }),
      userId,
      ...(userName === '' ? {} : { userName }),
      ...(fromId.startsWith('29:') ? { teamsUserId: fromId } : {}),
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

/** The resolution question's verbs (A 3, `cards/signals.ts`). */
const RESOLUTION_VERBS: readonly ResolutionChoice[] = ['close', 'keep-open'];
/** The scope-change card's verbs (A 3, `cards/signals.ts`). */
const SCOPE_VERBS: readonly ScopeChoice[] = ['yes', 'same-bug'];

/** Free text made safe in neutral text: no angle brackets, so it can never forge a mention token or an `<at>` tag. */
const noTokens = (text: string): string => text.replace(/[<>]/g, '');

/**
 * The shared tap lines as neutral text: mention tokens, rendered as `<at>` by `renderText`, and plain
 * words. A label is free text (a clarify option may be model-written), so it loses its angle brackets.
 */
export const TEAMS_FORMAT: LineFormat = { who: mentionToken, bold: noTokens };

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

  /** With no remembered card: `dismiss` is the claim card's while the incident waits on it (A 2.1), else the fix preview's. */
  async function dismissCard(incidentId: string): Promise<CardKind> {
    const cursor = foldCursor(incidentId, await state.read(incidentId));
    if (cursor.captured === undefined) return 'fix-preview';
    return pendingCard(nextPhase(cursor, { scopePreview: false })) === 'claimed' ? 'claimed' : 'fix-preview';
  }

  /**
   * The card the tap came from, by its verb and the remembered card's buttons. `answered`: a card choice
   * whose button the remembered card no longer has, so the card was answered (or replaced) already.
   */
  async function cardFor(inv: Invoke, stored: AdaptiveCard | undefined): Promise<TapCard | 'text-signal' | 'answered'> {
    if (inv.data['runId'] !== undefined && inv.data['claimerId'] !== undefined) return 'mid-flight';
    if (inv.data['messageId'] !== undefined) return 'text-signal';
    const verbs = new Set((stored?.actions ?? []).flatMap((a) => (a.type === 'Action.Execute' ? [a.verb] : [])));
    // A clarify option is free text: the card says it is a clarify card, so `stop` there is an answer, not a Stop.
    if (inv.data['card'] === CLARIFY_DATA.card) return stored === undefined || verbs.has(inv.verb) ? 'clarify' : 'answered';
    if (ROUTED_VERBS.has(inv.verb)) return 'status';
    if (stored === undefined) return inv.verb === 'dismiss' ? dismissCard(inv.incidentId) : (VERB_CARDS[inv.verb] ?? 'clarify');
    if (!verbs.has(inv.verb)) return 'answered';
    // The claim card's `Not a bug` is a card choice; the fix preview's is a Stop at levels 2 and 3.
    if (inv.verb === 'dismiss') return verbs.has('let-agent-take') ? 'claimed' : 'fix-preview';
    return VERB_CARDS[inv.verb] ?? 'clarify';
  }

  /** The map's people, and the tapper by the name the activity gives (they may be outside the map). */
  async function mentionsFor(inv: Invoke): Promise<MentionFor> {
    const fromMap = mentionsFromMap((await options.getMap()).people);
    return (ref) => fromMap(ref) ?? (ref === inv.userId && inv.userName !== undefined ? { id: ref, name: inv.userName } : undefined);
  }

  /** The tapped button's text: from the remembered card, else the invoke's title, else the verb. */
  const labelOf = (inv: Invoke, stored: AdaptiveCard | undefined): string =>
    stored?.actions?.find((a) => a.type === 'Action.Execute' && a.verb === inv.verb)?.title ?? inv.title ?? inv.verb;

  /**
   * main 8.2: reposts the reporter's card in the thread, led by a line mentioning the owner. With no
   * remembered card the line goes alone, so the owner is still asked (the card above keeps its buttons).
   */
  async function repostForOwner(inv: Invoke, stored: AdaptiveCard | undefined, ownerId: string, mentions: MentionFor): Promise<void> {
    const lead = askOwnerLead(TEAMS_FORMAT, ownerId, inv.userId);
    const repost = stored === undefined ? buildCard(plainText(lead, mentions), [renderText(lead, mentions)]) : withLead(stored, lead, mentions);
    const activity = cardActivity(repost);
    const posted =
      inv.threadRootId === undefined
        ? await connector.sendToConversation({ serviceUrl: inv.serviceUrl, conversationId: inv.conversationId }, activity)
        : await connector.replyToActivity(
            { serviceUrl: inv.serviceUrl, conversationId: inv.channelId, activityId: inv.threadRootId, threadRootId: inv.threadRootId },
            activity,
          );
    if (stored !== undefined) await cards.set(inv.conversationId, posted.id, repost).catch(onError);
    const ref = { platform: 'teams', channel: inv.channelId, messageId: posted.id, role: stored === undefined ? 'other' : 'fix-preview' } as const;
    await recordBotMessage(state, inv.incidentId, ref, clock).catch(onError);
  }

  /**
   * An accepted tap: the card with who chose what in place of its buttons, put in place for everyone (the
   * invoke answer updates only the tapper's view) and remembered. With no remembered card there is no
   * body to keep, so the shared message is left as it is and the answer is the line alone.
   */
  async function markCard(inv: Invoke, stored: AdaptiveCard | undefined, line: string, mentions: MentionFor): Promise<AdaptiveCard> {
    const next = stored === undefined ? buildCard(plainText(line, mentions), [renderText(line, mentions)]) : refreshed(stored, line, { mentions });
    const id = inv.cardActivityId;
    if (id === undefined) return next;
    await cards.set(inv.conversationId, id, next).catch(onError);
    if (stored !== undefined) {
      const ref = { serviceUrl: inv.serviceUrl, conversationId: inv.conversationId, activityId: id };
      await connector.updateActivity(ref, cardActivity(next)).catch(onError);
    }
    return next;
  }

  /**
   * The tapper's personal chat with the bot (the tapped conversation, when the tap was there). Undefined
   * when no tenant is known to open it; a throw when Teams will not (the app is not installed for them).
   */
  async function personalChat(inv: Invoke): Promise<TeamsConversationRef | undefined> {
    if (inv.personal) return { serviceUrl: inv.serviceUrl, conversationId: inv.conversationId };
    if (inv.tenantId === undefined) return undefined;
    const chat = await connector.createPersonalConversation({
      serviceUrl: inv.serviceUrl,
      tenantId: inv.tenantId,
      aadObjectId: inv.userId,
      ...(inv.teamsUserId === undefined ? {} : { userId: inv.teamsUserId }),
    });
    return { serviceUrl: chat.serviceUrl ?? inv.serviceUrl, conversationId: chat.id };
  }

  /**
   * The GitHub link, in the tapper's personal chat with the bot: `text` and an `Action.OpenUrl` button, so
   * the single-use link is never escaped into card text or shown in the channel. False when the chat
   * cannot be opened (Teams opens one only where the app is installed for the tapper).
   */
  async function sendLinkPrivately(inv: Invoke, text: string, linkUrl: string): Promise<boolean> {
    try {
      const to = await personalChat(inv);
      if (to === undefined) return false;
      const prompt = buildCard(text, [textBlock(esc(text))], [{ type: 'Action.OpenUrl', title: LINK_GITHUB_LABEL, url: linkUrl }]);
      await connector.sendToConversation(to, cardActivity(prompt));
      return true;
    } catch (err) {
      onError(err);
      return false;
    }
  }

  /** A refusal whose answer card is never shown (it landed past the transport's budget), in the tapper's personal chat. */
  async function tellPrivately(inv: Invoke, line: string): Promise<void> {
    try {
      const to = await personalChat(inv);
      if (to === undefined) {
        onError(new Error(`teams tap: a refusal for ${inv.userId} came after the invoke was answered, and no tenant is known to open their personal chat`));
        return;
      }
      const mentions = await mentionsFor(inv);
      await connector.sendToConversation(to, cardActivity(buildCard(plainText(line, mentions), [renderText(line, mentions)])));
    } catch (err) {
      onError(err);
    }
  }

  /** A refused tap: the same card with the reason, for the tapper alone. With no remembered card there is nothing to show it on. */
  const refused = (stored: AdaptiveCard | undefined, line: string, mentions: MentionFor): AdaptiveCard | undefined =>
    stored === undefined ? undefined : withReason(stored, line, mentions);

  /** The answer card, and the reason a refused tapper is told (undefined when the tap was accepted, or told elsewhere). */
  interface Answer {
    card: AdaptiveCard | undefined;
    refusal?: string;
  }

  const refusal = (stored: AdaptiveCard | undefined, line: string, mentions: MentionFor): Answer => ({ card: refused(stored, line, mentions), refusal: line });

  async function answer(inv: Invoke, stored: AdaptiveCard | undefined, reply: TapReply, mentions: MentionFor): Promise<Answer> {
    switch (reply.kind) {
      case 'mark':
        return { card: await markCard(inv, stored, reply.line, mentions) };
      case 'refuse':
        return refusal(stored, reply.text, mentions);
      case 'refuse-pr': {
        // The PR actions' own words, which may quote GitHub: never a mention.
        const message = noTokens(reply.message);
        if (reply.linkUrl === undefined) return refusal(stored, message, mentions);
        // The personal chat already has the words with the link (or cannot be opened): nothing more to tell.
        const sent = await sendLinkPrivately(inv, message, reply.linkUrl);
        return { card: refused(stored, `${message} ${sent ? LINK_SENT_TEXT : LINK_NOT_SENT_TEXT}`, mentions) };
      }
      case 'ask-owner':
        if (reply.ownerId !== undefined) await repostForOwner(inv, stored, reply.ownerId, mentions).catch(onError);
        return refusal(stored, askedOwnerText(TEAMS_FORMAT, reply.ownerId), mentions);
      case 'none':
        return { card: stored };
    }
  }

  /** What a tap did, and what its tapper is told privately if its answer card is never shown. */
  interface Handled {
    result: TeamsTapResult;
    notice?: string;
  }

  const handled = (outcome: TeamsTapOutcome, card: AdaptiveCard | undefined, notice?: string): Handled => ({
    result: { outcome, ...(card === undefined ? {} : { card }) },
    ...(notice === undefined ? {} : { notice }),
  });

  /** "You tapped Merge. The PR changed; look again.": a refusal read away from its card. */
  const noticeOf = (inv: Invoke, stored: AdaptiveCard | undefined, line: string): string => `You tapped ${TEAMS_FORMAT.bold(labelOf(inv, stored))}. ${line}`;

  /** A 3: a tap on the resolution question or the scope-change card, answered as Slack's signals answer it. */
  async function textSignalTap(inv: Invoke, stored: AdaptiveCard | undefined): Promise<Handled> {
    const textDeps = options.text;
    if (textDeps === undefined) return handled({ kind: 'ignored', reason: 'text-signal-card' }, stored);
    const resolution = RESOLUTION_VERBS.find((v) => v === inv.verb);
    const scope = SCOPE_VERBS.find((v) => v === inv.verb);
    const map = await options.getMap();
    const person = map.people.find((p) => p.teamsId === inv.userId);
    const actor: IncidentActor = {
      id: inv.userId,
      name: person?.handle ?? inv.userName ?? '',
      ...(person?.email === undefined ? {} : { email: person.email }),
      role: person?.role ?? 'unknown',
    };
    const answered = { incidentId: inv.incidentId, messageId: inv.data['messageId'] ?? '', actor, at: clock().toISOString() };
    const key = (await state.getIncident(inv.incidentId))?.jiraKey ?? 'the ticket';
    let outcome: TextSignalOutcome;
    if (resolution !== undefined) outcome = await answerResolution(textDeps, { ...answered, choice: resolution });
    else if (scope !== undefined) outcome = await answerScopeChange(textDeps, { ...answered, choice: scope });
    else return handled({ kind: 'ignored', reason: 'unknown-choice' }, stored);
    const tapped: TeamsTapOutcome = { kind: 'text-signal', incidentId: inv.incidentId, choice: inv.verb, outcome };
    const mentions = await mentionsFor(inv);
    if (!outcome.handled) {
      const line = textSignalRefusal(outcome.reason);
      return handled(tapped, refused(stored, line, mentions), noticeOf(inv, stored, line));
    }
    // The card loses its buttons for everyone: who answered, or what became of the ticket.
    const line =
      resolution === undefined
        ? `${TEAMS_FORMAT.who(inv.userId)} chose ${TEAMS_FORMAT.bold(labelOf(inv, stored))}.`
        : resolution === 'close'
          ? `Closed ${noTokens(key)}.`
          : `Keeping ${noTokens(key)} open.`;
    return handled(tapped, await markCard(inv, stored, line, mentions));
  }

  async function handle(inv: Invoke): Promise<Handled> {
    const stored = await storedCard(inv);
    const card = await cardFor(inv, stored);
    if (card === 'text-signal') return textSignalTap(inv, stored);
    if (card === 'answered') {
      // As Slack's not-pending tap: the tapper is told, nothing else happens.
      const shown = stored === undefined ? undefined : withReason(stored, NOT_PENDING_TEXT);
      return handled({ kind: 'ignored', reason: 'card-answered' }, shown, noticeOf(inv, stored, NOT_PENDING_TEXT));
    }
    // A PR button's data also names the PR and commit its card showed (#264).
    const pin = pinFromData(inv.data);
    const tap: ChatTap = {
      userId: inv.userId,
      incidentId: inv.incidentId,
      action: inv.verb,
      card,
      label: labelOf(inv, stored),
      ...(pin === undefined ? {} : { pin }),
      // A clarify card that names itself: its option is the answer, whatever it reads.
      ...(card === 'clarify' && inv.data['card'] === CLARIFY_DATA.card ? { cardDecides: true } : {}),
      ...(card === 'mid-flight'
        ? { midFlight: { runId: inv.data['runId'] ?? '', claimerId: inv.data['claimerId'] ?? '', choice: midFlightChoiceOf(inv.verb) } }
        : {}),
    };
    const result = await core.run(tap);
    const answered = await answer(inv, stored, result.reply, await mentionsFor(inv));
    return handled(result.outcome, answered.card, answered.refusal === undefined ? undefined : noticeOf(inv, stored, answered.refusal));
  }

  async function run(activity: unknown): Promise<Handled & { inv?: Invoke }> {
    const parsed = parseInvoke(activity);
    if (!parsed.ok) return handled({ kind: 'ignored', reason: parsed.reason }, undefined);
    return { ...(await handle(parsed.invoke)), inv: parsed.invoke };
  }

  return {
    handleInvoke: async (activity) => (await run(activity)).result,
    async onAction(activity, budget) {
      const { result, notice, inv } = await run(activity);
      // Past the transport's budget the invoke was answered without this card: a refusal goes to the tapper privately.
      if (budget?.expired() === true && notice !== undefined && inv !== undefined) await tellPrivately(inv, notice);
      onOutcome(result.outcome);
      return result.card;
    },
  };
}
