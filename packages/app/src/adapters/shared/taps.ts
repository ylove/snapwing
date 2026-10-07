// What a button tap does, on any chat platform (main 8.2, 11.2, 16; A 2.1, A 2.2; B 5 awaitInteractive).
// Slack (`adapters/slack/interactivity.ts`) and Teams (`adapters/teams/interactivity.ts`) parse their own
// payloads into a `ChatTap` and render the `TapReply` their own way (Slack: an edited message or an
// ephemeral; Teams: the invoke response card). Everything between is here, so both apply the same rules:
//
// - Card choices (scope, dedupe, clarify, the level 1 fix preview, and the claim card's `Let the agent
//   take it` and `Not a bug`, A 2.1) go to `orchestrator.handleTap` with the tapper resolved through the
//   workspace map by their chat user id (`slackId` or `teamsId`).
// - Authorization is `policy/authorize.ts` (main 16). A reporter tapping `Fix it` is answered with
//   `ask-owner`: the platform says "I've asked @owner to approve" and reposts the card mentioning the
//   owning engineer (main 8.2).
// - `stop` (any card or status message) and `dismiss` at levels 2 and 3 call `stopIncident`; `Not a bug`
//   there also appends `not-a-bug` and queues a Jira close to Done with resolution "Won't Do" (main 8.2),
//   through the outbox in the same transaction.
// - `merge`, `request_changes`, and `revert` go to the injected `PrActions`; merge and revert need a
//   linked GitHub identity for the tapper's chat account (ADR 0007), request changes needs an engineer.
// - The mid-flight claim card's `Let it finish` and `Stop it, I'll take over` (A 2.2) go to the injected
//   `midFlight` (`answerMidFlight`), which needs an engineer and the same run still going.

import type { EventActor, EventSource } from '@snapwing/pipeline/contracts/events.ts';
import type { ApprovalAction } from '@snapwing/pipeline/contracts/incident.ts';
import type { IncidentStatus, IncidentView, OutboxItem } from '@snapwing/pipeline/contracts/state.ts';
import { isExpectedSeqConflict } from '@snapwing/pipeline/contracts/state.ts';
import type { CardKind } from '@snapwing/pipeline/engine/cursor.ts';
import type { TapInput, TapOutcome } from '@snapwing/pipeline/engine/orchestrator.ts';
import type { MidFlightAnswer, MidFlightAnswerInput, MidFlightChoice } from '@snapwing/pipeline/fixer/claims.ts';
import type { StopInput, StopOutcome } from '@snapwing/pipeline/fixer/stop.ts';
import { PrActionRefusedError, type PrActionRefusal } from '@snapwing/pipeline/merge/actions.ts';
import type { AutonomyLevelId, MapPerson, WorkspaceMap } from '@snapwing/pipeline/map/types.ts';
import { authorize, type DenyReason } from '@snapwing/pipeline/policy/authorize.ts';
import type { StatePort } from '@snapwing/pipeline/ports/state.ts';
import { probableOwner } from '@snapwing/pipeline/resolve/lookup.ts';
import { JIRA_DONE, jiraFieldBatchKey } from '@snapwing/pipeline/state/projections/outbox/jira.ts';
import { ulid } from '@snapwing/pipeline/util/ulid.ts';

/** The Jira resolution a level 2 or 3 `Not a bug` closes with (main 8.2). */
export const JIRA_RESOLUTION_WONT_DO = "Won't Do";
const MAX_APPEND_ATTEMPTS = 8;

export type ChatPlatform = 'slack' | 'teams';

