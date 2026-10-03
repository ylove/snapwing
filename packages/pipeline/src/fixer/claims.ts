// src/fixer/claims.ts: claims arriving mid-flight (A 2.2).
//
// An engineer's `claimed` that lands after the fixer started does not abort it. `handleMidFlightClaim`
// (the appender calls it after the claim commits, as it calls the engine's `handleClaim`) posts a card
// with the run's age and branch and two choices, and schedules `timer.mid-flight` for
// `claims.midFlightGrace` (default PT10M):
//
//   Let it finish             nothing changes; the pending timer is cancelled.
//   Stop it, I'll take over   `stopIncident` (main 10.4: the branch stays, an open PR is closed with a
//                             comment) and the claimer is assigned.
//   no answer in the grace    `Let it finish` is applied and the claimer is told so.
//
// A claim before the first `fixer-started` is A 2.1 (engine/claims.ts) and a reporter's claim holds
// nothing, so neither offers a card here. Only an engineer may answer. No new event types: the offer is
// the timer plus the log (the claim, the run), and every step is safe to repeat. A late `Stop it` still
// works while the same run is going; once it finished or stopped the answer is `run-finished`.
//
// The chat card, the notice, and the Jira assignee write are injected (`MidFlightPorts`): the pipeline
// package never imports a chat SDK, and Jira has no assignee row in the outbox yet, so `compose.ts`
// wires `assign` to whatever writes it.

import type { EventActor, IncidentEvent } from '../contracts/events.ts';
import { keySegment } from '../contracts/jobs.ts';
import { parseDuration } from '../util/duration.ts';
import { activeRun, latest, type FixerDeps } from './job.ts';
import { isEngineerClaim } from '../engine/claims.ts';
import { stopIncident, type StopOutcome } from './stop.ts';

export const DEFAULT_MID_FLIGHT_GRACE = 'PT10M';

export type MidFlightChoice = 'let-it-finish' | 'stop-it';

/** What the chat adapter renders: "@dana, the fixer started on this 4 minutes ago and is on `fix/WEB-1042`." */
export interface MidFlightCard {
  kind: 'mid-flight';
  issueKey?: string;
  /** Chat user id of the claimer, whom the card addresses. */
  claimerUserId: string;
  runId: string;
  /** How long the fixer has been running, in milliseconds. */
  runAgeMs: number;
  /** The run's branch, once its `branched` checkpoint named one. */
  branch?: string;
  /** The buttons, in order. */
  choices: readonly MidFlightChoice[];
  /** The grace in force, ISO 8601: silence for this long means `let-it-finish`. */
  grace: string;
}

export interface MidFlightPorts {
  /** Posts the card in the incident's thread. */
  postCard(incidentId: string, card: MidFlightCard): Promise<void>;
  /** Says something in the thread (the timeout default is applied). */
  notify(incidentId: string, text: string): Promise<void>;
  /** Assigns the claimer on the ticket (A 2.2: stopping hands the work over). */
  assign(incidentId: string, claimerId: string): Promise<void>;
}

export interface MidFlightDeps extends FixerDeps {
  ports: MidFlightPorts;
  /** `claims.midFlightGrace`; default PT10M. */
  midFlightGrace?: string;
}

/** `timer.mid-flight` job data. */
export interface MidFlightTimerData {
  incidentId: string;
  runId: string;
  claimerId: string;
}

export function isMidFlightTimerData(v: unknown): v is MidFlightTimerData {
  if (typeof v !== 'object' || v === null) return false;
  const d = v as Record<string, unknown>;
  return [d['incidentId'], d['runId'], d['claimerId']].every((x) => typeof x === 'string' && x !== '');
}

/** Singleton key of the grace timer: one per incident, run, and claimer. */
export function midFlightKey(incidentId: string, runId: string, claimerId: string): string {
  return ['mid-flight', incidentId, runId, claimerId].map(keySegment).join(':');
}

export type MidFlightOffer =
  | { offered: true; card: MidFlightCard }
  | { offered: false; reason: 'not-an-engineer-claim' | 'no-run' | 'claim-before-run' | 'already-offered' };

export type MidFlightAnswer =
  | { accepted: true; choice: 'let-it-finish' }
  | { accepted: true; choice: 'stop-it'; stop: StopOutcome }
  | { accepted: false; reason: 'engineer-required' | 'run-finished' | 'wrong-run' };

/** Registers the `timer.mid-flight` handler. */
export function registerMidFlightJobs(deps: MidFlightDeps): void {
  deps.workflow.work('timer.mid-flight', async (job) => {
    if (!isMidFlightTimerData(job.data)) throw new Error('timer.mid-flight: malformed job data');
    await midFlightGraceExpired(deps, job.data);
  });
}

/**
 * The claim at `claimSeq` arrived: offers the choice when it is an engineer's and a fixer run was
 * already going when it landed.
 */
