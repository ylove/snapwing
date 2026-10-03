// Escalation by weight of reactions (A 1.4, #290): the reaction ladder.
//
// Counting. The signal handler (signals/handler.ts, #288) records every counted signal as a `comment`
// event with `count { weight, windowEndsAt }`, frozen at record time: trigger and escalate anywhere,
// only inside the playbook's window from the anchor, weighted reporter, engineer, or owner of the
// surface. A ladder's score is the sum of those weights over its unique reactors: one person reacting
// five times is one, a removed reaction (`reaction-removed`) takes its person back out, and a person
// who reacted with two of the ladder's intents (a bug and a fire) counts once, at the larger weight.
// The default ladder counts `trigger` and `escalate` together, so "3 people are reporting this" means
// three people, whichever of the two reactions they used. The per-intent rows stay in
// `escalation_scores` (state/projections/escalation.ts).
//
// The ladder. Each playbook `<ladder>` whose intents include trigger or escalate (the default:
// `trigger escalate`, steps 3, 5, 8) is walked in score order; step n is reached when the score is at
// least its `score`. `evaluate(incidentId)` appends one `escalated` event per step reached for the
// first time (the step reached so far is the highest `escalated.step` for the ladder's intents), with
// the step's effects frozen in the payload:
//
//   priority     `+N` raises the incident's priority N steps (a priority not set yet counts as
//                Medium), `Highest` sets it; recorded only when strictly higher than the current one,
//                so priority only moves up automatically. A priority this module cannot order (a
//                human's custom one in Jira) is left alone. The `incidents` row takes it, and when
//                the incident has filed its own issue, the same transaction enqueues one Jira
//                `update-fields` row for `priority` (batch key `field:{incident}:priority`, so a
//                human's edit in Jira drops it, B 7.3). Before filing, the plan and the create
//                payload take it (`atLeastPriority`, engine/steps.ts).
//   note         "3 people are reporting this", posted to the incident's thread.
//   mentionOwner the same post mentions the owner (the Jira assignee, else the resolved owner).
//   suppressAskBack  the ask-back gate is suppressed from here on (`escalationState`, which the
//                engine's clarify step passes to the gate as `escalated`): it is an incident, not a
//                question. The user-side check is a question too, and is suppressed with it.
//   outage       treated as an outage: `monitoring-started { qualifiedBy: 'outage-score' }` in the same
//                append unless already monitored (A 4.5), and the playbook's escalation ladders are
//                re-evaluated (`ladders.evaluate`, monitor/ladder.ts), whose `outage` fact is
//                `outage(incident)` here (`<applyWhen outage="true">`).
//
// Several steps reached at once (reactions adopted when the incident is created, A 1.4 last
// paragraph: "five people reacted 🔥 before anyone reacted 🐛" lands as Highest) append every step in
// one append, one Jira row with the final priority, and one post. A later lower score (a reaction
// removed, the window over) never fires anything and never lowers a priority (A 1.6).
//
// The `escalated` event never changes the lifecycle status (ADR 0018); the playbook escalation
// ladders record `escalation-ladder`, never `escalated`. Only the trigger and escalate ladders run
// here: the `accept` ladder ("confirmed by multiple people") and the engineers' `reject` hold are not
// built yet.

import type { LadderStep, Playbook, PlaybookLadder, PriorityChange } from '../config/playbook.ts';
import type { EscalatedPayload, IncidentEvent, NewEvent } from '../contracts/events.ts';
import { isExpectedSeqConflict, type IncidentView, type OutboxItem } from '../contracts/state.ts';
import { isTerminalStatus } from '../lifecycle/machine.ts';
import type { JiraPriorityName } from '../map/types.ts';
import type { EscalationChat, EscalationLadders } from '../monitor/ladder.ts';
import type { StatePort } from '../ports/state.ts';
import { jiraFieldBatchKey } from '../state/projections/outbox/jira.ts';
import { ulid } from '../util/ulid.ts';

/** The intents the reaction ladder counts; `escalated.intent` is one of them. */
export type ReactionIntent = EscalatedPayload['intent'];

const REACTION_INTENTS: ReadonlySet<string> = new Set<ReactionIntent>(['trigger', 'escalate']);

/** `EscalationPost.ladder` of the reaction ladder's thread post. */
export const REACTION_LADDER = 'reactions';

/** Jira priorities, lowest first. */
export const PRIORITY_ORDER: readonly JiraPriorityName[] = Object.freeze(['Lowest', 'Low', 'Medium', 'High', 'Highest']);

/** What `+N` raises from when the incident has no priority yet (A 1.4: "Medium → High"). */
export const DEFAULT_BASE_PRIORITY: JiraPriorityName = 'Medium';

