// Slack interactivity (main 8.2, 15.1, 16; B 5 awaitInteractive): what a button tap or a removed
// trigger reaction does. The transport (#147) hands every interactivity payload that is not the message
// shortcut to `onAction`, after the request was authenticated and answered.
//
// - Card choices (scope, dedupe, clarify, and the level 1 fix preview) go to `orchestrator.handleTap`
//   with the tapper resolved through the workspace map. An accepted tap replaces the card's buttons
//   with a line naming who chose what; a refused one gets an ephemeral reply.
// - Authorization is `policy/authorize.ts` (main 16). A reporter tapping `Fix it` gets "I've asked
//   @owner to approve" and the card is reposted in the thread mentioning the owning engineer (main 8.2).
// - `stop` (any card or status message) and `dismiss` at levels 2 and 3 call `stopIncident`; `Not a
//   bug` there also appends `not-a-bug` and queues a Jira close to Done with resolution "Won't Do"
//   (main 8.2), through the outbox in the same transaction.
// - `merge`, `request_changes`, and `revert` go to an injected `PrActions`; merge and revert need a
//   linked GitHub identity (ADR 0007), request changes needs an engineer.
// - `handleEvent` takes Events API bodies: a `reaction_removed` of the trigger emoji by one of its reactors
//   within 60 s of the trigger is a Stop for that trigger's incident (main 15.1). The transport never
//   hands events to anything but the adapter, so `observeReactionRemoval` wraps the adapter given to it.
//
// `handleAction` and `handleEvent` resolve to an `InteractivityOutcome` (tests); `onAction` and
// `onEvent` hand it to `onOutcome` (logs). None throws for a payload it does not understand.

import type { EventActor } from '@snapwing/pipeline/contracts/events.ts';
import type { ApprovalAction } from '@snapwing/pipeline/contracts/incident.ts';
import type { IncidentStatus, IncidentView, OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import { isExpectedSeqConflict } from '@snapwing/pipeline/contracts/state.ts';
import type { CardKind } from '@snapwing/pipeline/engine/cursor.ts';
import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import type { AutonomyLevelId, MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { authorize, type DenyReason } from '@snapwing/pipeline/policy/authorize.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { probableOwner } from '@snapwing/pipeline/resolve/lookup.ts';
import { JIRA_DONE, jiraFieldBatchKey } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';
import type { SlackAdapter } from './adapter.ts';
import { parsedBodyOf, slackPayloadType } from './adapter.ts';
import { context, esc, mention, section } from './cards/blocks.ts';
import type { SlackActionPayload } from './transport.ts';
import type { SlackWeb } from './web.ts';

/** How long after the trigger a removed reaction still counts as a Stop (main 15.1). */
export const TRIGGER_STOP_WINDOW_MS = 60_000;
/** The Jira resolution a level 2 or 3 `Not a bug` closes with (main 8.2). */
export const JIRA_RESOLUTION_WONT_DO = "Won't Do";
/** Incidents scanned for the one a removed reaction triggered (newest first). */
const TRIGGER_SCAN_LIMIT = 200;
const MAX_APPEND_ATTEMPTS = 8;
/** A trigger stamped slightly after the removal (Slack clocks) still matches. */
const CLOCK_SKEW_MS = 5_000;

/** The card each actions block belongs to, by the `block_id` the card builders (#129) give it. */
const BLOCK_CARDS: Readonly<Record<string, CardKind | 'status'>> = {
  scope_actions: 'scope-preview',
  dedupe_actions: 'dedupe',
  clarify_actions: 'clarify',
  triage_actions: 'fix-preview',
  pr_actions: 'pr-ready',
  status_actions: 'status',
};

/** Statuses in which a fixer run or an agent PR is active, so Stop has something to stop at level 1. */
const FIXER_ACTIVE: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
  'fixing',
  'fixing-retry',
  'in-review',
  'in-review-retry',
  'ci',
  'ci-retry',
  'mergeable',
  'held',
]);

/** A PR button tap, after authorization. The implementation acts as the linked human, never the bot. */
export interface PrActionInput {
  incidentId: string;
  /** The tapper: the Slack user id and the map role. */
  actor: EventActor;
  /** The incident's PR, when the incidents row knows it. */
  prNumber?: number;
  repo?: string;
}