/** Statuses in which a fixer run or an agent PR is active, so Stop has something to stop at level 1. */
export const FIXER_ACTIVE: ReadonlySet<IncidentStatus> = new Set<IncidentStatus>([
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
  /** The tapper: the chat user id and the map role. */
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

export type InteractivityOutcome =
  | { kind: 'ignored'; reason: string }
  | { kind: 'tapped'; card: CardKind; choice: string; outcome: TapOutcome }
  | { kind: 'denied'; action: string; reason: DenyReason; askedOwner?: string }
  | { kind: 'stopped'; incidentId: string; outcome: StopOutcome; wontDo?: boolean }
  | { kind: 'pr-action'; action: 'merge' | 'request_changes' | 'revert'; incidentId: string }
  | { kind: 'pr-refused'; action: 'merge' | 'request_changes' | 'revert'; incidentId: string; reason: PrActionRefusal }
  | { kind: 'mid-flight'; incidentId: string; answer: MidFlightAnswer };

export const DENY_TEXT: Readonly<Record<DenyReason, string>> = {
  'engineer-required': 'Only an engineer on this surface can do that.',
  'linked-identity-required': 'Link your GitHub account to Snapwing first; this button acts as you on GitHub.',
  'agent-merges': 'At this level the agent merges once every gate passes.',
  'level-disallows': 'That is not available at this autonomy level.',
  'nothing-to-stop': 'Nothing is running for this incident yet.',
};

export const NOT_PENDING_TEXT = 'This card already has an answer.';
export const TERMINAL_TEXT = 'This incident is already closed.';

/** Why a mid-flight tap did nothing, for the tapper. */
export const MID_FLIGHT_REFUSED: Readonly<Record<Extract<MidFlightAnswer, { accepted: false }>['reason'], string>> = {
  'engineer-required': DENY_TEXT['engineer-required'],
  'run-finished': 'That fixer run has already finished.',
  'wrong-run': 'That fixer run has already finished; a newer one is going.',
};

/** The fix preview's level 1 buttons; anything else is left to handleTap to refuse. */
const FIX_PREVIEW_ACTIONS: ReadonlySet<string> = new Set<ApprovalAction>(['approve_fix', 'ticket_only', 'dismiss']);

/** The card a tap came from: a card kind, the status message, or the mid-flight card (A 2.2). */
export type TapCard = CardKind | 'status' | 'mid-flight';

/** A tap, as each platform's parser hands it over. */
export interface ChatTap {
  /** The tapper's chat user id (Slack user id, Teams AAD object id). */
  userId: string;
  incidentId: string;
  /** The button: Slack's `action_id`, Teams' `verb`. */
  action: string;
  card: TapCard;
  /** The button's text, for the "who chose what" line. */
  label: string;
  /** With card `mid-flight`: the offer the tap answers and the choice, if the action is one. */
  midFlight?: { runId: string; claimerId: string; choice: MidFlightChoice | undefined };
}

/** How a platform writes a mention and bold text in the lines below. */
export interface LineFormat {
  who(userId: string): string;
  bold(text: string): string;
}

/** What the tapper (and, for `mark`, everyone) is shown. */
export type TapReply =
  /** Accepted: the card's buttons give way to this line, naming who did what. */
  | { kind: 'mark'; line: string }
  /** Refused: tell the tapper why; the card keeps its buttons. */
  | { kind: 'refuse'; text: string }
  /** A PR action GitHub or the policy refused, in the PR actions' own words (escape it), maybe with a link. */
  | { kind: 'refuse-pr'; message: string; linkUrl?: string }
  /** main 8.2: a reporter asked for a fix; tell them the owner was asked, and repost the card mentioning them. */
  | { kind: 'ask-owner'; ownerId?: string }
  | { kind: 'none' };

export interface TapResult {
  outcome: InteractivityOutcome;
  reply: TapReply;
}

export interface TapCoreOptions {
  platform: ChatPlatform;
  state: StatePort;
  /** The install's workspace, stamped on the events this module appends. */
  workspaceId: string;
  orchestrator: { handleTap(tap: TapInput): Promise<TapOutcome> };
  /** `stopIncident` from `@snapwing/pipeline/fixer/stop.ts`, bound to its FixerDeps. */
  stopIncident: (input: StopInput) => Promise<StopOutcome>;
  prActions: PrActions;
  /** The mid-flight card's taps (`answerMidFlight`, A 2.2). Absent: those taps are ignored. */
  midFlight?: (input: MidFlightAnswerInput) => Promise<MidFlightAnswer>;
  /** The current workspace map; read per tap so a config change is picked up. */
  getMap: () => Promise<WorkspaceMap>;
  /** True when the chat user has a linked GitHub identity (ADR 0007). Default: nobody is linked. */
  githubLinked?: (chatUserId: string) => boolean | Promise<boolean>;
  clock?: () => Date;
  format: LineFormat;
}

export interface TapCore {
  run(tap: ChatTap): Promise<TapResult>;
}

/** The map person's id on `platform`. */
export function chatIdOf(person: MapPerson, platform: ChatPlatform): string | undefined {
  return platform === 'slack' ? person.slackId : person.teamsId;
}

/** The tapper as an event actor: their chat id and their map role (`unknown` outside the map). */
export function actorFor(map: WorkspaceMap, platform: ChatPlatform, chatUserId: string): EventActor {
  const person = map.people.find((p) => chatIdOf(p, platform) === chatUserId);
  return { id: chatUserId, role: person?.role ?? 'unknown' };
}

/** The engineer who approves a fix: the surface's probable owner, else an engineer who owns it, with an id on `platform`. */
export function approverFor(map: WorkspaceMap, platform: ChatPlatform, incident: IncidentView | null): MapPerson | undefined {
  if (incident?.surfaceId === undefined) return undefined;
  const surfaceId = incident.surfaceId;
  const owner = probableOwner(map, surfaceId, incident.componentId);
  if (owner?.role === 'engineer' && chatIdOf(owner, platform) !== undefined) return owner;
  return map.people.find((p) => p.role === 'engineer' && chatIdOf(p, platform) !== undefined && p.owns.some((o) => o.surface === surfaceId));
}

/** The level in force; an incident not planned yet is treated as level 1, as the orchestrator does. */
export function levelOf(incident: IncidentView | null): AutonomyLevelId {
  return incident?.autonomyLevel ?? 1;
}

/** "I've asked @owner to approve." */
export function askedOwnerText(format: LineFormat, ownerId: string | undefined): string {
  return ownerId === undefined ? "I've asked the owning engineer to approve." : `I've asked ${format.who(ownerId)} to approve.`;
}

/** The line a reposted fix preview leads with (main 8.2). */
export function askOwnerLead(format: LineFormat, ownerId: string, reporterId: string): string {
  return `${format.who(ownerId)}, ${format.who(reporterId)} asked for a fix. Tap ${format.bold('Fix it')} to approve.`;
}

const ignored = (reason: string): TapResult => ({ outcome: { kind: 'ignored', reason }, reply: { kind: 'none' } });
const refuse = (outcome: InteractivityOutcome, text: string): TapResult => ({ outcome, reply: { kind: 'refuse', text } });
const humanOf = (actor: EventActor, githubLinked: boolean) =>
  ({ kind: 'human', role: actor.role === 'human' ? 'unknown' : actor.role, githubLinked }) as const;

export function createTapCore(options: TapCoreOptions): TapCore {
  const { state, platform, format } = options;
  const source: EventSource = platform;
  const clock = options.clock ?? (() => new Date());
  const githubLinked = async (user: string): Promise<boolean> => (options.githubLinked === undefined ? false : await options.githubLinked(user));
  const mark = (outcome: InteractivityOutcome, line: string): TapResult => ({ outcome, reply: { kind: 'mark', line } });

  function askOwner(tap: ChatTap, map: WorkspaceMap, incident: IncidentView | null, reason: DenyReason): TapResult {
    const owner = approverFor(map, platform, incident);
    const ownerId = owner === undefined ? undefined : chatIdOf(owner, platform);
    return {
      outcome: { kind: 'denied', action: tap.action, reason, ...(ownerId === undefined ? {} : { askedOwner: ownerId }) },
      reply: { kind: 'ask-owner', ...(ownerId === undefined ? {} : { ownerId }) },
    };
  }

  async function cardTap(tap: ChatTap, card: CardKind, map: WorkspaceMap): Promise<TapResult> {
    const actor = actorFor(map, platform, tap.userId);
    let incident: IncidentView | null = null;
    if (card === 'fix-preview' && FIX_PREVIEW_ACTIONS.has(tap.action)) {
      // Authorize here as well as in handleTap, so the refusal can name the owner and repost the card.
      incident = await state.getIncident(tap.incidentId);
      const decision = authorize(tap.action as ApprovalAction, humanOf(actor, false), { level: levelOf(incident), fixerActive: false });
      if (!decision.allowed) {
        if (decision.askOwner === true) return askOwner(tap, map, incident, decision.reason);
        return refuse({ kind: 'denied', action: tap.action, reason: decision.reason }, DENY_TEXT[decision.reason]);
      }
    }
    const outcome = await options.orchestrator.handleTap({ eventId: tap.incidentId, card, choice: tap.action, actor });
    const tapped: InteractivityOutcome = { kind: 'tapped', card, choice: tap.action, outcome };
    if (outcome.accepted) return mark(tapped, `${format.who(tap.userId)} chose ${format.bold(tap.label)}.`);
    const reason = outcome.reason;
    if (outcome.askOwner === true && reason !== 'not-pending' && reason !== 'invalid-choice') {
      return askOwner(tap, map, incident ?? (await state.getIncident(tap.incidentId)), reason);
    }
    return refuse(tapped, reason === 'not-pending' || reason === 'invalid-choice' ? NOT_PENDING_TEXT : DENY_TEXT[reason]);
  }

  /** `stop` anywhere, or `dismiss` at levels 2 and 3 (a Stop plus a Won't Do close). */
  async function stopTap(tap: ChatTap, map: WorkspaceMap, wontDo: boolean): Promise<TapResult> {
    const actor = actorFor(map, platform, tap.userId);
    const incident = await state.getIncident(tap.incidentId);
    if (incident === null) return refuse({ kind: 'ignored', reason: 'unknown-incident' }, NOT_PENDING_TEXT);
    const action: ApprovalAction = wontDo ? 'dismiss' : 'stop';
    const decision = authorize(action, humanOf(actor, false), { level: levelOf(incident), fixerActive: FIXER_ACTIVE.has(incident.status) });
    if (!decision.allowed) return refuse({ kind: 'denied', action: tap.action, reason: decision.reason }, DENY_TEXT[decision.reason]);
    const outcome = await options.stopIncident({ incidentId: tap.incidentId, actor, source, ...(wontDo ? { reason: 'not a bug' } : {}) });
    const stopped: InteractivityOutcome = { kind: 'stopped', incidentId: tap.incidentId, outcome };
    if (outcome.stopped === false && outcome.reason !== 'already-stopped') {
      return refuse(stopped, outcome.reason === 'terminal' ? TERMINAL_TEXT : NOT_PENDING_TEXT);
    }
    if (wontDo) await closeWontDo(tap.incidentId, actor);
    const who = format.who(tap.userId);
    return mark(
      { ...stopped, ...(wontDo ? { wontDo: true } : {}) },
      wontDo ? `${who} marked this ${format.bold('Not a bug')}.` : `${who} stopped this.`,
    );
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
        source,
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

  async function prTap(tap: ChatTap, map: WorkspaceMap, action: 'merge' | 'request_changes' | 'revert'): Promise<TapResult> {
    const actor = actorFor(map, platform, tap.userId);
    const incident = await state.getIncident(tap.incidentId);
    if (incident === null) return refuse({ kind: 'ignored', reason: 'unknown-incident' }, NOT_PENDING_TEXT);
    const decision = authorize(action, humanOf(actor, await githubLinked(tap.userId)), {
      level: levelOf(incident),
      fixerActive: FIXER_ACTIVE.has(incident.status),
    });
    if (!decision.allowed) return refuse({ kind: 'denied', action, reason: decision.reason }, DENY_TEXT[decision.reason]);
    const input: PrActionInput = {
      incidentId: tap.incidentId,
      actor,
      ...(incident.prNumber === undefined ? {} : { prNumber: incident.prNumber }),
      ...(incident.repo === undefined ? {} : { repo: incident.repo }),
    };
    try {
      if (action === 'merge') await options.prActions.merge(input);
      else if (action === 'request_changes') await options.prActions.requestChanges(input);
      else await options.prActions.revert(input);
    } catch (e) {
      if (!(e instanceof PrActionRefusedError)) throw e;
      // Nothing was done: tell the tapper why, leave the card's buttons, never mark it (main 11.2).
      const { message, linkUrl, reason } = e.outcome;
      return {
        outcome: { kind: 'pr-refused', action, incidentId: tap.incidentId, reason },
        reply: { kind: 'refuse-pr', message, ...(linkUrl === undefined ? {} : { linkUrl }) },
      };
    }
    const verb = action === 'merge' ? 'merged this' : action === 'revert' ? 'reverted this' : 'requested changes';
    return mark({ kind: 'pr-action', action, incidentId: tap.incidentId }, `${format.who(tap.userId)} ${verb}.`);
  }

  /** A 2.2: the claimer (or another engineer) answers the mid-flight card. */
  async function midFlightTap(tap: ChatTap, offer: NonNullable<ChatTap['midFlight']>): Promise<TapResult> {
    const choice = offer.choice;
    if (choice === undefined || options.midFlight === undefined) return ignored('unknown-action');
    const actor = actorFor(await options.getMap(), platform, tap.userId);
    const answer = await options.midFlight({ incidentId: tap.incidentId, runId: offer.runId, claimerId: offer.claimerId, choice, actor });
    const outcome: InteractivityOutcome = { kind: 'mid-flight', incidentId: tap.incidentId, answer };
    if (!answer.accepted) return refuse(outcome, MID_FLIGHT_REFUSED[answer.reason]);
    if (answer.choice === 'stop-it' && !answer.stop.stopped && answer.stop.reason !== 'already-stopped') {
      return refuse(outcome, answer.stop.reason === 'terminal' ? TERMINAL_TEXT : NOT_PENDING_TEXT);
    }
    const who = format.who(tap.userId);
    return mark(
      outcome,
      answer.choice === 'let-it-finish'
        ? `${who} chose ${format.bold('Let it finish')}. The fixer keeps going.`
        : `${who} stopped the fixer. The branch stays for ${format.who(offer.claimerId)}, who has the ticket.`,
    );
  }

  return {
    async run(tap) {
      if (tap.midFlight !== undefined) return midFlightTap(tap, tap.midFlight);
      const map = await options.getMap();
      switch (tap.action) {
        case 'stop':
          return stopTap(tap, map, false);
        case 'merge':
        case 'request_changes':
        case 'revert':
          return prTap(tap, map, tap.action);
      }
      const card = tap.card;
      if (card === 'pr-ready' || card === 'status' || card === 'mid-flight') return ignored('unknown-action');
      if (card === 'fix-preview' && tap.action === 'dismiss') {
        // At levels 2 and 3 the fixer already started and no card is waiting (main 8.2).
        if (levelOf(await state.getIncident(tap.incidentId)) >= 2) return stopTap(tap, map, true);
      }
      return cardTap(tap, card, map);
    },
  };
}