/** Re-reads per evaluation on `ExpectedSeqConflictError`. */
const MAX_APPEND_ATTEMPTS = 8;

// The math (pure) ---------------------------------------------------------------------------------

/** One reaction ladder: the playbook's, limited to the intents counted here. */
export interface ReactionLadder {
  intents: ReactionIntent[];
  /** In score order; step n is `steps[n - 1]`. */
  steps: LadderStep[];
}

/** The playbook's ladders that count trigger or escalate, each with its steps in score order. */
export function reactionLadders(playbook: Pick<Playbook, 'ladders'>): ReactionLadder[] {
  return playbook.ladders.flatMap((l: PlaybookLadder): ReactionLadder[] => {
    const intents = l.intents.filter((i): i is ReactionIntent => REACTION_INTENTS.has(i));
    if (intents.length === 0 || l.steps.length === 0) return [];
    return [{ intents, steps: [...l.steps].sort((a, b) => a.score - b.score) }];
  });
}

const round = (n: number): number => Math.round(n * 1e6) / 1e6;

/**
 * The unique reactors counted for `intents` and each one's weight: per intent, a person's first
 * counted signal adds them at its frozen weight and a removal takes them out; across intents a person
 * counts once, at the larger weight.
 */
export function countedReactors(events: readonly IncidentEvent[], intents: readonly string[]): Map<string, number> {
  const wanted = new Set(intents);
  const perIntent = new Map<string, Map<string, number>>();
  for (const e of events) {
    if (e.type !== 'comment' || e.payload.count === undefined || e.actor === undefined || !wanted.has(e.payload.intent)) continue;
    let reactors = perIntent.get(e.payload.intent);
    if (reactors === undefined) {
      reactors = new Map();
      perIntent.set(e.payload.intent, reactors);
    }
    if (e.payload.signalSource === 'reaction-removed') reactors.delete(e.actor.id);
    else if (!reactors.has(e.actor.id)) reactors.set(e.actor.id, e.payload.count.weight);
  }
  const union = new Map<string, number>();
  for (const reactors of perIntent.values()) {
    for (const [id, weight] of reactors) union.set(id, Math.max(union.get(id) ?? 0, weight));
  }
  return union;
}

/** A ladder's score: the weights of its unique reactors, summed (rounded to 1e-6 like the projection). */
export function ladderScore(events: readonly IncidentEvent[], intents: readonly string[]): { score: number; reactors: number } {
  const reactors = countedReactors(events, intents);
  let score = 0;
  for (const w of reactors.values()) score += w;
  return { score: round(score), reactors: reactors.size };
}

/** The highest step (1-based) whose `score` the score reaches; 0 for none. `steps` in score order. */
export function stepForScore(steps: readonly Pick<LadderStep, 'score'>[], score: number): number {
  let reached = 0;
  steps.forEach((s, i) => {
    if (score >= s.score) reached = i + 1;
  });
  return reached;
}

/** The highest step already recorded (`escalated`) for any of `intents`; 0 for none. */
export function stepReached(events: readonly IncidentEvent[], intents: readonly string[]): number {
  let step = 0;
  for (const e of events) if (e.type === 'escalated' && intents.includes(e.payload.intent)) step = Math.max(step, e.payload.step);
  return step;
}

function rank(priority: string): number | undefined {
  const i = PRIORITY_ORDER.findIndex((p) => p.toLowerCase() === priority.trim().toLowerCase());
  return i < 0 ? undefined : i;
}

/**
 * The priority `change` leads to from `current`, or undefined when that is not strictly higher (or
 * `current` is a priority with no known order, which only a human sets). `current` undefined counts
 * as `DEFAULT_BASE_PRIORITY`.
 */
export function raisedPriority(current: string | undefined, change: PriorityChange): JiraPriorityName | undefined {
  const from = rank(current ?? DEFAULT_BASE_PRIORITY);
  if (from === undefined) return undefined;
  const to = 'raise' in change ? Math.min(from + Math.max(0, Math.trunc(change.raise)), PRIORITY_ORDER.length - 1) : rank(change.set);
  return to !== undefined && to > from ? PRIORITY_ORDER[to] : undefined;
}

/** `priority`, or `floor` when the floor is a known priority above it. */
export function atLeastPriority<P extends JiraPriorityName>(priority: P, floor: string | undefined): P | JiraPriorityName {
  if (floor === undefined) return priority;
  const f = rank(floor);
  const p = rank(priority);
  return f !== undefined && p !== undefined && f > p ? (PRIORITY_ORDER[f] ?? priority) : priority;
}

/**
 * The `escalated` payloads the log now calls for, in order: every reaction-ladder step reached for
 * the first time. `incident.priority` is the current priority; each step's raise builds on the one
 * before it. Empty when nothing new is reached.
 */