/** The GitHub side of the PR buttons (main 11.2, 11.3); implemented over the GitHub client (#145). */
export interface PrActions {
  merge(input: PrActionInput): Promise<void>;
  requestChanges(input: PrActionInput): Promise<void>;
  revert(input: PrActionInput): Promise<void>;
}

export interface SlackInteractivityOptions {
  web: Pick<SlackWeb, 'postMessage' | 'updateMessage' | 'postEphemeral'>;
  state: StatePort;
  /** The install's workspace, stamped on the events this module appends. */
  workspaceId: string;
  orchestrator: { handleTap(tap: TapInput): Promise<TapOutcome> };
  /** `stopIncident` from `@snapwing/pipeline/fixer/stop.ts`, bound to its FixerDeps. */
  stopIncident: (input: StopInput) => Promise<StopOutcome>;
  prActions: PrActions;
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

export type InteractivityOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'tapped'; card: CardKind; choice: string; outcome: TapOutcome }
  | { kind: 'denied'; action: string; reason: DenyReason; askedOwner?: string }
  | { kind: 'stopped'; incidentId: string; outcome: StopOutcome; wontDo?: boolean }
  | { kind: 'pr-action'; action: 'merge' | 'request_changes' | 'revert'; incidentId: string };

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
  const channel = str(container['channel_id']) || str(rec(payload['channel'])['id']);
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
    ...(messageTs === '' || container['is_ephemeral'] === true ? {} : { messageTs }),
    ...(threadTs === '' ? {} : { threadTs }),
    blocks: Array.isArray(message['blocks']) ? (message['blocks'] as unknown[]) : [],
  };
}

function actorFor(map: WorkspaceMap, slackUserId: string): EventActor {
  const person = map.people.find((p) => p.slackId === slackUserId);
  return { id: slackUserId, role: person?.role ?? 'unknown' };
}

/** The engineer who approves a fix: the surface's probable owner, else an engineer who owns it. */
function approverFor(map: WorkspaceMap, incident: IncidentView | null): MapPerson | undefined {
  if (incident?.surfaceId === undefined) return undefined;
  const surfaceId = incident.surfaceId;
  const owner = probableOwner(map, surfaceId, incident.componentId);
  if (owner?.role === 'engineer' && owner.slackId !== undefined) return owner;
  return map.people.find((p) => p.role === 'engineer' && p.slackId !== undefined && p.owns.some((o) => o.surface === surfaceId));
}

const DENY_TEXT: Readonly<Record<DenyReason, string>> = {
  'engineer-required': 'Only an engineer on this surface can do that.',
  'linked-identity-required': 'Link your GitHub account to Snapwing first; this button acts as you on GitHub.',
  'agent-merges': 'At this level the agent merges once every gate passes.',
  'level-disallows': 'That is not available at this autonomy level.',
  'nothing-to-stop': 'Nothing is running for this incident yet.',
};

/** The level in force; an incident not planned yet is treated as level 1, as the orchestrator does. */
function levelOf(incident: IncidentView | null): AutonomyLevelId {
  return incident?.autonomyLevel ?? 1;
}

/** The fix preview's level 1 buttons; anything else is left to handleTap to refuse. */
const FIX_PREVIEW_ACTIONS: ReadonlySet<string> = new Set<ApprovalAction>(['approve_fix', 'ticket_only', 'dismiss']);

const NOT_PENDING_TEXT = 'This card already has an answer.';

