// Slack interactivity (main 8.2, 15.1, 16; B 5 awaitInteractive): what a button tap or a removed
// trigger reaction does. The transport (#147) hands every interactivity payload that is not the message
// shortcut to `onAction`, after the request was authenticated and answered.
//
// The rules a tap follows (card choices to `orchestrator.handleTap`, authorization, Stop and the Won't
// Do close, the PR buttons, the mid-flight card) are platform-neutral and live in `../shared/taps.ts`,
// which Teams applies too. This module parses `block_actions` into a tap (the card by the actions block's
// `block_id`; the mid-flight card's `midflight_actions:<runId>:<claimerId>`, cards/mid-flight.ts) and
// renders the reply the Slack way:
//
// - An accepted tap replaces the card's buttons with a line naming who chose what; a refused one gets an
//   ephemeral reply (from the App Home, a direct message).
// - A reporter tapping `Fix it` gets "I've asked @owner to approve" and the card is reposted in the
//   thread mentioning the owning engineer (main 8.2), recorded as `bot-message-posted { role:
//   'fix-preview' }` (A 1.3, #287; best effort).
// - `handleEvent` takes Events API bodies: a `reaction_removed` of the trigger emoji by one of its reactors
//   within 60 s of the trigger is a Stop for that trigger's incident (main 15.1). The transport never
//   hands events to anything but the adapter, so `observeReactionRemoval` wraps the adapter given to it.
//
// `handleAction` and `handleEvent` resolve to an `InteractivityOutcome` (tests); `onAction` and
// `onEvent` hand it to `onOutcome` (logs). None throws for a payload it does not understand.

import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { MidFlightAnswer, MidFlightAnswerInput } from '@snapwing/pipeline/fixer/claims.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import type { WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { recordBotMessage } from '@snapwing/pipeline/signals/messages.ts';
import {
  actorFor,
  askedOwnerText,
  askOwnerLead,
  createTapCore,
  type InteractivityOutcome,
  type LineFormat,
  type PrActions,
  type TapCard,
  type TapReply,
} from '../shared/taps.ts';
import type { SlackAdapter } from './adapter.ts';
import { parsedBodyOf, slackPayloadType } from './adapter.ts';
import { context, esc, mention, section } from './cards/blocks.ts';
import { midFlightChoiceOf, parseMidFlightBlock } from './cards/mid-flight.ts';
import type { SlackActionPayload } from './transport.ts';
import type { SlackWeb } from './web.ts';

export { JIRA_RESOLUTION_WONT_DO, type InteractivityOutcome, type PrActionInput, type PrActions } from '../shared/taps.ts';

/** How long after the trigger a removed reaction still counts as a Stop (main 15.1). */
export const TRIGGER_STOP_WINDOW_MS = 60_000;
/** Incidents scanned for the one a removed reaction triggered (newest first). */
const TRIGGER_SCAN_LIMIT = 200;
/** A trigger stamped slightly after the removal (Slack clocks) still matches. */
const CLOCK_SKEW_MS = 5_000;

/** The card each actions block belongs to, by the `block_id` the card builders (#129) give it. */
const BLOCK_CARDS: Readonly<Record<string, TapCard>> = {
  scope_actions: 'scope-preview',
  dedupe_actions: 'dedupe',
  clarify_actions: 'clarify',
  triage_actions: 'fix-preview',
  claim_actions: 'claimed',
  pr_actions: 'pr-ready',
  status_actions: 'status',
};

/** The shared tap lines in Slack mrkdwn. */
const SLACK_FORMAT: LineFormat = { who: mention, bold: (text) => `*${esc(text)}*` };