export function planEscalation(events: readonly IncidentEvent[], incident: Pick<IncidentView, 'priority'>, playbook: Pick<Playbook, 'ladders'>): EscalatedPayload[] {
  const out: EscalatedPayload[] = [];
  let priority = incident.priority;
  for (const ladder of reactionLadders(playbook)) {
    const { score, reactors } = ladderScore(events, ladder.intents);
    const reached = stepForScore(ladder.steps, score);
    const before = stepReached(events, ladder.intents);
    if (reached <= before) continue;
    const intent = latestCountedIntent(events, ladder.intents);
    for (let n = before + 1; n <= reached; n++) {
      const step = ladder.steps[n - 1];
      if (step === undefined) continue;
      const raised = step.priority === undefined ? undefined : raisedPriority(priority, step.priority);
      if (raised !== undefined) priority = raised;
      out.push({
        intent,
        step: n,
        action: step.mentionOwner ? 'mention' : 'post',
        score,
        reactors,
        ...(raised === undefined ? {} : { priority: raised }),
        ...(step.note ? { note: true } : {}),
        ...(step.mentionOwner ? { mentionOwner: true } : {}),
        ...(step.suppressAskBack ? { suppressAskBack: true } : {}),
        ...(step.outage ? { outage: true } : {}),
      });
    }
  }
  return out;
}

/** The intent of the latest counted signal among `intents` (the one that crossed the step). */
function latestCountedIntent(events: readonly IncidentEvent[], intents: readonly ReactionIntent[]): ReactionIntent {
  for (let i = events.length - 1; i >= 0; i--) {
    const e = events[i];
    if (e?.type === 'comment' && e.payload.count !== undefined && e.payload.signalSource !== 'reaction-removed') {
      const intent = intents.find((x) => x === e.payload.intent);
      if (intent !== undefined) return intent;
    }
  }
  return intents[0] ?? 'trigger';
}

/** What the reaction ladder has done to an incident so far, read from its `escalated` events. */
export interface EscalationState {
  /** The highest step recorded on any reaction ladder. */
  step: number;
  /** The highest priority the ladder set; absent when it set none. */
  priority?: JiraPriorityName;
  /** A step suppressed the ask-back gate. */
  suppressAskBack: boolean;
  /** A step treated the incident as an outage. */
  outage: boolean;
}

export function escalationState(events: readonly IncidentEvent[]): EscalationState {
  const state: EscalationState = { step: 0, suppressAskBack: false, outage: false };
  let top = -1;
  for (const e of events) {
    if (e.type !== 'escalated') continue;
    state.step = Math.max(state.step, e.payload.step);
    if (e.payload.suppressAskBack === true) state.suppressAskBack = true;
    if (e.payload.outage === true) state.outage = true;
    top = Math.max(top, e.payload.priority === undefined ? -1 : (rank(e.payload.priority) ?? -1));
  }
  const priority = PRIORITY_ORDER[top];
  return priority === undefined ? state : { ...state, priority };
}

/** The thread post for the steps that fired: who is reporting, the new priority, the outage. */
export function escalationText(fired: readonly EscalatedPayload[]): string {
  const last = fired[fired.length - 1];
  const n = last?.reactors ?? 0;
  const parts = [`${String(n)} ${n === 1 ? 'person is' : 'people are'} reporting this.`];
  const priority = [...fired].reverse().find((p) => p.priority !== undefined)?.priority;
  if (priority !== undefined) parts.push(`Priority raised to ${priority}.`);
  if (fired.some((p) => p.outage === true)) parts.push('Treating it as an outage.');
  return parts.join(' ');
}

// The component -----------------------------------------------------------------------------------

export interface ReactionEscalationDeps {
  /** The install's workspace (single tenant), stamped on every event and row. */
  workspaceId: string;
  state: StatePort;
  /** The loaded playbook, or a getter for the current one (hot reload, #284). */
  playbook: Playbook | (() => Playbook | Promise<Playbook>);
  clock: () => Date;
  /** Posts the note and the owner mention to the incident's thread. Absent: nothing is posted. */
  chat?: EscalationChat;
  /** The playbook escalation ladders (monitor/ladder.ts), re-evaluated after a step fires. */
  ladders?: Pick<EscalationLadders, 'evaluate'>;
  /** Default `console.warn`. */
  log?: (message: string) => void;
}

export interface EscalationOutcome {
  /** The steps appended, in order; empty when nothing new was reached. */
  fired: EscalatedPayload[];
  /** The priority recorded, when a step raised it. */
  priority?: string;
  /** True when the steps were posted to the thread. */
  posted: boolean;
}

export interface ReactionEscalation {
  /** Appends the steps the incident's counted reactions now reach (see the file header). */
  evaluate(incidentId: string): Promise<EscalationOutcome>;
  /** The `outage` fact for `LadderDeps.outage` (monitor/ladder.ts). */
  outage(incident: Pick<IncidentView, 'id'>): Promise<boolean>;
}