export function createSlackInteractivity(options: SlackInteractivityOptions): SlackInteractivity {
  const { web, state } = options;
  const clock = options.clock ?? (() => new Date());
  const githubLinked = async (user: string): Promise<boolean> => (options.githubLinked === undefined ? false : await options.githubLinked(user));

  async function ephemeral(tap: Tap, text: string): Promise<void> {
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
  async function askOwner(tap: Tap, map: WorkspaceMap, incident: IncidentView | null, reason: DenyReason): Promise<InteractivityOutcome> {
    const owner = approverFor(map, incident);
    const ownerId = owner?.slackId;
    await ephemeral(tap, ownerId === undefined ? "I've asked the owning engineer to approve." : `I've asked ${mention(ownerId)} to approve.`);
    if (ownerId !== undefined && tap.blocks.length > 0) {
      const lead = section(`${mention(ownerId)}, ${mention(tap.userId)} asked for a fix. Tap *Fix it* to approve.`);
      await web.postMessage({
        channel: tap.channel,
        text: `${mention(ownerId)}, ${mention(tap.userId)} asked for a fix`,
        blocks: [lead, ...tap.blocks],
        ...(tap.threadTs === undefined ? {} : { thread_ts: tap.threadTs }),
      });
    }
    return { kind: 'denied', action: tap.actionId, reason, ...(ownerId === undefined ? {} : { askedOwner: ownerId }) };
  }

  async function cardTap(tap: Tap, card: CardKind, map: WorkspaceMap): Promise<InteractivityOutcome> {
    const actor = actorFor(map, tap.userId);
    let incident: IncidentView | null = null;
    if (card === 'fix-preview' && FIX_PREVIEW_ACTIONS.has(tap.actionId)) {
      // Authorize here as well as in handleTap, so the refusal can name the owner and repost the card.
      incident = await state.getIncident(tap.incidentId);
      const level = levelOf(incident);
      const decision = authorize(
        tap.actionId as ApprovalAction,
        { kind: 'human', role: actor.role === 'human' ? 'unknown' : actor.role, githubLinked: false },
        { level, fixerActive: false },
      );
      if (!decision.allowed) {
        if (decision.askOwner === true) return askOwner(tap, map, incident, decision.reason);
        await ephemeral(tap, DENY_TEXT[decision.reason]);
        return { kind: 'denied', action: tap.actionId, reason: decision.reason };
      }
    }
    const outcome = await options.orchestrator.handleTap({ eventId: tap.incidentId, card, choice: tap.actionId, actor });
    if (outcome.accepted) {
      await markCard(tap, `${mention(tap.userId)} chose *${esc(tap.label)}*.`);
    } else if (outcome.askOwner === true && outcome.reason !== 'not-pending' && outcome.reason !== 'invalid-choice') {
      return askOwner(tap, map, incident ?? (await state.getIncident(tap.incidentId)), outcome.reason);
    } else {
      const reason = outcome.reason;
      await ephemeral(tap, reason === 'not-pending' || reason === 'invalid-choice' ? NOT_PENDING_TEXT : DENY_TEXT[reason]);
    }
    return { kind: 'tapped', card, choice: tap.actionId, outcome };
  }

  /** `stop` anywhere, or `dismiss` at levels 2 and 3 (a Stop plus a Won't Do close). */
  async function stopTap(tap: Tap, map: WorkspaceMap, wontDo: boolean): Promise<InteractivityOutcome> {
    const actor = actorFor(map, tap.userId);
    const incident = await state.getIncident(tap.incidentId);
    if (incident === null) {
      await ephemeral(tap, NOT_PENDING_TEXT);
      return ignored('unknown-incident');
    }
    const level = levelOf(incident);
    const action: ApprovalAction = wontDo ? 'dismiss' : 'stop';
    const decision = authorize(
      action,
      { kind: 'human', role: actor.role === 'human' ? 'unknown' : actor.role, githubLinked: false },
      { level, fixerActive: FIXER_ACTIVE.has(incident.status) },
    );
    if (!decision.allowed) {
      await ephemeral(tap, DENY_TEXT[decision.reason]);
      return { kind: 'denied', action: tap.actionId, reason: decision.reason };
    }
    const outcome = await options.stopIncident({
      incidentId: tap.incidentId,
      actor,
      source: 'slack',
      ...(wontDo ? { reason: 'not a bug' } : {}),
    });
    if (outcome.stopped === false && outcome.reason !== 'already-stopped') {
      await ephemeral(tap, outcome.reason === 'terminal' ? 'This incident is already closed.' : NOT_PENDING_TEXT);
      return { kind: 'stopped', incidentId: tap.incidentId, outcome };
    }
    if (wontDo) await closeWontDo(tap.incidentId, actor);
    await markCard(tap, wontDo ? `${mention(tap.userId)} marked this *Not a bug*.` : `${mention(tap.userId)} stopped this.`);
    return { kind: 'stopped', incidentId: tap.incidentId, outcome, ...(wontDo ? { wontDo: true } : {}) };
  }

  /** Appends `not-a-bug` and, for a filed incident, queues the close to Done with resolution Won't Do. */
  async function closeWontDo(incidentId: string, actor: EventActor): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const incident = await state.getIncident(incidentId);
      if (incident === null || incident.status === 'not-a-bug' || incident.status === 'closed') return;
      const now = clock();
      const at = now.toISOString();
      const event = {
        workspaceId: options.workspaceId,
        incidentId,
        type: 'not-a-bug' as const,
        v: 1,
        source: 'slack' as const,
        actor,
        occurredAt: at,
        payload: { reason: `dismissed after the fixer started by ${actor.id}` },
      };
      const jiraKey = incident.jiraKey;
      try {
        await state.transaction(async (tx) => {
          if (jiraKey !== undefined) {
            const row: OutboxItem = {
              id: ulid(now.getTime()),
              workspaceId: options.workspaceId,
              target: 'jira',
              incidentId,
              op: 'transition',
              payload: { issueKey: jiraKey, to: JIRA_DONE, resolution: JIRA_RESOLUTION_WONT_DO },
              batchKey: jiraFieldBatchKey(incidentId, 'status'),
              attempts: 0,
              nextAttempt: at,
              createdAt: at,
            };
            await tx.enqueueOutbox(row);
          }
          return tx.append(incidentId, [event], incident.lastSeq);
        });
        return;
      } catch (e) {
        if (!isExpectedSeqConflict(e) || attempt >= MAX_APPEND_ATTEMPTS) throw e;
      }
    }
  }

  async function prTap(tap: Tap, map: WorkspaceMap, action: 'merge' | 'request_changes' | 'revert'): Promise<InteractivityOutcome> {
    const actor = actorFor(map, tap.userId);
    const incident = await state.getIncident(tap.incidentId);
    if (incident === null) {
      await ephemeral(tap, NOT_PENDING_TEXT);
      return ignored('unknown-incident');
    }
    const level = levelOf(incident);
    const decision = authorize(
      action,
      { kind: 'human', role: actor.role === 'human' ? 'unknown' : actor.role, githubLinked: await githubLinked(tap.userId) },
      { level, fixerActive: FIXER_ACTIVE.has(incident.status) },
    );
    if (!decision.allowed) {
      await ephemeral(tap, DENY_TEXT[decision.reason]);
      return { kind: 'denied', action, reason: decision.reason };
    }
    const input: PrActionInput = {
      incidentId: tap.incidentId,
      actor,
      ...(incident.prNumber === undefined ? {} : { prNumber: incident.prNumber }),
      ...(incident.repo === undefined ? {} : { repo: incident.repo }),
    };
    if (action === 'merge') await options.prActions.merge(input);
    else if (action === 'request_changes') await options.prActions.requestChanges(input);
    else await options.prActions.revert(input);
    const verb = action === 'merge' ? 'merged this' : action === 'revert' ? 'reverted this' : 'requested changes';
    await markCard(tap, `${mention(tap.userId)} ${verb}.`);
    return { kind: 'pr-action', action, incidentId: tap.incidentId };
  }

  async function handleAction(payload: SlackActionPayload): Promise<InteractivityOutcome> {
    if (slackPayloadType(payload) !== 'block_actions') return ignored('not-block-actions');
    const tap = parseTap(payload);
    if (tap === undefined) return ignored('malformed');
    const card = BLOCK_CARDS[tap.blockId];
    if (card === undefined) return ignored('unknown-block');
    if (tap.actionId === 'open_pr') return ignored('link-button');
    const map = await options.getMap();

    switch (tap.actionId) {
      case 'stop':
        return stopTap(tap, map, false);
      case 'merge':
      case 'request_changes':
      case 'revert':
        return prTap(tap, map, tap.actionId);
    }
    if (card === 'pr-ready' || card === 'status') return ignored('unknown-action');
    if (card === 'fix-preview' && tap.actionId === 'dismiss') {
      // At levels 2 and 3 the fixer already started and no card is waiting (main 8.2).
      const level = levelOf(await state.getIncident(tap.incidentId));
      if (level >= 2) return stopTap(tap, map, true);
    }
    return cardTap(tap, card, map);
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
      const actor = actorFor(await options.getMap(), user);
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
