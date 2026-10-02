// src/merge/revert.ts: Revert after an autopilot merge (main 11.3, B 5 revert window).
//
// The Revert button stays on the status message for `AppConfig.merge.revertWindow` (default PT72H)
// after an autopilot merge (`merged` with `levelAtMergeTime` 3). `revert` opens a revert PR through
// `MergeGitHub.openRevertPullRequest`, then appends `reverted { prNumber, revertPrNumber }` with the
// person who tapped it and `level-changed` to 2 ("reopens the ticket at level 2"), and cancels the
// window timer. The caller authorizes the tap first (`authorize('revert', ...)`, policy/authorize.ts).
//
// The window is the merge time plus the configured window, the same instant `timer.revert` was
// scheduled for, so once the timer has fired a revert is refused (`window-closed`). The timer handler
// appends nothing: it calls `onRevertWindowClosed` so the status message can drop the button.
// Refused, with nothing opened: no merge, a merge a human made (no window), a merge already
// reverted, or the window closed.

import type { AutonomyLevel, EventActor, EventSource, IncidentEvent } from '../contracts/events.ts';
import { appendDecided, currentLevel, latest, newEvent } from '../fixer/job.ts';
import { parseDuration } from '../util/duration.ts';
import { isMergeEvaluateData, revertTimerKey, type MergeDeps } from './job.ts';

/** Prefix of the `level-changed` reason that records a revert. */
export const REVERTED_REASON_PREFIX = 'reverted:';
/** The level a reverted incident reopens at (main 11.3). */
export const REVERTED_LEVEL: AutonomyLevel = 2;

export interface RevertOptions {
  /** Where the tap came from. Default `agent`. */
  source?: EventSource;
  reason?: string;
}

export type RevertRefusal = 'not-merged' | 'not-autopilot' | 'already-reverted' | 'window-closed' | 'no-repo';

export type RevertOutcome =
  | { reverted: true; prNumber: number; revertPrNumber: number; revertPrUrl: string }
  | { reverted: false; reason: RevertRefusal; revertPrNumber?: number };

/** The Revert button (main 11.3). */
export async function revert(deps: MergeDeps, incidentId: string, actor: EventActor, opts: RevertOptions = {}): Promise<RevertOutcome> {
  const log = await deps.state.read(incidentId);
  const refusal = refuseRevert(deps, log);
  if (refusal !== undefined) return { reverted: false, reason: refusal };
  const merged = latest(log, 'merged');
  if (merged === undefined) return { reverted: false, reason: 'not-merged' };
  const incident = await deps.state.getIncident(incidentId);
  const repo = incident?.repo;
  if (repo === undefined || repo === '') return { reverted: false, reason: 'no-repo' };

  const prNumber = merged.payload.prNumber;
  const ticket = incident?.jiraKey === undefined ? '' : ` for ${incident.jiraKey}`;
  const why = opts.reason === undefined || opts.reason.trim() === '' ? '' : ` Reason: ${opts.reason.trim()}`;
  const pr = await deps.github(repo).openRevertPullRequest(prNumber, {
    title: `Revert #${String(prNumber)}${ticket}`,
    body: `Reverts #${String(prNumber)}, merged automatically by Snapwing. Revert requested by ${actor.id}.${why}`,
  });

  let refused: RevertRefusal = 'already-reverted';
  const appended = await appendDecided(deps.state, incidentId, (events) => {
    const again = refuseRevert(deps, events);
    if (again !== undefined) {
      refused = again;
      return undefined;
    }
    const from = currentLevel(events) ?? 3;
    const source = opts.source ?? 'agent';
    return [
      newEvent(deps, incidentId, 'reverted', { prNumber, revertPrNumber: pr.number, ...(opts.reason === undefined ? {} : { reason: opts.reason }) }, { actor, source }),
      newEvent(deps, incidentId, 'level-changed', { from, to: REVERTED_LEVEL, reason: `${REVERTED_REASON_PREFIX} PR #${String(prNumber)} reverted by ${actor.id}` }, { actor, source }),
    ];
  });
  // A concurrent revert won the append; the PR opened here is left for a human to close.
  if (!appended.appended) return { reverted: false, reason: refused, revertPrNumber: pr.number };
  await deps.workflow.cancel(revertTimerKey(incidentId));
  return { reverted: true, prNumber, revertPrNumber: pr.number, revertPrUrl: pr.url };
}

/** When the revert window of the incident's autopilot merge closes, or undefined when it has none. */
export function revertDeadline(deps: Pick<MergeDeps, 'merge'>, events: readonly IncidentEvent[]): Date | undefined {
  const merged = latest(events, 'merged');
  if (merged === undefined || merged.payload.levelAtMergeTime !== 3) return undefined;
  return new Date(Date.parse(merged.occurredAt) + parseDuration(deps.merge.revertWindow));
}

export type RevertWindowOutcome = 'closed' | 'reverted' | 'not-merged';

/** The `timer.revert` handler: the window is over; tell the status message to drop Revert. */
export async function revertWindowClosed(deps: MergeDeps, incidentId: string): Promise<RevertWindowOutcome> {
  const log = await deps.state.read(incidentId);
  const merged = latest(log, 'merged');
  if (merged === undefined) return 'not-merged';
  if (revertedSince(log, merged)) return 'reverted';
  await deps.onRevertWindowClosed?.(incidentId);
  return 'closed';
}

/** Registers the `timer.revert` handler. */
export function registerRevertTimer(deps: MergeDeps): void {
  deps.workflow.work('timer.revert', async (job) => {
    if (!isMergeEvaluateData(job.data)) throw new Error('timer.revert: malformed job data');
    await revertWindowClosed(deps, job.data.incidentId);
  });
}

function refuseRevert(deps: MergeDeps, events: readonly IncidentEvent[]): RevertRefusal | undefined {
  const merged = latest(events, 'merged');
  if (merged === undefined) return 'not-merged';
  if (revertedSince(events, merged)) return 'already-reverted';
  const deadline = revertDeadline(deps, events);
  if (deadline === undefined) return 'not-autopilot';
  return deps.clock().getTime() < deadline.getTime() ? undefined : 'window-closed';
}

function revertedSince(events: readonly IncidentEvent[], merged: IncidentEvent<'merged'>): boolean {
  return events.some((e) => e.seq > merged.seq && e.type === 'reverted');
}