export async function handleMidFlightClaim(deps: MidFlightDeps, incidentId: string, claimSeq: number): Promise<MidFlightOffer> {
  const log = await deps.state.read(incidentId);
  const claim = log.find((e) => e.seq === claimSeq);
  if (claim === undefined || !isEngineerClaim(claim)) return { offered: false, reason: 'not-an-engineer-claim' };
  const run = activeRun(log);
  if (run === undefined) return { offered: false, reason: 'no-run' };
  if (claim.seq < run.seq) return { offered: false, reason: 'claim-before-run' };
  const claimerId = claim.payload.claimerId;
  // The same engineer claiming again during this run is one offer, not a second card.
  if (log.some((e) => e.seq > run.seq && e.seq < claim.seq && isEngineerClaim(e) && e.payload.claimerId === claimerId)) {
    return { offered: false, reason: 'already-offered' };
  }

  const grace = deps.midFlightGrace ?? DEFAULT_MID_FLIGHT_GRACE;
  const now = deps.clock().getTime();
  const branch = runBranch(log, run);
  const issueKey = (await deps.state.getIncident(incidentId))?.jiraKey;
  const card: MidFlightCard = {
    kind: 'mid-flight',
    ...(issueKey === undefined ? {} : { issueKey }),
    claimerUserId: claimerId,
    runId: run.payload.runId,
    runAgeMs: Math.max(0, now - Date.parse(run.occurredAt)),
    ...(branch === undefined ? {} : { branch }),
    choices: ['let-it-finish', 'stop-it'],
    grace,
  };
  const data: MidFlightTimerData = { incidentId, runId: run.payload.runId, claimerId };
  await deps.workflow.schedule('timer.mid-flight', data, new Date(now + parseDuration(grace)), {
    singletonKey: midFlightKey(incidentId, run.payload.runId, claimerId),
  });
  await deps.ports.postCard(incidentId, card);
  return { offered: true, card };
}

export interface MidFlightAnswerInput {
  incidentId: string;
  runId: string;
  /** The claimer the card addressed, who is assigned on a stop. */
  claimerId: string;
  choice: MidFlightChoice;
  /** Whoever tapped; must be an engineer. */
  actor: EventActor;
}

/** A tap on the card. The run on the card must still be the running one. */
export async function answerMidFlight(deps: MidFlightDeps, input: MidFlightAnswerInput): Promise<MidFlightAnswer> {
  const { incidentId, runId, claimerId, choice, actor } = input;
  if (actor.role !== 'engineer') return { accepted: false, reason: 'engineer-required' };
  const run = activeRun(await deps.state.read(incidentId));
  if (run === undefined) return { accepted: false, reason: 'run-finished' };
  if (run.payload.runId !== runId) return { accepted: false, reason: 'wrong-run' };

  await deps.workflow.cancel(midFlightKey(incidentId, runId, claimerId));
  if (choice === 'let-it-finish') return { accepted: true, choice };

  // The branch is left as the run pushed it; stopIncident cancels the run and closes only an open PR.
  const stop = await stopIncident(deps, { incidentId, actor, source: 'agent', reason: `${claimerId} took over` });
  if (stop.stopped || stop.reason === 'already-stopped') await deps.ports.assign(incidentId, claimerId);
  return { accepted: true, choice, stop };
}

/** The `timer.mid-flight` handler: no answer in the grace means `Let it finish`, when the run still goes. */
export async function midFlightGraceExpired(deps: MidFlightDeps, data: MidFlightTimerData): Promise<'applied' | 'run-finished'> {
  const run = activeRun(await deps.state.read(data.incidentId));
  if (run === undefined || run.payload.runId !== data.runId) return 'run-finished';
  const grace = deps.midFlightGrace ?? DEFAULT_MID_FLIGHT_GRACE;
  await deps.ports.notify(
    data.incidentId,
    `No answer in ${minutes(parseDuration(grace))}, so the fixer keeps going. It reports on the ticket when it is done.`,
  );
  return 'applied';
}

/** The branch the run's latest `branched` checkpoint named. */
function runBranch(log: readonly IncidentEvent[], run: IncidentEvent<'fixer-started'>): string | undefined {
  const after = log.filter((e): e is IncidentEvent<'fixer-checkpoint'> => e.seq > run.seq && e.type === 'fixer-checkpoint' && e.payload.phase === 'branched');
  const detail = latest(after, 'fixer-checkpoint')?.payload.detail.trim();
  return detail === undefined || detail === '' ? undefined : detail;
}

function minutes(ms: number): string {
  const n = Math.max(1, Math.round(ms / 60_000));
  return n === 1 ? '1 minute' : `${String(n)} minutes`;
}

/** The card text of A 2.2, for adapters that render plain text; `label` is how the claimer is mentioned. */
export function midFlightText(card: MidFlightCard, label: string): string {
  const ago = card.runAgeMs < 60_000 ? 'under a minute' : minutes(card.runAgeMs);
  const where = card.branch === undefined ? '' : ` and is on \`${card.branch}\``;
  return `${label}, the fixer started on this ${ago} ago${where}.`;
}