export interface SlackInteractivityOptions {
  web: Pick<SlackWeb, 'postMessage' | 'updateMessage' | 'postEphemeral'>;
  state: StatePort;
  /** The install's workspace, stamped on the events this module appends. */
  workspaceId: string;
  orchestrator: { handleTap(tap: TapInput): Promise<TapOutcome> };
  /** `stopIncident` from `@snapwing/pipeline/fixer/stop.ts`, bound to its FixerDeps. */
  stopIncident: (input: StopInput) => Promise<StopOutcome>;
  prActions: PrActions;
  /** The mid-flight card's taps (`answerMidFlight`, A 2.2). Absent: those taps are ignored. */
  midFlight?: (input: MidFlightAnswerInput) => Promise<MidFlightAnswer>;
  /** The current workspace map; read per payload so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** True when the Slack user has a linked GitHub identity (ADR 0007). Default: nobody is linked. */
  githubLinked?: (slackUserId: string) => boolean | Promise<boolean>;
  /** The bot's own user id; its reaction removals are ignored. */
  botUserId?: string;
  clock?: () => Date;
  /** Called with what each `onAction` or `onEvent` did (logs, metrics). */
  onOutcome?: (outcome: InteractivityOutcome) => void;
}

export interface SlackInteractivity {
  /** One interactivity payload; resolves to what it did. */
  handleAction(payload: SlackActionPayload): Promise<InteractivityOutcome>;
  /** An Events API body the adapter ignored; only `reaction_removed` does anything. */
  handleEvent(body: unknown): Promise<InteractivityOutcome>;
  /** The transport's `onAction`: `handleAction`, with the outcome passed to `onOutcome`. */
  onAction(payload: SlackActionPayload): Promise<void>;
  /** `handleEvent`, with the outcome passed to `onOutcome`. */
  onEvent(body: unknown): Promise<void>;
}

type Rec = Record<string, unknown>;

function rec(v: unknown): Rec {
  return typeof v === 'object' && v !== null && !Array.isArray(v) ? (v as Rec) : {};
}
function str(v: unknown): string {
  return typeof v === 'string' ? v : '';
}
const ignored = (reason: string): InteractivityOutcome => ({ kind: 'ignored', reason });
const stripTone = (name: string): string => name.replace(/::skin-tone-\d$/, '');

/** The parts of a `block_actions` payload this module reads. */
interface Tap {
  userId: string;
  incidentId: string;
  actionId: string;
  blockId: string;
  label: string;
  channel: string;
  /** The tap came from the App Home: no channel, no message to mark. */
  fromHome?: true;
  /** The card message, when the tap came from a message (not an ephemeral or a modal). */
  messageTs?: string;
  threadTs?: string;
  blocks: unknown[];
}

function parseTap(payload: SlackActionPayload): Tap | undefined {
  const action = rec((Array.isArray(payload['actions']) ? payload['actions'] : [])[0]);
  const container = rec(payload['container']);
  const message = rec(payload['message']);
  const userId = str(rec(payload['user'])['id']);
  // A tap in the App Home (#297) has no channel: replies go to the user's DM with the app.
  const fromHome = container['type'] === 'view' || rec(payload['view'])['type'] === 'home';
  const channel = str(container['channel_id']) || str(rec(payload['channel'])['id']) || (fromHome ? userId : '');
  const incidentId = str(action['value']);
  const actionId = str(action['action_id']);
  if (userId === '' || channel === '' || incidentId === '' || actionId === '') return undefined;
  const messageTs = str(container['message_ts']) || str(message['ts']);
  const threadTs = str(message['thread_ts']);
  return {
    userId,
    incidentId,
    actionId,
    blockId: str(action['block_id']),
    label: str(rec(action['text'])['text']) || actionId,
    channel,
    ...(fromHome ? { fromHome: true as const } : {}),
    ...(messageTs === '' || container['is_ephemeral'] === true ? {} : { messageTs }),
    ...(threadTs === '' ? {} : { threadTs }),
    blocks: Array.isArray(message['blocks']) ? (message['blocks'] as unknown[]) : [],
  };
}