export function createReactionEscalation(deps: ReactionEscalationDeps): ReactionEscalation {
  const log = deps.log ?? ((m: string) => console.warn(m));
  const playbookOf = async (): Promise<Playbook> => (typeof deps.playbook === 'function' ? deps.playbook() : deps.playbook);
  const none: EscalationOutcome = { fired: [], posted: false };

  async function evaluate(incidentId: string): Promise<EscalationOutcome> {
    const playbook = await playbookOf();
    for (let attempt = 1; ; attempt++) {
      const incident = await deps.state.getIncident(incidentId);
      if (incident === null || isTerminalStatus(incident.status)) return none;
      const events = await deps.state.read(incidentId);
      const lastSeq = events.at(-1)?.seq ?? 0;
      if (lastSeq !== incident.lastSeq) {
        if (attempt >= MAX_APPEND_ATTEMPTS) throw new Error(`reaction escalation: incident ${incidentId} kept moving`);
        continue;
      }
      const fired = planEscalation(events, incident, playbook);
      if (fired.length === 0) return none;

      const now = deps.clock();
      const at = now.toISOString();
      const event = <T extends 'escalated' | 'monitoring-started'>(type: T, payload: NewEvent<T>['payload']): NewEvent =>
        ({ workspaceId: deps.workspaceId, incidentId, type, v: 1, source: 'agent', occurredAt: at, payload }) as NewEvent;
      const appended: NewEvent[] = fired.map((p) => event('escalated', p));
      if (fired.some((p) => p.outage === true) && !incident.monitored) appended.push(event('monitoring-started', { qualifiedBy: 'outage-score' }));
      const priority = [...fired].reverse().find((p) => p.priority !== undefined)?.priority;
      const row = priority === undefined ? undefined : priorityRow(deps.workspaceId, incident, priority, now);

      try {
        await deps.state.transaction(async (tx) => {
          if (row !== undefined) await tx.enqueueOutbox(row);
          return tx.append(incidentId, appended, lastSeq);
        });
      } catch (err) {
        if (!isExpectedSeqConflict(err) || attempt >= MAX_APPEND_ATTEMPTS) throw err;
        continue;
      }

      const posted = await post(incident, events, fired);
      if (deps.ladders !== undefined) {
        try {
          await deps.ladders.evaluate(incidentId);
        } catch (err) {
          log(`reaction escalation: incident ${incidentId}: escalation ladders: ${message(err)}`);
        }
      }
      return { fired, ...(priority === undefined ? {} : { priority }), posted };
    }
  }

  /** Best effort: the steps are recorded already. */
  async function post(incident: IncidentView, events: readonly IncidentEvent[], fired: readonly EscalatedPayload[]): Promise<boolean> {
    if (deps.chat === undefined || !fired.some((p) => p.note === true || p.mentionOwner === true)) return false;
    const channel = incident.channelId;
    if (channel === undefined || channel === '') return false;
    let threadId: string | undefined = incident.anchorId;
    for (const e of events) if (e.type === 'captured' && e.payload.threadId !== undefined) threadId = e.payload.threadId;
    const owner = incident.assigneeId ?? incident.ownerRef;
    const last = fired[fired.length - 1];
    try {
      await deps.chat.post({
        incidentId: incident.id,
        ladder: REACTION_LADDER,
        step: last?.step ?? 0,
        where: threadId === undefined || threadId === '' ? { kind: 'thread', channel } : { kind: 'thread', channel, threadId },
        ...(fired.some((p) => p.mentionOwner === true) && owner !== undefined ? { mention: owner } : {}),
        text: escalationText(fired),
      });
      return true;
    } catch (err) {
      log(`reaction escalation: incident ${incident.id}: post failed: ${message(err)}`);
      return false;
    }
  }

  return {
    evaluate,
    outage: async (incident) => escalationState(await deps.state.read(incident.id)).outage,
  };
}

/** The Jira `update-fields` row for the new priority, when the incident filed its own issue. */
function priorityRow(workspaceId: string, incident: IncidentView, priority: string, now: Date): OutboxItem | undefined {
  if (incident.jiraKey === undefined || incident.status === 'linked-to-existing') return undefined;
  return {
    id: ulid(now.getTime()),
    workspaceId,
    target: 'jira',
    incidentId: incident.id,
    op: 'update-fields',
    payload: { issueKey: incident.jiraKey, fields: { priority: { name: priority } } },
    batchKey: jiraFieldBatchKey(incident.id, 'priority'),
    attempts: 0,
    nextAttempt: now.toISOString(),
    createdAt: now.toISOString(),
  };
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