export function createSlackInteractivity(options: SlackInteractivityOptions): SlackInteractivity {
  const { web, state } = options;
  const clock = options.clock ?? (() => new Date());
  const core = createTapCore({
    platform: 'slack',
    state,
    workspaceId: options.workspaceId,
    orchestrator: options.orchestrator,
    stopIncident: options.stopIncident,
    prActions: options.prActions,
    ...(options.midFlight === undefined ? {} : { midFlight: options.midFlight }),
    getMap: options.getMap,
    ...(options.githubLinked === undefined ? {} : { githubLinked: options.githubLinked }),
    clock,
    format: SLACK_FORMAT,
  });

  async function ephemeral(tap: Tap, text: string): Promise<void> {
    // The Home has no channel to whisper in: the reply is a direct message from the app.
    if (tap.fromHome === true) {
      await web.postMessage({ channel: tap.userId, text });
      return;
    }
    await web.postEphemeral({ channel: tap.channel, user: tap.userId, text, ...(tap.threadTs === undefined ? {} : { thread_ts: tap.threadTs }) });
  }

  /** Replaces the tapped actions block with a line saying who did what (main 8.2). */
  async function markCard(tap: Tap, line: string): Promise<void> {
    if (tap.messageTs === undefined || tap.blocks.length === 0) return;
    let replaced = false;
    const blocks = tap.blocks.map((b) => {
      const block = rec(b);
      if (block['type'] !== 'actions' || (tap.blockId !== '' && block['block_id'] !== tap.blockId)) return b;
      replaced = true;
      return context(line);
    });
    if (!replaced) blocks.push(context(line));
    await web.updateMessage({ channel: tap.channel, ts: tap.messageTs, text: line, blocks });
  }

  /** main 8.2: a reporter's `Fix it` asks the owner and reposts the card mentioning them. */
  async function askOwner(tap: Tap, ownerId: string | undefined): Promise<void> {
    await ephemeral(tap, askedOwnerText(SLACK_FORMAT, ownerId));
    if (ownerId === undefined || tap.blocks.length === 0) return;
    const posted = await web.postMessage({
      channel: tap.channel,
      text: `${mention(ownerId)}, ${mention(tap.userId)} asked for a fix`,
      blocks: [section(askOwnerLead(SLACK_FORMAT, ownerId, tap.userId)), ...tap.blocks],
      ...(tap.threadTs === undefined ? {} : { thread_ts: tap.threadTs }),
    });
    const ref = { platform: 'slack', channel: posted.channel, messageId: posted.ts, role: 'fix-preview' } as const;
    await recordBotMessage(state, tap.incidentId, ref, clock).catch(() => undefined);
  }

  async function render(tap: Tap, reply: TapReply): Promise<void> {
    switch (reply.kind) {
      case 'mark':
        return markCard(tap, reply.line);
      case 'refuse':
        return ephemeral(tap, reply.text);
      case 'refuse-pr':
        return ephemeral(tap, reply.linkUrl === undefined ? esc(reply.message) : `${esc(reply.message)}\n<${reply.linkUrl}|Link your GitHub account>`);
      case 'ask-owner':
        return askOwner(tap, reply.ownerId);
      case 'none':
        return;
    }
  }

  async function handleAction(payload: SlackActionPayload): Promise<InteractivityOutcome> {
    if (slackPayloadType(payload) !== 'block_actions') return ignored('not-block-actions');
    const tap = parseTap(payload);
    if (tap === undefined) return ignored('malformed');
    const base = { userId: tap.userId, incidentId: tap.incidentId, action: tap.actionId, label: tap.label };
    const offer = parseMidFlightBlock(tap.blockId);
    if (offer !== undefined) {
      const result = await core.run({ ...base, card: 'mid-flight', midFlight: { ...offer, choice: midFlightChoiceOf(tap.actionId) } });
      await render(tap, result.reply);
      return result.outcome;
    }
    // The Home view gives each item's actions block `<card block id>:<incident id>` (block ids are unique per view).
    const card = BLOCK_CARDS[tap.blockId.split(':')[0] ?? ''];
    if (card === undefined) return ignored('unknown-block');
    if (tap.actionId === 'open_pr') return ignored('link-button');
    // The clarify card's options are free text, so one that reads like a routed verb (`stop`, `merge`) is still its answer.
    const result = await core.run({ ...base, card, ...(card === 'clarify' && tap.blockId.split(':')[0] === 'clarify_actions' ? { cardDecides: true } : {}) });
    await render(tap, result.reply);
    return result.outcome;
  }

  /** main 15.1: removing the trigger reaction within 60 s of the trigger stops that trigger. */
  async function handleEvent(body: unknown): Promise<InteractivityOutcome> {
    const outer = rec(body);
    if (outer['type'] !== 'event_callback') return ignored('not-an-event');
    const event = rec(outer['event']);
    if (event['type'] !== 'reaction_removed') return ignored('not-reaction-removed');
    const user = str(event['user']);
    const item = rec(event['item']);
    const channel = str(item['channel']);
    const ts = str(item['ts']);
    if (user === '' || channel === '' || ts === '' || item['type'] !== 'message') return ignored('not-a-message-reaction');
    if (options.botUserId !== undefined && user === options.botUserId) return ignored('own-reaction');
    const removedAt = Math.round(Number(str(event['event_ts']) || '0') * 1000) || clock().getTime();
    const key = `slack-${channel}-${ts}-${stripTone(str(event['reaction']))}`;

    // Only incidents opened inside the window can match, so a late removal finds nothing to stop.
    const candidates = await state.findIncidents({ limit: TRIGGER_SCAN_LIMIT });
    for (const incident of candidates) {
      if (incident.source !== 'slack' || incident.channelId !== channel) continue;
      const sinceTrigger = removedAt - Date.parse(incident.openedAt);
      if (sinceTrigger < -CLOCK_SKEW_MS || sinceTrigger > TRIGGER_STOP_WINDOW_MS) continue;
      const captured = (await state.read(incident.id)).find((e) => e.type === 'captured');
      if (captured?.type !== 'captured' || captured.payload.idempotencyKey !== key) continue;
      const reactors = rec(captured.payload.rawPayloadSnapshot)['reactors'];
      const triggeredBy = new Set<string>([captured.payload.reporter.id, ...(Array.isArray(reactors) ? reactors.filter((r): r is string => typeof r === 'string') : [])]);
      if (!triggeredBy.has(user)) return ignored('not-a-trigger-reactor');
      const actor = actorFor(await options.getMap(), 'slack', user);
      const outcome = await options.stopIncident({ incidentId: incident.id, actor, source: 'slack', reason: 'trigger reaction removed' });
      return { kind: 'stopped', incidentId: incident.id, outcome };
    }
    return ignored('no-trigger-in-window');
  }

  const onOutcome = options.onOutcome ?? (() => undefined);
  return {
    handleAction,
    handleEvent,
    onAction: async (payload) => onOutcome(await handleAction(payload)),
    onEvent: async (body) => onOutcome(await handleEvent(body)),
  };
}

/**
 * The adapter for `createSlackTransport`, with Events API bodies the adapter ignores (a removed
 * reaction among them) also handed to `interactivity.onEvent`. The transport calls `normalizeResult`
 * once per request after authenticating it, so each ignored event is seen once. Not awaited, like
 * `onAction`; failures go to `onError`.
 */
export function observeReactionRemoval(
  adapter: SlackAdapter,
  interactivity: { onEvent(body: unknown): Promise<unknown> },
  onError: (error: unknown) => void = () => undefined,
): SlackAdapter {
  return {
    ...adapter,
    async normalizeResult(raw) {
      const result = await adapter.normalizeResult(raw);
      if (result.kind === 'ignored') {
        const body = parsedBodyOf(raw);
        if (rec(rec(body)['event'])['type'] === 'reaction_removed') void interactivity.onEvent(body).catch(onError);
      }
      return result;
    },
  };
}
